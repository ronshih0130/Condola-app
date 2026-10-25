import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type APIResponse, type Page } from "@playwright/test";
import { Client } from "pg";
import { ACCOUNTS, resetDemo, signIn } from "./session";

const DATABASE_URL = process.env.DATABASE_URL || "postgres://condola:condola@127.0.0.1:5432/condola";

async function teamInviteCount(email: string) {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const all = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM invitations WHERE kind = 'team_member'`);
    const targeted = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM invitations WHERE kind = 'team_member' AND lower(email::text) = lower($1)`,
      [email],
    );
    return { all: Number(all.rows[0].n), targeted: Number(targeted.rows[0].n) };
  } finally {
    await client.end();
  }
}

test("team member invites show 即將開放 and create no invitation", async ({ page }) => {
  const email = `blocked-${Date.now()}@example.com`;
  await resetDemo(page);
  const before = await teamInviteCount(email);

  await page.goto("/api/demo/locale?set=zh-TW&next=/m/team");
  const button = page.getByTestId("team-invite-soon");
  await expect(button).toBeVisible();
  await expect(button).toBeDisabled();
  await expect(button).toHaveText("即將開放");
  await expect(page.getByTestId("invite-email")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "送出邀請" })).toHaveCount(0);

  const response = await page.request.post("/api/flows/inviteTeammate", {
    data: { email, role: "manager", name: "新人" },
  });
  expect(response.status()).toBe(400);
  expect(await response.json()).toEqual({ ok: false, error: "errors.teamInvitesSoon" });

  await page.goto("/api/demo/locale?set=en&next=/m/team");
  await expect(page.getByTestId("team-invite-soon")).toHaveText("Coming soon");

  const after = await teamInviteCount(email);
  expect(after).toEqual(before);
  expect(after.targeted).toBe(0);
});

const ORG_ID = "10000000-0000-4000-8000-000000000001";
const ADMIN_ID = "20000000-0000-4000-8000-000000000001";

type InviteRow = { status: string; code_hash: string; expires_at: string; accepted_at: string | null };

async function withDb<T>(fn: (client: Client) => Promise<T>) {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function actionId(exportedName: string) {
  const manifest = JSON.parse(readFileSync(".next/server/server-reference-manifest.json", "utf8")) as {
    node?: Record<string, { filename?: string; exportedName?: string }>;
  };
  const found = Object.entries(manifest.node ?? {}).find(
    ([, info]) => info.exportedName === exportedName && (info.filename ?? "").endsWith("auth-actions.ts"),
  );
  if (!found) throw new Error(`missing server action ${exportedName}`);
  return found[0];
}

async function postAction(page: Page, path: string, exportedName: string, fields: Record<string, string>) {
  const id = actionId(exportedName);
  return page.request.post(path, {
    multipart: { ...fields, [`$ACTION_ID_${id}`]: "" },
    headers: { origin: "http://127.0.0.1:43123" },
    maxRedirects: 0,
  });
}

function refusalTarget(response: APIResponse) {
  const headers = response.headers();
  return headers.location || headers["x-action-redirect"] || "";
}

async function insertTeamInvite(email: string) {
  const token = randomBytes(32).toString("base64url");
  const codeHash = createHash("sha256").update(token).digest("hex");
  const row = await withDb(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO invitations (org_id, kind, role, email, code_hash, status, expires_at, invited_by)
       VALUES ($1, 'team_member', 'manager', $2, $3, 'pending', now() + interval '7 days', $4)
       RETURNING id::text`,
      [ORG_ID, email, codeHash, ADMIN_ID],
    );
    return inserted.rows[0].id;
  });
  return { token, id: row };
}

async function inviteRow(id: string) {
  return withDb(async (client) => {
    const row = await client.query<InviteRow>(
      `SELECT status::text, code_hash, expires_at::text, accepted_at::text FROM invitations WHERE id = $1`,
      [id],
    );
    return row.rows[0];
  });
}

async function accountCount(email: string) {
  return withDb(async (client) => {
    const users = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM auth.users WHERE lower(email::text) = lower($1)`,
      [email],
    );
    const members = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM org_members m
         JOIN auth.users u ON u.id = m.user_id
        WHERE lower(u.email::text) = lower($1)`,
      [email],
    );
    return { users: Number(users.rows[0].n), members: Number(members.rows[0].n) };
  });
}

test("a team member invite shows 即將開放, refuses accept and resend, and creates no account", async ({ page }) => {
  const email = `pending-${Date.now()}@example.com`;
  await resetDemo(page);
  const invite = await insertTeamInvite(email);
  const beforeRow = await inviteRow(invite.id);
  const beforeAccount = await accountCount(email);
  expect(beforeRow.status).toBe("pending");
  expect(beforeAccount).toEqual({ users: 0, members: 0 });

  await page.goto(`/api/demo/locale?set=zh-TW&next=${encodeURIComponent(`/accept/${invite.token}`)}`);
  const soon = page.getByTestId("team-accept-soon");
  await expect(soon).toBeVisible();
  await expect(soon).toBeDisabled();
  await expect(soon).toHaveText("即將開放");
  await expect(page.getByTestId("accept-name")).toHaveCount(0);
  await expect(page.getByTestId("new-password")).toHaveCount(0);
  await expect(page.getByTestId("accept-submit")).toHaveCount(0);

  const accepted = await postAction(page, `/accept/${invite.token}`, "actionAccept", {
    token: invite.token,
    name: "新人",
    password: "Fresh1234",
    confirm: "Fresh1234",
  });
  expect(refusalTarget(accepted)).toContain("error=errors.teamInvitesSoon");
  expect(await inviteRow(invite.id)).toEqual(beforeRow);
  expect(await accountCount(email)).toEqual({ users: 0, members: 0 });

  await page.goto(`/api/demo/locale?set=en&next=${encodeURIComponent(`/accept/${invite.token}`)}`);
  await expect(page.getByTestId("team-accept-soon")).toHaveText("Coming soon");

  await signIn(page, ACCOUNTS.admin);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/team");
  const resend = page.getByTestId(`resend-${email}`);
  await expect(resend).toBeVisible();
  await expect(resend).toBeDisabled();
  await expect(resend).toHaveText("重寄邀請");

  const resent = await postAction(page, "/m/team", "actionResendInvite", { invitationId: invite.id });
  expect(refusalTarget(resent)).toContain("error=errors.teamInvitesSoon");
  expect(await inviteRow(invite.id)).toEqual(beforeRow);
  expect(await accountCount(email)).toEqual({ users: 0, members: 0 });
});

test("an owner invitation can still be accepted", async ({ page, browser }) => {
  const email = `owner.keep.${Date.now()}@example.com`;
  await resetDemo(page);
  const token = randomBytes(32).toString("base64url");
  const codeHash = createHash("sha256").update(token).digest("hex");
  await withDb(async (client) => {
    const contact = await client.query<{ id: string }>(
      `INSERT INTO contacts (org_id, is_owner, display_name, email, locale)
       VALUES ($1, true, '保留屋主', $2, 'zh-TW')
       RETURNING id::text`,
      [ORG_ID, email],
    );
    await client.query(
      `INSERT INTO invitations (org_id, kind, contact_id, email, code_hash, status, expires_at, invited_by)
       VALUES ($1, 'owner', $2, $3, $4, 'pending', now() + interval '7 days', $5)`,
      [ORG_ID, contact.rows[0].id, email, codeHash, ADMIN_ID],
    );
  });

  const guest = await browser.newContext();
  const guestPage = await guest.newPage();
  await guestPage.goto(`/accept/${token}`);
  await expect(guestPage.getByTestId("team-accept-soon")).toHaveCount(0);
  await expect(guestPage.getByTestId("portal-email")).toHaveValue(email);
  await expect(guestPage.getByTestId("portal-password-title")).toHaveText("請設定或輸入密碼");
  await guestPage.getByTestId("new-password").fill("Owner1234");
  await guestPage.getByTestId("portal-submit").click();
  await guestPage.waitForURL(/\/o\/statements\/?$/);
  await guest.close();
  const bound = await withDb(async (client) => {
    const row = await client.query<{ users: string; linked: string }>(
      `SELECT count(u.id)::text AS users,
              count(c.user_id)::text AS linked
         FROM contacts c
         LEFT JOIN auth.users u ON lower(u.email::text) = lower(c.email::text)
        WHERE lower(c.email::text) = lower($1)`,
      [email],
    );
    return { users: Number(row.rows[0].users), linked: Number(row.rows[0].linked) };
  });
  expect(bound).toEqual({ users: 1, linked: 1 });
});

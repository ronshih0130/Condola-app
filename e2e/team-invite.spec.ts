import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type APIResponse, type Page } from "@playwright/test";
import { Client } from "pg";
import { TEAM_INVITES_ENABLED } from "../src/server/team-invites";
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

  await page.goto(`/api/demo/locale?set=zh-TW&next=${encodeURIComponent(`/join#t=${invite.token}`)}`);
  await expect(page.getByTestId("invite-state")).toHaveText("此邀請無法使用，請向管理員索取新連結。");
  await expect(page).toHaveURL(/\/join$/);
  await expect(page.getByTestId("accept-name")).toHaveCount(0);
  await expect(page.getByTestId("new-password")).toHaveCount(0);
  await expect(page.getByTestId("accept-submit")).toHaveCount(0);

  // /join has no HTML action carrying a token in the URL. Its client action
  // refuses this non-allowlisted invitation before rendering an acceptance form.
  await expect(page.getByTestId("team-join-form")).toHaveCount(0);
  expect(await inviteRow(invite.id)).toEqual(beforeRow);
  expect(await accountCount(email)).toEqual({ users: 0, members: 0 });

  await page.goto(`/api/demo/locale?set=en&next=${encodeURIComponent(`/join#t=${invite.token}`)}`);
  await expect(page.getByTestId("invite-state")).toHaveText("This invitation is unavailable. Ask your admin for a new link.");

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

for (const kind of ["owner", "tenant"] as const) {
test(`a ${kind} invitation can still be accepted`, async ({ page, browser }) => {
  const email = `${kind}.keep.${Date.now()}@example.com`;
  await resetDemo(page);
  const token = randomBytes(32).toString("base64url");
  const codeHash = createHash("sha256").update(token).digest("hex");
  await withDb(async (client) => {
    const contact = await client.query<{ id: string }>(
      `INSERT INTO contacts (org_id, is_owner, is_tenant, display_name, email, locale)
       VALUES ($1, $3, $4, '保留聯絡人', $2, 'zh-TW')
       RETURNING id::text`,
      [ORG_ID, email, kind === "owner", kind === "tenant"],
    );
    await client.query(
      `INSERT INTO invitations (org_id, kind, contact_id, email, code_hash, status, expires_at, invited_by)
       VALUES ($1, $6::invitation_kind, $2, $3, $4, 'pending', now() + interval '7 days', $5)`,
      [ORG_ID, contact.rows[0].id, email, codeHash, ADMIN_ID, kind],
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
  await guestPage.waitForURL(kind === "tenant" ? /\/t\/?$/ : /\/o\/statements\/?$/);
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
}

test("invitee can log in after accepting", async ({ page, browser }) => {
  await resetDemo(page);
  const email = `login.invitee.${Date.now()}@example.com`;
  const invite = await insertTeamInvite(email);
  const guest = await browser.newContext();
  try {
    const invitee = await guest.newPage();
    await invitee.goto(`/api/demo/locale?set=zh-TW&next=${encodeURIComponent(`/join#t=${invite.token}`)}`);
    if (!TEAM_INVITES_ENABLED) {
      // This server has no org allowlist. The dedicated link spec exercises
      // successful acceptance on a separately configured local demo server.
      await expect(invitee.getByTestId("invite-state")).toHaveText("此邀請無法使用，請向管理員索取新連結。");
      await expect(invitee.getByTestId("team-join-form")).toHaveCount(0);
      expect((await inviteRow(invite.id)).status).toBe("pending");
      expect(await accountCount(email)).toEqual({ users: 0, members: 0 });
      return;
    }
    await invitee.getByTestId("accept-name").fill("登入新人");
    await invitee.getByTestId("new-password").fill("Fresh1234");
    await invitee.getByTestId("password-confirm").fill("Fresh1234");
    await invitee.getByTestId("invite-consent").check();
    await invitee.getByTestId("accept-submit").click();
    await invitee.waitForURL((url) => url.pathname !== "/join");
    expect((await inviteRow(invite.id)).status).toBe("accepted");
    expect(await accountCount(email)).toEqual({ users: 1, members: 1 });

    await invitee.goto("/m");
    // Use browser navigation: cookie-expiry headers exceed Node's API client limit.
    await invitee.getByTestId("sign-out").click();
    await expect(invitee).toHaveURL(/\/login\/?$/);
    await invitee.goto("/m");
    await expect(invitee).toHaveURL(/\/login(?:[/?]|$)/);
    await invitee.getByTestId("login-email").fill(email);
    await invitee.getByTestId("login-password").fill("Fresh1234");
    await invitee.getByTestId("login-submit").click();
    await expect(invitee).toHaveURL(/\/m\/?$/);
    await expect(invitee.getByTestId("sign-out")).toBeVisible();
  } finally {
    await guest.close();
  }
});

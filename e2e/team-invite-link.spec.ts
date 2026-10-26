import { expect, test, type Page } from "@playwright/test";
import { Client } from "pg";
import { ACCOUNTS, resetDemo, signIn } from "./session";

const orgId = "10000000-0000-4000-8000-000000000001";

test.skip(!(process.env.TEAM_INVITES_ORG_ALLOWLIST ?? '').split(',').map(s=>s.trim()).includes(orgId), 'requires TEAM_INVITES_ORG_ALLOWLIST to include the demo org');

const databaseUrl = process.env.DATABASE_URL ||
  "postgres://condola:condola@127.0.0.1:5432/condola";
const password = "Fresh1234";

test.use({
  permissions: ["clipboard-read", "clipboard-write"],
  trace: "off",
  video: "off",
  screenshot: "off",
});

async function readInvitationLink(page: Page, previous?: string): Promise<string> {
  let value = "";
  await expect.poll(async () => {
    value = await page.evaluate(() => navigator.clipboard.readText());
    return /^https?:\/\/[^/?#]+\/join#t=[A-Za-z0-9_-]{43}$/.test(value) &&
      value !== previous;
  }).toBe(true);
  return value;
}

async function withDb<T>(run: (client: Client) => Promise<T>) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

test("admin hands over a masked fragment link; join is private, account-bound and single use", async ({ page, browser }) => {
  const target = `team-link-${Date.now()}@example.com`;
  const guests: Awaited<ReturnType<typeof browser.newContext>>[] = [];
  try {
    await resetDemo(page);
    await withDb(async (client) => {
      await client.query(
        `UPDATE organizations SET environment = 'live', plan_tier = 'free',
          settings = jsonb_set(coalesce(settings,'{}'::jsonb), '{plan}', '{"tier":"standard"}'::jsonb, true)
          WHERE id = $1`, [orgId],
      );
      await client.query(
        `DELETE FROM invitations WHERE org_id = $1 AND kind = 'team_member'`, [orgId],
      );
    });
    await page.goto("/api/demo/locale?set=en&next=/m/team");
    const origin = new URL(page.url()).origin;
    await page.getByTestId("invite-email").fill(target);
    await page.getByTestId("invite-name").fill("Link invitee");
    await page.getByTestId("invite-role").selectOption("accountant");
    const form = page.locator("form").filter({ has: page.getByTestId("invite-email") });
    await form.locator('button[type="submit"]').click();

    const display = page.getByRole("textbox", { name: "Copy invitation link" });
    await expect(display).toHaveValue("…/join#••••");
    await page.getByRole("button", { name: "Copy invitation link", exact: true }).click();
    const firstLink = await readInvitationLink(page);
    const first = new URL(firstLink);
    expect(first.origin).toBe(origin);
    expect(first.pathname).toBe("/join");
    expect(first.search).toBe("");
    expect(first.hash).toMatch(/^#t=[A-Za-z0-9_-]{43}$/);
    await expect(display).toHaveValue("…/join#••••");
    await page.getByRole("button", { name: "Reveal link", exact: true }).click();
    await expect(display).toHaveValue(firstLink);

    const guest = await browser.newContext({ baseURL: origin });
    guests.push(guest);
    const invitee = await guest.newPage();
    const thirdParty: string[] = [];
    const leakedTokens: string[] = [];
    const token = first.hash.slice(3);
    invitee.on("request", (request) => {
      const url = new URL(request.url());
      if (url.protocol === "http:" || url.protocol === "https:") {
        if (url.origin !== origin) thirdParty.push(url.origin);
        if (url.pathname.includes(token) || url.search.includes(token)) leakedTokens.push("request URL");
      }
    });
    await invitee.goto("about:blank");
    const response = await invitee.goto(firstLink);
    expect(response?.headers()["referrer-policy"]).toBe("no-referrer");
    await expect(invitee.getByTestId("team-join-form")).toBeVisible();
    await expect(invitee).toHaveURL(`${origin}/join`);
    expect(thirdParty).toEqual([]);
    expect(leakedTokens).toEqual([]);

    // An existing signed-in staff account is different from the invited email.
    await page.goto("about:blank");
    await page.goto(firstLink);
    await expect(page.getByTestId("team-account-mismatch")).toBeVisible();
    await expect(page.getByTestId("team-join-form")).toHaveCount(0);
    await expect(page).toHaveURL(`${origin}/join`);

    // Rotate through the admin's existing pending invitation row.
    await page.goto("/api/demo/locale?set=en&next=/m/team");
    const row = page.locator("tr").filter({ hasText: target });
    await row.getByRole("button", { name: "Copy invitation link", exact: true }).click();
    const rotatedDisplay = row.getByRole("textbox", { name: "Copy invitation link" });
    await expect(rotatedDisplay).toHaveValue("…/join#••••");
    const replacementLink = await readInvitationLink(page, firstLink);
    expect(replacementLink).not.toBe(firstLink);
    const replacement = new URL(replacementLink);
    expect(replacement.pathname).toBe("/join");
    expect(replacement.search).toBe("");
    expect(replacement.hash).toMatch(/^#t=[A-Za-z0-9_-]{43}$/);

    await invitee.goto("about:blank");
    await invitee.goto(firstLink);
    await expect(invitee.getByTestId("invite-state")).toBeVisible();
    await expect(invitee.getByTestId("team-join-form")).toHaveCount(0);

    await invitee.goto("about:blank");
    await invitee.goto(replacementLink);
    await expect(invitee.getByTestId("team-join-form")).toBeVisible();
    await expect(invitee).toHaveURL(`${origin}/join`);

    // A same-document navigation to the rotated-out token must replace the form.
    await invitee.evaluate((hash) => { window.location.hash = hash; }, first.hash);
    await expect(invitee.getByTestId("invite-state")).toBeVisible();
    await expect(invitee.getByTestId("team-join-form")).toHaveCount(0);
    await expect(invitee).toHaveURL(`${origin}/join`);

    await invitee.goto("about:blank");
    await invitee.goto(replacementLink);
    await expect(invitee.getByTestId("team-join-form")).toBeVisible();
    await expect(invitee).toHaveURL(`${origin}/join`);
    await invitee.getByTestId("accept-name").fill("Link invitee");
    await invitee.getByTestId("new-password").fill(password);
    await invitee.getByTestId("password-confirm").fill(password);
    await invitee.getByTestId("invite-consent").check();
    await invitee.getByTestId("accept-submit").click();
    await invitee.waitForURL((url) =>
      url.pathname !== "/join" && !url.pathname.startsWith("/auth/"));
    const landed = new URL(invitee.url());
    expect(landed.hash).toBe("");
    expect(landed.search).not.toContain(replacement.hash.slice(3));
    expect(landed.pathname).not.toContain(replacement.hash.slice(3));

    const membership = await withDb(async (client) => {
      const result = await client.query<{ role: string }>(
        `SELECT m.role::text FROM org_members m
           JOIN auth.users u ON u.id = m.user_id
          WHERE m.org_id = $1 AND lower(u.email::text) = lower($2)`,
        [orgId, target],
      );
      return result.rows;
    });
    expect(membership).toEqual([{ role: "accountant" }]);

    const reuse = await browser.newContext({ baseURL: origin });
    guests.push(reuse);
    const reusePage = await reuse.newPage();
    await reusePage.goto("about:blank");
    await reusePage.goto(`/api/demo/locale?set=en&next=${encodeURIComponent(`/join${replacement.hash}`)}`);
    await expect(reusePage.getByTestId("invite-state")).toHaveText(
      "This invitation is unavailable. Ask your admin for a new link.",
    );
    await expect(reusePage.getByTestId("team-join-form")).toHaveCount(0);
    await expect(reusePage).toHaveURL(`${origin}/join`);
  } finally {
    await Promise.all(guests.map((context) => context.close()));
    await resetDemo(page);
    await signIn(page, ACCOUNTS.admin);
  }
});

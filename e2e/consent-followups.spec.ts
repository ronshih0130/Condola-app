import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { Client } from "pg";
import { expect, test } from "@playwright/test";
import { PRIVACY_VERSION, TERMS_VERSION } from "../src/server/legal-versions";

const DATABASE_URL = process.env.DATABASE_URL || "postgres://condola:condola@127.0.0.1:5432/condola";
const EVIDENCE = "e2e-evidence/consent-followups";
const SERVICE = "我已閱讀並同意《服務條款》與《隱私權政策》";
const PORTAL = "我已閱讀並同意《使用條款》與《隱私權政策》";
const PASSWORD = "Fresh1234";

const userMetaOnly = {
  terms_accepted_at: "2026-10-22T00:00:00.000Z",
  terms_version: TERMS_VERSION,
  privacy_version: PRIVACY_VERSION,
  name: "keep-me",
};

const staleApp = {
  provider: "email",
  consent: {
    accepted_at: "2020-01-01T00:00:00.000Z",
    terms_version: "2020-01-01",
    privacy_version: "2020-01-01",
    source: "signup",
  },
};

function db() {
  return new Client({ connectionString: DATABASE_URL });
}

async function withDb<T>(run: (client: Client) => Promise<T>) {
  const client = db();
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

async function songxinOrg(client: Client) {
  const org = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM organizations WHERE name = '松信住宅管理' AND environment = 'live' LIMIT 1`,
  );
  const admin = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM auth.users WHERE lower(email) = lower('yating.lin@songxin.demo') LIMIT 1`,
  );
  if (!org.rows[0] || !admin.rows[0]) throw new Error("demo org is not seeded");
  return { orgId: org.rows[0].id, adminId: admin.rows[0].id };
}

async function insertUser(
  client: Client,
  email: string,
  meta: unknown,
  app: unknown,
) {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data, raw_app_meta_data, role, aud)
     VALUES (gen_random_uuid(), $1, crypt($2, gen_salt('bf')), now(), $3::jsonb, $4::jsonb, 'authenticated', 'authenticated')
     RETURNING id::text AS id`,
    [email, PASSWORD, JSON.stringify(meta), JSON.stringify(app)],
  );
  const userId = inserted.rows[0].id;
  await client.query(`INSERT INTO profiles (id, display_name, email, locale) VALUES ($1, $2, $3, 'zh-TW')`, [
    userId,
    "Consent Followup",
    email,
  ]);
  return userId;
}

async function sessionCookie(client: Client, userId: string) {
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  await client.query(`INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
    userId,
    hash,
  ]);
  return token;
}

async function consentOf(email: string) {
  return withDb(async (client) => {
    const row = await client.query<{ consent: { source?: string; terms_version?: string; privacy_version?: string }; user_meta: { name?: string; terms_version?: string } }>(
      `SELECT raw_app_meta_data->'consent' AS consent, raw_user_meta_data AS user_meta
         FROM auth.users WHERE lower(email) = lower($1)`,
      [email],
    );
    return row.rows[0];
  });
}

async function removeUser(email: string) {
  await withDb(async (client) => {
    const found = await client.query<{ id: string }>(`SELECT id::text AS id FROM auth.users WHERE lower(email) = lower($1)`, [email]);
    const userId = found.rows[0]?.id;
    if (!userId) return;
    await client.query(`DELETE FROM invitations WHERE lower(email) = lower($1) OR accepted_by = $2`, [email, userId]);
    await client.query(`DELETE FROM contacts WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM org_members WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM auth_sessions WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM profiles WHERE id = $1`, [userId]);
    await client.query(`DELETE FROM funnel_events WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM auth.users WHERE id = $1`, [userId]);
  }).catch(() => undefined);
}

test.beforeAll(() => {
  mkdirSync(EVIDENCE, { recursive: true });
});

test("a signed-in user with only user_metadata consent must tick before creating a company", async ({ page }) => {
  const email = `reconsent.firm.${Date.now().toString(36)}@example.com`;
  try {
    const token = await withDb(async (client) => {
      const userId = await insertUser(client, email, userMetaOnly, { provider: "email" });
      return sessionCookie(client, userId);
    });
    await page.context().addCookies([
      { name: "condola_session", value: token, url: "http://127.0.0.1:43123", httpOnly: true, sameSite: "Lax" },
    ]);
    await page.goto("/signup/firm");
    await expect(page.getByTestId("consent-label")).toHaveText(SERVICE);
    await expect(page.getByTestId("consent-terms")).toHaveAttribute("href", "/terms");
    await expect(page.getByTestId("consent-terms")).toHaveAttribute("target", "_blank");
    await expect(page.getByTestId("consent-privacy")).toHaveAttribute("href", "/privacy");
    await expect(page.getByTestId("consent-privacy")).toHaveAttribute("target", "_blank");
    const submit = page.getByTestId("consent-submit");
    await expect(submit).toBeDisabled();
    await page.screenshot({ path: `${EVIDENCE}/reconsent-firm.png`, fullPage: true });
    await submit.click({ force: true });
    await expect(page.getByTestId("consent-gate")).toBeVisible();
    await expect(page.getByTestId("firm-form")).toHaveCount(0);

    await page.getByTestId("consent-check").check();
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.getByTestId("firm-form")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("你的身分");
    const stored = await consentOf(email);
    expect(stored?.consent?.source).toBe("reconsent");
    expect(stored?.consent?.terms_version).toBe(TERMS_VERSION);
    expect(stored?.consent?.privacy_version).toBe(PRIVACY_VERSION);
    expect(stored?.user_meta?.name).toBe("keep-me");
    expect(stored?.user_meta?.terms_version).toBe(TERMS_VERSION);
  } finally {
    await removeUser(email);
  }
});

test("the first login sends a stale app_metadata consent through the re-consent gate", async ({ page }) => {
  const email = `reconsent.login.${Date.now().toString(36)}@example.com`;
  try {
    await withDb(async (client) => {
      const { orgId } = await songxinOrg(client);
      const userId = await insertUser(client, email, userMetaOnly, staleApp);
      await client.query(
        `INSERT INTO org_members (org_id, user_id, role, status) VALUES ($1, $2, 'manager', 'active')`,
        [orgId, userId],
      );
    });
    await page.goto("/login");
    await page.getByTestId("login-email").fill(email);
    await page.getByTestId("login-password").fill(PASSWORD);
    await page.getByTestId("login-submit").click();
    await page.waitForURL((url) => url.pathname.startsWith("/consent"));
    await expect(page).not.toHaveURL(/\/m/);
    await expect(page.getByTestId("consent-label")).toHaveText(SERVICE);
    const submit = page.getByTestId("consent-submit");
    await expect(submit).toBeDisabled();
    await page.screenshot({ path: `${EVIDENCE}/reconsent-login.png`, fullPage: true });
    await submit.click({ force: true });
    await expect(page).toHaveURL(/\/consent/);
    await page.getByTestId("consent-check").check();
    await submit.click();
    await page.waitForURL((url) => !url.pathname.startsWith("/consent") && !url.pathname.startsWith("/login"));
    const stored = await consentOf(email);
    expect(stored?.consent?.source).toBe("reconsent");
    expect(stored?.consent?.terms_version).toBe(TERMS_VERSION);
    expect(stored?.consent?.privacy_version).toBe(PRIVACY_VERSION);
  } finally {
    await removeUser(email);
  }
});

test("a team invite requires the signup checkbox and records source invite", async ({ page }) => {
  const email = `invite.consent.${Date.now().toString(36)}@example.com`;
  const token = randomBytes(24).toString("base64url");
  try {
    await withDb(async (client) => {
      const { orgId, adminId } = await songxinOrg(client);
      const hash = createHash("sha256").update(token).digest("hex");
      await client.query(
        `INSERT INTO invitations (org_id, kind, role, email, code_hash, expires_at, invited_by)
         VALUES ($1, 'team_member', 'accountant', $2, $3, now() + interval '7 days', $4)`,
        [orgId, email, hash, adminId],
      );
    });
    await page.goto(`/accept/${token}`);
    await expect(page.getByTestId("invite-consent-label")).toHaveText(SERVICE);
    await expect(page.getByTestId("invite-terms")).toHaveAttribute("href", "/terms");
    await expect(page.getByTestId("invite-terms")).toHaveAttribute("target", "_blank");
    await expect(page.getByTestId("invite-privacy")).toHaveAttribute("href", "/privacy");
    await expect(page.getByTestId("invite-privacy")).toHaveAttribute("target", "_blank");
    await expect(page.getByTestId("password-confirm")).toBeVisible();
    const submit = page.getByTestId("accept-submit");
    await expect(submit).toBeDisabled();
    await page.screenshot({ path: `${EVIDENCE}/invite-consent.png`, fullPage: true });
    await page.getByTestId("accept-name").fill("新同事");
    await page.getByTestId("new-password").fill(PASSWORD);
    await page.getByTestId("password-confirm").fill(PASSWORD);
    await submit.click({ force: true });
    await expect(page).toHaveURL(new RegExp(`/accept/${token}`));
    const pending = await withDb(async (client) => {
      const row = await client.query<{ status: string }>(
        `SELECT status::text AS status FROM invitations WHERE lower(email) = lower($1)`,
        [email],
      );
      return row.rows[0]?.status;
    });
    expect(pending).toBe("pending");

    await page.getByTestId("invite-consent").check();
    await expect(submit).toBeEnabled();
    await submit.click();
    await page.waitForURL((url) => !url.pathname.startsWith("/accept"));
    const stored = await consentOf(email);
    expect(stored?.consent?.source).toBe("invite");
    expect(stored?.consent?.terms_version).toBe(TERMS_VERSION);
    expect(stored?.consent?.privacy_version).toBe(PRIVACY_VERSION);
    const captured = await page.request.get("http://127.0.0.1:4599/e2e/admin-users");
    expect(captured.ok()).toBeTruthy();
    const updates = (await captured.json()) as { body?: { password?: string; app_metadata?: { consent?: { source?: string } } } }[];
    const inviteWrite = updates.find((row) => row.body?.app_metadata?.consent?.source === "invite");
    expect(inviteWrite).toBeTruthy();
    expect(JSON.stringify(inviteWrite)).not.toContain(PASSWORD);
  } finally {
    await removeUser(email);
  }
});

test("an owner sees the portal checkbox on first entry", async ({ page }) => {
  const email = `portal.consent.${Date.now().toString(36)}@example.com`;
  try {
    const token = await withDb(async (client) => {
      const { orgId } = await songxinOrg(client);
      const userId = await insertUser(client, email, {}, { provider: "email" });
      await client.query(
        `INSERT INTO contacts (org_id, user_id, is_owner, display_name, email, locale)
         VALUES ($1, $2, true, '同意屋主', $3, 'zh-TW')`,
        [orgId, userId, email],
      );
      return sessionCookie(client, userId);
    });
    await page.context().addCookies([
      { name: "condola_session", value: token, url: "http://127.0.0.1:43123", httpOnly: true, sameSite: "Lax" },
    ]);
    await page.goto("/o");
    await page.waitForURL((url) => url.pathname.startsWith("/consent/portal"));
    await expect(page.getByTestId("consent-label")).toHaveText(PORTAL);
    await expect(page.getByTestId("consent-terms")).toHaveAttribute("href", "/terms");
    await expect(page.getByTestId("consent-terms")).toHaveAttribute("target", "_blank");
    await expect(page.getByTestId("consent-privacy")).toHaveAttribute("href", "/privacy");
    await expect(page.getByTestId("consent-privacy")).toHaveAttribute("target", "_blank");
    const submit = page.getByTestId("consent-submit");
    await expect(submit).toBeDisabled();
    await page.screenshot({ path: `${EVIDENCE}/portal-consent.png`, fullPage: true });
    await submit.click({ force: true });
    await expect(page).toHaveURL(/\/consent\/portal/);
    await page.getByTestId("consent-check").check();
    await submit.click();
    await page.waitForURL((url) => !url.pathname.startsWith("/consent"));
    const stored = await consentOf(email);
    expect(stored?.consent?.source).toBe("portal");
    expect(stored?.consent?.terms_version).toBe(TERMS_VERSION);
    expect(stored?.consent?.privacy_version).toBe(PRIVACY_VERSION);
  } finally {
    await removeUser(email);
  }
});

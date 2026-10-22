import { createHash } from "node:crypto";
import { Client } from "pg";
import { expect, test, type Page } from "@playwright/test";
import { ACCOUNTS, resetDemo, signIn } from "./session";

test.beforeEach(async ({ context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
});

const INVALID = "這個連結已失效，請向管理公司索取新的連結";

function tokenFrom(url: string) {
  return decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
}

async function insertOwnerWithoutEmail() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL || "postgres://condola:condola@127.0.0.1:5432/condola",
  });
  await client.connect();
  try {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO contacts (org_id, is_owner, display_name, locale)
       SELECT id, true, '無信箱屋主', 'zh-TW' FROM organizations WHERE name = '松信住宅管理'
       RETURNING id::text`,
    );
    return inserted.rows[0].id;
  } finally {
    await client.end();
  }
}

async function expireInvite(url: string) {
  const hash = createHash("sha256").update(tokenFrom(url)).digest("hex");
  const client = new Client({
    connectionString: process.env.DATABASE_URL || "postgres://condola:condola@127.0.0.1:5432/condola",
  });
  await client.connect();
  try {
    const updated = await client.query(`UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE code_hash = $1`, [hash]);
    expect(updated.rowCount).toBe(1);
  } finally {
    await client.end();
  }
}

test("manager copies a tenant invite, the tenant sets a password, and used or expired links fail", async ({ page, browser }) => {
  await resetDemo(page);
  await signIn(page, ACCOUNTS.manager);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/leases");
  await page.goto("/m/leases?q=912111003");
  await expect(page.getByTestId("lease-list")).toContainText("李愛玲");
  await page.getByRole("link", { name: "李愛玲" }).click();
  await expect(page.getByTestId("portal-invite-handoff")).toHaveText("傳給租客");
  await expect(page.getByTestId("portal-invite-copy")).toHaveText("複製邀請連結");
  await expect(page.locator("body")).not.toContainText("即將推出");

  await expect(page.getByTestId("portal-invite-regenerate")).toHaveText("重新產生連結");
  await page.getByTestId("portal-invite-copy").click();
  const copied = page.getByTestId("portal-invite-copied");
  await expect(copied).toHaveText("已複製給 李愛玲（ailing.li@tenant.demo）的邀請連結");
  const firstUrl = await copied.getAttribute("data-url");
  expect(firstUrl).toMatch(/\/accept\//);
  await expireInvite(firstUrl || "");

  const expiredContext = await browser.newContext();
  const expiredPage = await expiredContext.newPage();
  await expiredPage.goto(firstUrl || "/");
  await expect(expiredPage.getByTestId("invite-state")).toHaveText(INVALID);
  await expect(expiredPage.getByTestId("portal-submit")).toHaveCount(0);
  await expect(expiredPage.locator("body")).not.toContainText("LINE");
  await expect(expiredPage.locator("body")).not.toContainText("error");
  await expiredPage.screenshot({ path: "/opt/cursor/artifacts/portal-invite-expired.png", fullPage: true });
  await expiredContext.close();

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("重新產生後，目前的邀請連結會失效");
    await dialog.accept();
  });
  await page.getByTestId("portal-invite-regenerate").click();
  await expect(copied).not.toHaveAttribute("data-url", firstUrl || "");
  const liveUrl = await copied.getAttribute("data-url");
  expect(liveUrl).toMatch(/\/accept\//);
  await page.screenshot({ path: "/opt/cursor/artifacts/portal-invite-copied.png", fullPage: true });

  const guest = await browser.newContext();
  const guestPage = await guest.newPage();
  await guestPage.goto(liveUrl || "/");
  await expect(guestPage.getByTestId("portal-invite-title")).toHaveText("松信住宅管理 邀請你使用租多啦");
  await expect(guestPage.getByTestId("portal-email")).toHaveValue("ailing.li@tenant.demo");
  await expect(guestPage.getByTestId("portal-email")).toHaveAttribute("readonly", "");
  await expect(guestPage.locator("body")).not.toContainText("demo.condola.local");
  await expect(guestPage.locator("body")).not.toContainText("LINE");
  await expect(guestPage.getByTestId("portal-password-title")).toHaveText("請設定或輸入密碼");
  await expect(guestPage.getByTestId("portal-password-help")).toHaveText(
    "第一次使用請設定新密碼；已經有 Condola 帳號，請輸入原本的密碼。",
  );
  await expect(guestPage.getByTestId("portal-forgot")).toHaveText("忘記密碼？");
  await expect(guestPage.getByTestId("portal-forgot")).toHaveAttribute("href", "/forgot");
  await expect(guestPage.getByTestId("password-confirm")).toHaveCount(0);
  await guestPage.screenshot({ path: "/opt/cursor/artifacts/portal-invite-password.png", fullPage: true });
  await guestPage.getByTestId("new-password").fill("Fresh1234");
  await guestPage.getByTestId("portal-submit").click();
  await guestPage.waitForURL(/\/t\/?$/);
  await expect(guestPage.getByTestId("liff-frame")).toBeVisible();
  await guestPage.screenshot({ path: "/opt/cursor/artifacts/portal-invite-tenant-home.png", fullPage: true });
  await guestPage.goto(liveUrl || "/");
  await expect(guestPage.getByTestId("invite-state")).toHaveText(INVALID);
  await expect(guestPage.getByTestId("portal-submit")).toHaveCount(0);
  await guestPage.screenshot({ path: "/opt/cursor/artifacts/portal-invite-used.png", fullPage: true });
  await guest.close();

  await page.reload();
  await expect(page.getByTestId("portal-invite-activated")).toHaveText("已啟用");
  await page.screenshot({ path: "/opt/cursor/artifacts/portal-invite-activated.png", fullPage: true });

  await page.goto("/m/owners");
  await page.locator("[data-testid='owner-row-morgan.lee@owner.demo'] a").click();
  await expect(page.getByTestId("portal-invite-handoff")).toHaveText("傳給屋主");
  await expect(page.getByTestId("portal-invite-copy")).toBeVisible();
  await page.screenshot({ path: "/opt/cursor/artifacts/portal-invite-owner.png", fullPage: true });
  await page.goto("/m/owners");
  await page.locator("[data-testid='owner-row-chen.owner@demo.mail'] a").click();
  await expect(page.getByTestId("portal-invite-activated")).toHaveText("已啟用");

  const ownerId = await insertOwnerWithoutEmail();
  await page.goto(`/m/owners/${ownerId}`);
  await page.getByTestId("portal-invite-copy").click();
  const ownerCopied = page.getByTestId("portal-invite-copied");
  await expect(ownerCopied).toBeVisible();
  const ownerUrl = await ownerCopied.getAttribute("data-url");
  expect(ownerUrl).toMatch(/\/accept\//);
  const ownerGuest = await browser.newContext();
  const ownerPage = await ownerGuest.newPage();
  await ownerPage.goto(ownerUrl || "/");
  const ownerEmail = ownerPage.getByTestId("portal-email");
  await expect(ownerEmail).toHaveValue("");
  await expect(ownerEmail).not.toHaveAttribute("readonly", "");
  await expect(ownerPage.locator("body")).not.toContainText("demo.condola.local");
  await expect(ownerPage.locator("body")).toContainText("請填寫你的 Email。");
  await expect(ownerPage.getByTestId("portal-password-help")).toHaveText(
    "第一次使用請設定新密碼；已經有 Condola 帳號，請輸入原本的密碼。",
  );
  await expect(ownerPage.getByTestId("portal-forgot")).toHaveAttribute("href", "/forgot");
  await ownerPage.screenshot({ path: "/opt/cursor/artifacts/portal-invite-choose-email.png", fullPage: true });
  await ownerEmail.fill("nobody.taken@example.com");
  await ownerPage.getByTestId("new-password").fill("short");
  await ownerPage.getByTestId("portal-submit").click();
  await expect(ownerPage.locator(".alert.bad")).toHaveText("密碼不符合規則。請改成至少 8 個字元，並同時包含英文字母與數字。");
  await ownerPage.getByTestId("portal-email").fill("jianhong.chen@owner.demo");
  await ownerPage.getByTestId("new-password").fill("Owner1234");
  await ownerPage.getByTestId("portal-submit").click();
  await expect(ownerPage.locator(".alert.bad")).toHaveText("密碼不正確。請再試一次。");
  await expect(ownerPage.getByTestId("portal-forgot")).toHaveAttribute("href", "/forgot");
  await expect(ownerPage.locator("body")).not.toContainText("已經用過");
  const freshEmail = `invite.${Date.now().toString(36)}@example.com`;
  await ownerPage.getByTestId("portal-email").fill(freshEmail);
  await ownerPage.getByTestId("new-password").fill("Owner1234");
  await ownerPage.getByTestId("portal-submit").click();
  await ownerPage.waitForURL(/\/o\/statements/);
  await ownerGuest.close();

  await signIn(page, ACCOUNTS.owner);
  await page.goto("/o");
  await expect(page.getByTestId("managed-by")).toHaveText("由 松信住宅管理 管理・使用 租多啦");
  await page.getByTestId("owner-sign-out").click();
  await page.waitForURL(/\/login/);
});

async function insertOwner(name: string, email: string) {
  const client = new Client({
    connectionString: process.env.DATABASE_URL || "postgres://condola:condola@127.0.0.1:5432/condola",
  });
  await client.connect();
  try {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO contacts (org_id, is_owner, display_name, email, locale)
       SELECT id, true, $1, $2, 'zh-TW' FROM organizations WHERE name = '松信住宅管理'
       RETURNING id::text`,
      [name, email],
    );
    return inserted.rows[0].id;
  } finally {
    await client.end();
  }
}

async function insertProperty(name: string, contactId: string) {
  const client = new Client({
    connectionString: process.env.DATABASE_URL || "postgres://condola:condola@127.0.0.1:5432/condola",
  });
  await client.connect();
  try {
    const property = await client.query<{ id: string }>(
      `INSERT INTO properties (org_id, name, country_code, currency, timezone, default_rental_mode)
       SELECT id, $1, 'TW', 'TWD', 'Asia/Taipei', 'whole_unit' FROM organizations WHERE name = '松信住宅管理'
       RETURNING id::text`,
      [name],
    );
    await client.query(
      `INSERT INTO property_owners (org_id, property_id, owner_contact_id, is_primary)
       SELECT org_id, $1, $2, true FROM properties WHERE id = $1`,
      [property.rows[0].id, contactId],
    );
    return property.rows[0].id;
  } finally {
    await client.end();
  }
}

async function inviteStatus(url: string) {
  const hash = createHash("sha256").update(tokenFrom(url)).digest("hex");
  const client = new Client({
    connectionString: process.env.DATABASE_URL || "postgres://condola:condola@127.0.0.1:5432/condola",
  });
  await client.connect();
  try {
    const row = await client.query<{ status: string }>(`SELECT status::text FROM invitations WHERE code_hash = $1`, [hash]);
    return row.rows[0]?.status ?? "";
  } finally {
    await client.end();
  }
}

async function ownedPropertyNames(contactId: string) {
  const client = new Client({
    connectionString: process.env.DATABASE_URL || "postgres://condola:condola@127.0.0.1:5432/condola",
  });
  await client.connect();
  try {
    const row = await client.query<{ name: string }>(
      `SELECT p.name
         FROM properties p
         JOIN property_owners po ON po.property_id = p.id
        WHERE po.owner_contact_id = $1
        ORDER BY p.name`,
      [contactId],
    );
    return row.rows.map((item) => item.name);
  } finally {
    await client.end();
  }
}

async function contactUser(contactId: string) {
  const client = new Client({
    connectionString: process.env.DATABASE_URL || "postgres://condola:condola@127.0.0.1:5432/condola",
  });
  await client.connect();
  try {
    const row = await client.query<{ user_id: string | null; email: string | null }>(
      `SELECT c.user_id::text AS user_id, u.email::text AS email
         FROM contacts c
         LEFT JOIN auth.users u ON u.id = c.user_id
        WHERE c.id = $1`,
      [contactId],
    );
    return row.rows[0];
  } finally {
    await client.end();
  }
}

async function clientGo(page: Page, href: string) {
  await page.evaluate(() => {
    (window as Window & { __stay?: number }).__stay = 1;
  });
  const mode = await page.evaluate((nextHref) => {
    const router = (window as Window & { next?: { router?: { push?: (path: string) => void } } }).next?.router;
    if (!router?.push) return "missing";
    router.push(nextHref);
    return "client";
  }, href);
  expect(mode).toBe("client");
  await page.waitForURL((url) => url.pathname === href);
  expect(await page.evaluate(() => (window as Window & { __stay?: number }).__stay)).toBe(1);
}

test("copying owner B after owner A opens B's email and binds only B", async ({ page, browser }) => {
  await resetDemo(page);
  const emailB = `owner.b.${Date.now().toString(36)}@example.com`;
  const ownerB = await insertOwner("隔離屋主乙", emailB);
  const morganId = await (async () => {
    const client = new Client({
      connectionString: process.env.DATABASE_URL || "postgres://condola:condola@127.0.0.1:5432/condola",
    });
    await client.connect();
    try {
      const row = await client.query<{ id: string }>(
        `SELECT id::text FROM contacts WHERE email = 'morgan.lee@owner.demo' AND org_id = (SELECT id FROM organizations WHERE name = '松信住宅管理')`,
      );
      return row.rows[0].id;
    } finally {
      await client.end();
    }
  })();
  await insertProperty("物件甲", morganId);
  await insertProperty("物件乙", ownerB);
  await page.goto("/m/owners");
  await page.locator("[data-testid='owner-row-morgan.lee@owner.demo'] a").click();
  await expect(page.getByTestId("portal-invite-copy")).toBeVisible();
  await expect(page.getByTestId("portal-invite-copy")).toHaveAttribute("data-page-id", morganId);
  await page.getByTestId("portal-invite-copy").click();
  const copiedA = page.getByTestId("portal-invite-copied");
  await expect(copiedA).toHaveText("已複製給 Morgan Lee（morgan.lee@owner.demo）的邀請連結");
  const urlA = await copiedA.getAttribute("data-url");
  expect(urlA).toMatch(/\/accept\//);
  await page.getByTestId("portal-invite-copy").click();
  expect(await copiedA.getAttribute("data-url")).toBe(urlA);
  await clientGo(page, `/m/owners/${ownerB}`);
  await expect(page.getByTestId("owner-email")).toHaveValue(emailB);
  await expect(page.getByTestId("portal-invite-copy")).toHaveAttribute("data-page-id", ownerB);
  await expect(page.getByTestId("portal-invite-copied")).toHaveCount(0);
  await page.getByTestId("portal-invite-copy").click();
  const copiedB = page.getByTestId("portal-invite-copied");
  await expect(copiedB).toHaveText(`已複製給 隔離屋主乙（${emailB}）的邀請連結`);
  const urlB = await copiedB.getAttribute("data-url");
  expect(urlB).toMatch(/\/accept\//);
  expect(urlB).not.toBe(urlA);
  expect(await inviteStatus(urlA || "")).toBe("pending");
  expect(await ownedPropertyNames(ownerB)).toEqual(["物件乙"]);

  const guestA = await browser.newContext();
  const pageA = await guestA.newPage();
  await pageA.goto(urlA || "/");
  await expect(pageA.getByTestId("portal-email")).toHaveValue("morgan.lee@owner.demo");
  await expect(pageA.locator("body")).not.toContainText(emailB);
  await guestA.close();

  const guestB = await browser.newContext();
  const pageB = await guestB.newPage();
  await pageB.goto(urlB || "/");
  await expect(pageB.getByTestId("portal-email")).toHaveValue(emailB);
  await expect(pageB.locator("body")).not.toContainText("morgan.lee@owner.demo");
  await pageB.getByTestId("new-password").fill("Owner1234");
  await pageB.getByTestId("portal-submit").click();
  await pageB.waitForURL(/\/o\/statements/);
  await expect(pageB.getByTestId("owner-property")).toHaveText("物件乙");
  await expect(pageB.getByTestId("owner-properties")).not.toContainText("物件甲");
  await expect(pageB.getByTestId("owner-properties")).not.toContainText("Oakland");
  await guestB.close();

  expect((await contactUser(morganId)).user_id).toBeNull();
  const bound = await contactUser(ownerB);
  expect(bound.user_id).toBeTruthy();
  expect(bound.email).toBe(emailB);
});

test("a signed-in account cannot accept an invite for a different email", async ({ page }) => {
  await resetDemo(page);
  await page.goto("/m/owners");
  await page.locator("[data-testid='owner-row-morgan.lee@owner.demo'] a").click();
  await page.getByTestId("portal-invite-copy").click();
  const url = await page.getByTestId("portal-invite-copied").getAttribute("data-url");
  expect(url).toMatch(/\/accept\//);
  await page.goto(url || "/");
  await expect(page.getByTestId("portal-email")).toHaveValue("morgan.lee@owner.demo");
  await expect(page.getByTestId("portal-other-account")).toHaveText(
    "您目前登入的是 yating.lin@songxin.demo，這份邀請是給 morgan.lee@owner.demo。",
  );
  await expect(page.getByTestId("portal-submit")).toHaveCount(0);
  await expect(page.getByTestId("new-password")).toHaveCount(0);
  await expect(page.getByTestId("portal-sign-out-continue")).toHaveText("登出並繼續");
  await page.getByTestId("portal-sign-out-continue").click();
  await page.waitForURL(/\/accept\//);
  await expect(page.getByTestId("portal-other-account")).toHaveCount(0);
  await expect(page.getByTestId("portal-email")).toHaveValue("morgan.lee@owner.demo");
  await expect(page.getByTestId("portal-submit")).toBeVisible();
  await expect(page.getByTestId("portal-forgot")).toHaveAttribute("href", "/forgot");
});

test("a tenant account accepts an owner invite and can open both portals", async ({ page, browser }) => {
  await resetDemo(page);
  const ownerId = await insertOwner("雙身分屋主", ACCOUNTS.tenant);
  await page.goto(`/m/owners/${ownerId}`);
  await page.getByTestId("portal-invite-copy").click();
  const url = await page.getByTestId("portal-invite-copied").getAttribute("data-url");
  expect(url).toMatch(/\/accept\//);
  const guest = await browser.newContext();
  const guestPage = await guest.newPage();
  await guestPage.goto(url || "/");
  await expect(guestPage.getByTestId("portal-email")).toHaveValue(ACCOUNTS.tenant);
  await guestPage.getByTestId("new-password").fill("Wrong1234");
  await guestPage.getByTestId("portal-submit").click();
  await expect(guestPage.locator(".alert.bad")).toHaveText("密碼不正確。請再試一次。");
  await expect(guestPage.getByTestId("portal-forgot")).toBeVisible();
  expect((await contactUser(ownerId)).user_id).toBeNull();
  await guestPage.getByTestId("new-password").fill("Demo1234");
  await guestPage.getByTestId("portal-submit").click();
  await guestPage.waitForURL(/\/o\/statements/);
  await expect(guestPage.getByTestId("switch-role")).toHaveText("切換身分：租客");
  await guestPage.getByTestId("switch-role").click();
  await guestPage.waitForURL(/\/t\/?$/);
  await expect(guestPage.getByTestId("liff-frame")).toBeVisible();
  await expect(guestPage.getByTestId("switch-role")).toHaveText("切換身分：屋主");
  await guestPage.getByTestId("switch-role").click();
  await guestPage.waitForURL(/\/o\/statements/);
  const bound = await contactUser(ownerId);
  expect(bound.email).toBe(ACCOUNTS.tenant);
  const client = new Client({
    connectionString: process.env.DATABASE_URL || "postgres://condola:condola@127.0.0.1:5432/condola",
  });
  await client.connect();
  try {
    const tenant = await client.query<{ user_id: string }>(
      `SELECT user_id::text AS user_id FROM contacts
        WHERE email = $1 AND is_tenant AND org_id = (SELECT id FROM organizations WHERE name = '松信住宅管理')`,
      [ACCOUNTS.tenant],
    );
    expect(tenant.rows[0].user_id).toBe(bound.user_id);
  } finally {
    await client.end();
  }
  await guest.close();
});

test("a rejected clipboard keeps the link and the failure notice until it is dismissed", async ({ page }) => {
  await resetDemo(page);
  await signIn(page, ACCOUNTS.manager);
  await page.goto("/m/owners");
  await page.locator("[data-testid='owner-row-morgan.lee@owner.demo'] a").click();
  await expect(page.getByTestId("portal-invite-copy")).toBeVisible();
  await page.evaluate(() => {
    const fail = () => Promise.reject(new DOMException("Document is not focused", "NotAllowedError"));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write: fail, writeText: fail } });
  });
  await page.getByTestId("portal-invite-copy").click();
  const notice = page.getByTestId("portal-invite-error");
  await expect(notice).toHaveText("連結沒有複製成功，請按「複製」，或長按連結自己複製");
  await expect(page.getByTestId("portal-invite-link")).toHaveValue(/\/accept\//);
  await expect(page.getByTestId("portal-invite-manual-copy")).toHaveText("複製");
  await expect(page.getByTestId("portal-invite-copy-hint")).toHaveCount(0);
  await expect(page.getByTestId("portal-invite-regenerate")).toHaveText("重新產生連結");
  await expect(page.getByTestId("portal-invite-copied")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("已複製給");
  await expect(page.locator("body")).not.toContainText("也可以長按連結自己複製");
  await expect(page.locator("body")).not.toContainText("網路不穩，連結還沒產生");
  await page.waitForTimeout(4000);
  await expect(notice).toHaveText("連結沒有複製成功，請按「複製」，或長按連結自己複製");
  await page.getByTestId("portal-invite-error-dismiss").click();
  await expect(notice).toHaveCount(0);
  await expect(page.getByTestId("portal-invite-link")).toHaveCount(0);
});

test("a granted clipboard shows a pending label and keeps the success line for 4 seconds", async ({ page }) => {
  await resetDemo(page);
  await signIn(page, ACCOUNTS.manager);
  await page.goto("/m/owners");
  await page.locator("[data-testid='owner-row-morgan.lee@owner.demo'] a").click();
  await expect(page.getByTestId("portal-invite-copy")).toHaveText("複製邀請連結");
  await page.route("**/m/owners/**", async (route) => {
    if (route.request().method() === "POST") await new Promise((resolve) => setTimeout(resolve, 600));
    await route.continue();
  });
  await page.getByTestId("portal-invite-copy").click();
  await expect(page.getByTestId("portal-invite-copy")).toHaveText("正在產生邀請連結…");
  await expect(page.getByTestId("portal-invite-copy")).toBeDisabled();
  const copied = page.getByTestId("portal-invite-copied");
  await expect(copied).toHaveText("已複製給 Morgan Lee（morgan.lee@owner.demo）的邀請連結");
  await expect(copied).toHaveAttribute("data-min-ms", "4000");
  await page.waitForTimeout(4000);
  await expect(copied).toHaveText("已複製給 Morgan Lee（morgan.lee@owner.demo）的邀請連結");
});

test("an invite saved before the secret table still copies", async ({ page }) => {
  await resetDemo(page);
  await signIn(page, ACCOUNTS.manager);
  const client = new Client({
    connectionString: process.env.DATABASE_URL || "postgres://condola:condola@127.0.0.1:5432/condola",
  });
  await client.connect();
  let ownerId = "";
  try {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO contacts (org_id, is_owner, display_name, email, locale)
       SELECT id, true, '舊連結屋主', 'old.invite.e2e@example.com', 'zh-TW'
         FROM organizations WHERE name = '松信住宅管理'
       RETURNING id::text`,
    );
    ownerId = inserted.rows[0].id;
    await client.query(
      `INSERT INTO invitations (org_id, kind, contact_id, email, code_hash, status, expires_at, invited_by)
       SELECT c.org_id, 'owner', c.id, c.email, $2, 'pending', now() + interval '7 days', m.user_id
         FROM contacts c
         JOIN org_members m ON m.org_id = c.org_id AND m.role = 'manager' AND m.status = 'active'
        WHERE c.id = $1
        LIMIT 1`,
      [ownerId, createHash("sha256").update("old-format-e2e").digest("hex")],
    );
    const secrets = await client.query(
      `SELECT 1 FROM portal_invite_secrets s
         JOIN invitations i ON i.id = s.invitation_id
        WHERE i.contact_id = $1`,
      [ownerId],
    );
    expect(secrets.rowCount).toBe(0);
  } finally {
    await client.end();
  }
  await page.goto(`/m/owners/${ownerId}`);
  await expect(page.getByTestId("portal-invite-copy")).toBeVisible();
  await expect(page.getByTestId("portal-invite-activated")).toHaveCount(0);
  await page.getByTestId("portal-invite-copy").click();
  const copied = page.getByTestId("portal-invite-copied");
  await expect(copied).toHaveText("已複製給 舊連結屋主（old.invite.e2e@example.com）的邀請連結");
  expect(await copied.getAttribute("data-url")).toMatch(/\/accept\//);
  await expect(page.getByTestId("portal-invite-error")).toHaveCount(0);
});

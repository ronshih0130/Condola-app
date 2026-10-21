import { createHash } from "node:crypto";
import { Client } from "pg";
import { expect, test } from "@playwright/test";
import { ACCOUNTS, resetDemo, signIn } from "./session";

const INVALID = "這個連結已失效，請向管理公司索取新的連結";

function tokenFrom(url: string) {
  return decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
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
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/leases?q=" + encodeURIComponent("李愛玲"));
  await page.getByRole("link", { name: "李愛玲" }).click();
  await expect(page.getByTestId("portal-invite-handoff")).toHaveText("傳給租客");
  await expect(page.getByTestId("portal-invite-copy")).toHaveText("複製邀請連結");
  await expect(page.locator("body")).not.toContainText("即將推出");

  await page.getByTestId("portal-invite-copy").click();
  const copied = page.getByTestId("portal-invite-copied");
  await expect(copied).toHaveText("已複製，7 天內有效，只能使用一次");
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

  await page.getByTestId("portal-invite-regenerate").click();
  await expect(copied).toHaveAttribute("data-url", /.+/);
  const liveUrl = await copied.getAttribute("data-url");
  expect(liveUrl).toBeTruthy();
  expect(liveUrl).not.toBe(firstUrl);
  await page.screenshot({ path: "/opt/cursor/artifacts/portal-invite-copied.png", fullPage: true });

  const guest = await browser.newContext();
  const guestPage = await guest.newPage();
  await guestPage.goto(liveUrl || "/");
  await expect(guestPage.getByTestId("portal-invite-title")).toHaveText("松信住宅管理 邀請你使用租多啦");
  await expect(guestPage.getByTestId("portal-email")).toHaveValue("ailing.li@tenant.demo");
  await expect(guestPage.getByTestId("portal-email")).toHaveAttribute("readonly", "");
  await expect(guestPage.locator("body")).not.toContainText("LINE");
  await guestPage.screenshot({ path: "/opt/cursor/artifacts/portal-invite-password.png", fullPage: true });
  await guestPage.getByTestId("new-password").fill("Fresh1234");
  await guestPage.getByTestId("password-confirm").fill("Fresh1234");
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

  await signIn(page, ACCOUNTS.owner);
  await page.goto("/o");
  await page.getByTestId("owner-sign-out").click();
  await page.waitForURL(/\/login/);
});

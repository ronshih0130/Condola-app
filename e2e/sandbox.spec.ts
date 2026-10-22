import { expect, test } from "@playwright/test";
import { FIRM_NAME } from "../src/server/ids";
import { displaySampleName, loadSampleRows, withSampleName } from "../src/server/sandbox-data";
import { ACCOUNTS, DEMO_PASSWORD, resetDemo, signIn } from "./session";

test.beforeEach(async ({ page }) => {
  await resetDemo(page);
});

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await resetDemo(page);
  await page.close();
});

test("a live firm opens live with no env cookie, and sign-in drops a leftover test-mode choice", async ({ page }) => {
  const sampleProperty = displaySampleName(withSampleName(loadSampleRows()[0].property));
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByTestId("login-email").fill(ACCOUNTS.admin);
  await page.getByTestId("login-password").fill(DEMO_PASSWORD);
  await page.getByTestId("login-submit").click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login") && !url.pathname.startsWith("/api/auth/enter"));

  await expect(page.getByTestId("env-banner")).toHaveCount(0);
  await expect(page.getByTestId("org-switch")).toContainText(FIRM_NAME);
  await expect(page.getByTestId("org-switch")).not.toContainText("（範例）");
  await expect(page.getByTestId("env-load")).toHaveCount(0);

  await page.goto("/api/env?set=sandbox&next=/m/properties");
  const banner = page.getByTestId("env-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("範例環境");
  await expect(banner).toContainText("回到正式公司");
  await expect(page.getByTestId("org-switch")).toContainText("範例公司");
  await expect(page.getByTestId("org-switch")).not.toContainText("（範例）");
  await expect(page.getByRole("link", { name: sampleProperty })).toBeVisible();
  await expect(page.getByTestId("sample-tag")).toHaveCount(0);
  await expect(page.getByTestId("property-list")).not.toContainText("範例資料");
  await page.reload();
  await expect(banner).toContainText("範例環境");

  const kept = (await page.context().cookies()).filter((cookie) => cookie.name === "condola_env");
  await page.context().clearCookies();
  if (kept.length) await page.context().addCookies(kept);
  await page.goto("/login");
  await page.getByTestId("login-email").fill(ACCOUNTS.admin);
  await page.getByTestId("login-password").fill(DEMO_PASSWORD);
  await page.getByTestId("login-submit").click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login") && !url.pathname.startsWith("/api/auth/enter"));
  await expect(page.getByTestId("env-banner")).toHaveCount(0);
  await expect(page.getByTestId("org-switch")).toContainText(FIRM_NAME);
  await expect(page.getByTestId("org-switch")).not.toContainText("（範例）");
});

test("staff can open the seeded sandbox", async ({ page }) => {
  const sampleProperty = displaySampleName(withSampleName(loadSampleRows()[0].property));
  await expect(page.getByTestId("env-banner")).toHaveCount(0);
  await expect(page.getByTestId("org-switch")).toContainText(FIRM_NAME);

  await page.getByTestId("org-switch").click();
  await expect(page.getByTestId("org-pick-sandbox")).toHaveText("範例公司");
  await page.getByTestId("org-pick-sandbox").click();
  await expect(page.getByTestId("env-load")).toHaveCount(0);
  const banner = page.getByTestId("env-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("範例環境");
  await expect(banner).not.toContainText("測試模式");
  await expect(banner).toContainText("回到正式公司");
  await expect(banner).not.toContainText("開始正式使用");
  await expect(banner).not.toContainText("要不要帶到正式公司");
  await expect(page.getByTestId("org-switch")).toContainText("範例公司");
  await expect(page.getByTestId("org-switch")).not.toContainText("（範例）");
  await expect(banner).toHaveCSS("background-color", "rgb(253, 243, 220)");
  await expect(banner).toHaveCSS("border-bottom-color", "rgb(242, 181, 68)");
  await page.goto("/m/properties");
  await expect(page.getByTestId("property-list")).toBeVisible();
  await expect(page.getByRole("link", { name: sampleProperty })).toBeVisible();
  await expect(page.getByTestId("sample-tag")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("開始正式使用");
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the switcher stays tappable", async ({ page }) => {
    await signIn(page, ACCOUNTS.admin);
    await page.getByTestId("nav-toggle").click();
    await page.getByTestId("org-switch").click();
    await page.getByTestId("org-pick-sandbox").click();
    await expect(page.getByTestId("env-load")).toHaveCount(0);
    await expect(page.getByTestId("env-banner")).toBeVisible();
    await expect(page.getByTestId("env-banner-live")).toHaveText("回到正式公司");
    await page.getByTestId("nav-toggle").click();
    const box = await page.getByTestId("org-switch").boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    await expect(page.locator("body")).not.toContainText("開始正式使用");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
    expect(overflow).toBe(true);
  });
});

test("a logged-in staff user gets 404 from /m/env and no page says 開始正式使用", async ({ page }) => {
  const missing = await page.goto("/m/env");
  expect(missing?.status()).toBe(404);
  await expect(page.locator("body")).not.toContainText("開始正式使用");
  for (const path of ["/m", "/m/properties", "/m/settings", "/m/audit", "/m/team", "/m/notify", "/m/account", "/pricing"]) {
    await page.goto(path);
    await expect(page.locator("body"), path).not.toContainText("開始正式使用");
  }
  await page.goto("/api/env?set=sandbox&next=/m");
  await expect(page.getByTestId("env-banner")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("開始正式使用");
});

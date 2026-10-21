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
  await expect(page.getByTestId("org-switch")).toContainText("（範例）");
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

test("staff can open the seeded sandbox and go live without copying it", async ({ page }) => {
  const sampleProperty = displaySampleName(withSampleName(loadSampleRows()[0].property));
  await expect(page.getByTestId("env-banner")).toHaveCount(0);
  await expect(page.getByTestId("org-switch")).toContainText(FIRM_NAME);

  await page.getByTestId("org-switch").click();
  await page.getByTestId("org-pick-sandbox").click();
  await expect(page.getByTestId("env-load")).toHaveCount(0);
  const banner = page.getByTestId("env-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("範例環境");
  await expect(banner).toContainText("回到正式公司");
  await expect(banner).toHaveCSS("background-color", "rgb(253, 243, 220)");
  await expect(banner).toHaveCSS("border-bottom-color", "rgb(242, 181, 68)");
  await page.goto("/m/properties");
  await expect(page.getByTestId("property-list")).toBeVisible();
  await expect(page.getByRole("link", { name: sampleProperty })).toBeVisible();
  await expect(page.getByTestId("sample-tag")).toHaveCount(0);

  await page.goto("/m/env");
  await expect(page.getByTestId("gl-req")).toHaveAttribute("data-allowed", "true");
  await expect(page.getByTestId("gl-copy")).toBeChecked();
  await expect(page.getByTestId("gl-owners")).toContainText("屋主資料會一起複製");
  await expect(page.getByTestId("gl-owners")).toContainText("登入與邀請會重設");
  await expect(page.getByTestId("gl-never")).toContainText("測試中的人和金額都是練習用的");
  await page.getByTestId("gl-copy").uncheck();
  await expect(page.getByTestId("gl-no-copy")).toBeVisible();
  await page.getByTestId("gl-confirm").click();

  await expect(page.getByTestId("golive-note")).toBeVisible();
  await expect(page.getByTestId("env-banner")).toHaveCount(0);
  await page.goto("/m/properties");
  await expect(page.getByRole("link", { name: sampleProperty })).toHaveCount(0);

  await page.getByTestId("org-switch").click();
  await page.getByTestId("org-pick-sandbox").click();
  await expect(page.getByTestId("env-load")).toHaveCount(0);
  await expect(page.getByTestId("env-banner")).toBeVisible();
  await page.goto("/m/properties");
  await expect(page.getByRole("link", { name: sampleProperty })).toBeVisible();
  await expect(page.getByTestId("sample-tag")).toHaveCount(0);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the switcher stays tappable and go-live fits", async ({ page }) => {
    await signIn(page, ACCOUNTS.admin);
    await page.getByTestId("nav-toggle").click();
    await page.getByTestId("org-switch").click();
    await page.getByTestId("org-pick-sandbox").click();
    await expect(page.getByTestId("env-load")).toHaveCount(0);
    await expect(page.getByTestId("env-banner")).toBeVisible();
    await page.getByTestId("nav-toggle").click();
    const box = await page.getByTestId("org-switch").boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    await page.goto("/m/env");
    await expect(page.getByTestId("gl-never")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
    expect(overflow).toBe(true);
  });
});

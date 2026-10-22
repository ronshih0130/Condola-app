import { expect, test } from "@playwright/test";
import { scanRenderedHtml } from "./check-banned-terms";

/**
 * Skeleton for the #18 electricity posting checks.
 * Point Playwright at the environment with QA_BASE_URL (see playwright.qa.config.ts).
 * Sign-in comes only from QA_TENANT_EMAIL and QA_TENANT_PASSWORD. Do not commit either value.
 */
const email = process.env.QA_TENANT_EMAIL ?? "";
const password = process.env.QA_TENANT_PASSWORD ?? "";

test.describe("tenant bill (#18)", () => {
  test.skip(!email || !password, "Set QA_TENANT_EMAIL and QA_TENANT_PASSWORD. Do not commit them.");

  test("pay page shows 應繳合計, line totals, and electricity labels", async ({ page }) => {
    await page.goto("/login");
    await page.getByTestId("login-email").fill(email);
    await page.getByTestId("login-password").fill(password);
    await page.getByTestId("login-submit").click();
    await page.waitForURL((url) => !url.pathname.startsWith("/login"));

    await page.goto("/t/pay");
    const bill = page.getByTestId("tenant-bill");
    await expect(bill).toBeVisible();
    await expect(bill).toContainText("應繳合計");
    await expect(bill).toContainText(/NT\$[\d,]+|US\$[\d,]+\.\d{2}/);

    const utility = page.getByTestId("tenant-utility-line");
    expect(await utility.count(), "confirmed electricity shares should be on the tenant bill").toBeGreaterThan(0);
    const count = await utility.count();
    for (let index = 0; index < count; index += 1) {
      await expect(utility.nth(index)).toContainText("電費");
    }

    scanRenderedHtml("/t/pay", await page.content());
  });
});

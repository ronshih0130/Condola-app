import { expect, test } from "@playwright/test";
import { ACCOUNTS, resetDemo, signIn } from "./session";

test("a manager confirms 電費 and the tenant sees it on the bill", async ({ page }) => {
  await resetDemo(page);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/units");

  for (const room of ["A", "B"]) {
    await page.getByTestId(`space-row-3F-${room}`).getByRole("link", { name: "編輯" }).click();
    await page.getByTestId("space-electricity").selectOption("submeter");
    await page.getByTestId("space-rate").fill("4");
    await page.getByTestId("save-space").click();
    await expect(page.getByTestId(`space-row-3F-${room}`)).toContainText("分表");
  }

  await page.goto("/m/rent");
  await page.getByTestId("utility-entry").click();
  await expect(page.getByTestId("utility-form")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("房東");
  await page.getByTestId("utility-rate").fill("4");
  await page.getByTestId("kwh-A").fill("100");
  await page.getByTestId("kwh-B").fill("50");
  await page.getByTestId("utility-preview").click();
  await expect(page.getByTestId("utility-review")).toBeVisible();
  await expect(page.getByTestId("utility-share-desc").nth(0)).toContainText("電費 100 度 × 4 元");
  await expect(page.getByTestId("utility-share-desc").nth(1)).toContainText("電費 50 度 × 4 元");
  await page.getByTestId("utility-confirm").click();
  await expect(page.getByTestId("utility-saved")).toContainText("電費已記入租客本期帳單");
  await page.getByTestId("kwh-A").fill("90");
  await page.getByTestId("utility-preview").click();
  await expect(page.getByTestId("utility-status")).toContainText("待重新入帳");
  await page.getByTestId("kwh-A").fill("100");
  await page.getByTestId("kwh-B").fill("50");
  await page.getByTestId("utility-preview").click();
  await expect(page.getByTestId("utility-status")).toContainText("待重新入帳");
  await page.getByTestId("utility-confirm").click();
  await expect(page.getByTestId("utility-status")).toContainText("已入帳");

  await page.goto("/m/leases");
  await page.getByRole("link", { name: "王小美" }).click();
  await page.getByRole("link", { name: "帳務" }).click();
  await expect(page.getByTestId("invoice-utility-line")).toContainText("電費 100 度 × 4 元");
  await expect(page.getByTestId("invoice-utility")).toHaveAttribute("data-minor", "40000");
  await expect(page.locator("body")).not.toContainText("房東");

  await signIn(page, ACCOUNTS.tenant2);
  await page.goto("/api/demo/locale?set=zh-TW&next=/t/pay");
  await expect(page.getByTestId("tenant-utility-line")).toContainText("電費 100 度 × 4 元");
  await expect(page.locator("body")).not.toContainText("房東");
});

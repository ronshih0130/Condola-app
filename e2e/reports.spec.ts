import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { ACCOUNTS, resetDemo, signIn } from "./session";

test("staff compare income and expenses for a period and export csv", async ({ page }) => {
  await resetDemo(page);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/reports");
  await expect(page.getByRole("heading", { name: "收支報表" })).toBeVisible();
  await expect(page.locator(".main")).not.toContainText("房東");
  await expect(page.locator(".main")).not.toContainText("房客");
  await expect(page.getByTestId("report-month")).toBeVisible();
  const month = await page.getByTestId("report-month").inputValue();
  const year = Number(month.slice(0, 4));
  await page.getByTestId("report-mode").selectOption("range");
  await page.getByTestId("report-from").fill(`${year - 1}-01-01`);
  await page.getByTestId("report-to").fill(`${year + 1}-12-31`);
  await page.getByTestId("report-apply").click();
  const xinyi = page.getByTestId("report-row").filter({ hasText: "信義松仁" });
  await expect(xinyi).toContainText("NT$10,000");
  await expect(xinyi).toContainText("NT$2,800");
  await expect(xinyi).toContainText("NT$7,200");
  await expect(page.getByTestId("report-row").filter({ hasText: "大安和平" })).toBeVisible();
  await page.screenshot({ path: "../e2e-artifacts/income-expense-report.png", fullPage: true });

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("report-export").click(),
  ]);
  const file = await download.path();
  expect(file).toBeTruthy();
  const csv = readFileSync(file!, "utf8");
  expect(csv).toContain("信義松仁");
  expect(csv).toContain("10000.00");
  expect(csv).toContain("2800.00");
  expect(csv).toContain("7200.00");

  await page.getByTestId("report-owner").selectOption({ label: "陳建宏" });
  await page.getByTestId("report-apply").click();
  await expect(page.getByTestId("report-row").filter({ hasText: "大安和平" })).toHaveCount(0);
  await expect(page.getByTestId("report-row").filter({ hasText: "信義松仁" })).toBeVisible();

  await signIn(page, ACCOUNTS.maintenance);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/reports");
  await expect(page.getByTestId("forbidden")).toBeVisible();

  await signIn(page, ACCOUNTS.manager);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/reports");
  await expect(page.getByRole("heading", { name: "收支報表" })).toBeVisible();
});

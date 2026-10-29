import { expect, test } from "@playwright/test";
import { ACCOUNTS, resetDemo, signIn } from "./session";

test("pricing and upgrade list only implemented plan terms", async ({ page }) => {
  await page.goto("/api/demo/locale?set=zh-TW&next=/pricing");
  const pricing = page.locator(".pricing-page");
  await expect(page.getByTestId("price-headline")).toContainText("免費方案依官網公告");
  await expect(pricing.getByText("NT$0", { exact: true })).toBeVisible();
  await expect(page.getByTestId("plan-price-standard")).toHaveText("第 5 戶起每戶每月 NT$30");
  await expect(page.getByTestId("plan-price-pro")).toHaveText("第 5 戶起每戶每月 NT$40");
  await expect(pricing.getByText("自己管房的屋主（依官網公告之免費戶數內）")).toBeVisible();
  await expect(pricing.getByText("1 個席次（待接受的邀請也計入）")).toBeVisible();
  await expect(pricing.getByText("中小型管理公司")).toBeVisible();
  await expect(pricing.getByText("5 個席次")).toBeVisible();
  await expect(pricing.getByText("多據點、人數較多的團隊")).toBeVisible();
  await expect(pricing.getByText("不限席次", { exact: true })).toBeVisible();
  await expect(pricing.getByText("前 3 個月免費")).toHaveCount(2);
  await expect(page.getByTestId("price-note")).toHaveText("年繳享 1 個月免費。");
  await expect(page.getByTestId("cycle-year")).toHaveText("年繳送 1 個月");
  await page.getByTestId("calc-units").fill("600");
  await expect(page.getByTestId("price-result")).toContainText("NT$17,880");
  await page.getByTestId("cycle-year").click();
  await expect(page.getByTestId("price-year")).toHaveText("年繳 NT$196,680（送 1 個月）");
  for (const banned of ["品牌報表", "LINE 官方", "優先支援", "進階報表", "即將推出", "Excel", "房東", "房客", "CSV/ZIP", "超過 500", "NT$25", "2 個月"]) {
    await expect(pricing).not.toContainText(banned);
  }

  await resetDemo(page);
  await signIn(page, ACCOUNTS.admin);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/upgrade?tier=pro");
  await expect(page).toHaveURL(/\/m\/settings$/);
  const main = page.locator(".main");
  await expect(main).not.toContainText("送出申請");
  await expect(main).not.toContainText("目前以銀行轉帳付款");
  await expect(page.getByTestId("upgrade-form")).toHaveCount(0);
  await expect(page.getByTestId("upgrade-submit")).toHaveCount(0);
  await expect(page.getByTestId("settings-plan")).toHaveText("方案：免費方案依官網公告・設計夥伴合作期間免費");
});

test("property export offers a properties CSV", async ({ page }) => {
  await resetDemo(page);
  await signIn(page, ACCOUNTS.admin);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/properties");
  const link = page.getByTestId("export-properties");
  await expect(link).toHaveText("匯出物件（CSV）");
  await expect(link).toHaveAttribute("href", "/api/export");
  await expect(page.locator(".main")).not.toContainText("CSV/ZIP");
  await expect(page.locator(".main")).not.toContainText("租約、帳務");
  await expect(page.locator(".main")).not.toContainText("房東");
  await expect(page.locator(".main")).not.toContainText("房客");
});

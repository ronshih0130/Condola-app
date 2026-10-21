import { expect, test } from "@playwright/test";
import { ACCOUNTS, resetDemo, signIn } from "./session";

test("staff record, edit, and void an expense in zh-TW", async ({ page }) => {
  await resetDemo(page);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/expenses");
  await expect(page.getByRole("heading", { name: "支出紀錄" })).toBeVisible();
  await expect(page.locator(".main")).not.toContainText("房東");
  await expect(page.locator(".main")).not.toContainText("房客");
  const seeded = page.getByTestId("expense-row").filter({ hasText: "冷氣維修" });
  await expect(seeded).toBeVisible();
  await expect(seeded.getByTestId("expense-included")).toHaveText("計入屋主報表");
  await expect(seeded.getByTestId("expense-status")).toHaveText("已核准");

  await page.getByTestId("new-expense").click();
  await page.getByTestId("expense-property").selectOption({ label: "信義松仁" });
  await page.getByTestId("expense-unit").selectOption({ label: "3F" });
  await page.getByTestId("expense-category").selectOption({ label: "清潔" });
  await page.getByTestId("expense-amount").fill("1500");
  await page.getByTestId("expense-date").fill("2099-06-15");
  await page.getByTestId("expense-vendor").fill("老張水電");
  await page.getByTestId("expense-note").fill("e2e 水管檢修");
  await expect(page.getByTestId("expense-receipt")).toHaveCount(0);
  await page.getByTestId("expense-save").click();
  await expect(page.getByTestId("expense-saved")).toBeVisible();
  await expect(page.getByTestId("expense-included")).toHaveText("計入屋主報表");
  await expect(page.getByTestId("expense-status")).toHaveText("已入帳");
  await expect(page.getByTestId("expense-summary")).toContainText("e2e 水管檢修");
  await expect(page.getByTestId("expense-summary")).toContainText("3F");
  await expect(page.getByTestId("expense-receipt")).toHaveCount(0);
  await page.screenshot({ path: "/opt/cursor/artifacts/expense-detail.png", fullPage: true });

  await page.getByTestId("expense-note").fill("e2e 水管檢修改");
  await page.getByTestId("expense-save").click();
  await expect(page.getByTestId("expense-summary")).toContainText("e2e 水管檢修改");

  await page.getByTestId("expense-void-reason").fill("重複登錄");
  await page.getByTestId("expense-void").click();
  await expect(page.getByTestId("expense-voided")).toBeVisible();
  await expect(page.getByTestId("expense-included")).toHaveText("不計入屋主報表");
  await expect(page.getByTestId("expense-status")).toHaveText("已作廢");
  await expect(page.getByTestId("expense-void-form")).toHaveCount(0);

  await page.goto("/m/expenses");
  const voided = page.getByTestId("expense-row").filter({ hasText: "e2e 水管檢修改" });
  await expect(voided.getByTestId("expense-included")).toHaveText("不計入屋主報表");
  await page.getByTestId("expense-filter-property").selectOption({ label: "大安和平" });
  await page.getByTestId("expense-filter-apply").click();
  await expect(page.getByTestId("expense-row").filter({ hasText: "冷氣維修" })).toHaveCount(0);
  await page.getByTestId("expense-filter-property").selectOption({ label: "信義松仁" });
  await page.getByTestId("expense-filter-apply").click();
  await expect(page.getByTestId("expense-row").filter({ hasText: "冷氣維修" })).toBeVisible();
  await page.screenshot({ path: "/opt/cursor/artifacts/expense-list.png", fullPage: true });

  await signIn(page, ACCOUNTS.maintenance);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/expenses");
  await expect(page.getByTestId("forbidden")).toBeVisible();

  await signIn(page, ACCOUNTS.manager);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/expenses/new");
  await expect(page.getByTestId("expense-save")).toBeVisible();

  await signIn(page, ACCOUNTS.accountant);
  await page.goto("/m/expenses");
  await expect(page.getByTestId("expense-list")).toBeVisible();
  await expect(page.locator(".main")).not.toContainText("房東");
});

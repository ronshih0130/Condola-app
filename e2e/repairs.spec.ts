import { expect, test } from "@playwright/test";
import { ACCOUNTS, resetDemo, signIn } from "./session";

test("a tenant files a repair and staff records the repair history", async ({ page }) => {
  await resetDemo(page);
  await signIn(page, ACCOUNTS.tenant2);
  await page.goto("/t/repair");
  await expect(page.getByRole("heading", { name: "報修" })).toBeVisible();
  await expect(page.getByText("只顯示您這份租約的報修。")).toBeVisible();
  await page.getByTestId("repair-title").fill("廚房漏水測試");
  await page.getByTestId("submit-repair").click();
  await expect(page.locator(".alert.ok")).toContainText("已送出");
  await expect(page.getByTestId("tenant-repairs")).toContainText("廚房漏水測試");
  await expect(page.getByTestId("repair-timeline")).toContainText("已送出報修");
  await page.getByTestId("repair-comment").fill("請盡快處理");
  await page.getByTestId("repair-comment-send").click();
  await expect(page.getByTestId("repair-timeline")).toContainText("請盡快處理");
  await expect(page.getByTestId("repair-photo")).toBeVisible();

  await signIn(page, ACCOUNTS.tenant);
  await page.getByRole("button", { name: /松信住宅管理/ }).click();
  await page.getByTestId("tenant-tile-repair").click();
  await expect(page.getByTestId("tenant-repairs")).not.toContainText("廚房漏水測試");
  await expect(page.getByTestId("tenant-repairs")).not.toContainText("浴室水龍頭滲水");

  await signIn(page, ACCOUNTS.admin);
  await page.goto("/m/tickets");
  await expect(page.getByRole("heading", { name: "修繕紀錄" })).toBeVisible();
  await page.getByRole("link", { name: /廚房漏水測試/ }).click();
  await page.getByTestId("repair-vendor").fill("老張水電");
  await page.getByTestId("repair-estimate").fill("1500");
  await page.getByTestId("repair-final").fill("1800");
  await page.getByTestId("repair-bearer").selectOption("owner");
  await page.getByTestId("repair-scheduled").fill("2026-11-01");
  await page.getByTestId("repair-completed").fill("2026-11-03");
  await page.getByTestId("repair-status").selectOption("resolved");
  await page.getByTestId("repair-note").fill("已更換龍頭");
  await page.getByTestId("repair-post-expense").check();
  await page.getByTestId("repair-save").click();
  await expect(page.getByTestId("repair-expense-linked")).toHaveText("已連結支出");
  await expect(page.getByTestId("repair-vendor")).toHaveValue("老張水電");
  await expect(page.getByTestId("repair-timeline")).toContainText("已完成");
  await expect(page.getByTestId("repair-timeline")).toContainText("已更換龍頭");

  await page.getByTestId("repair-property").click();
  await expect(page.getByTestId("repair-history")).toContainText("廚房漏水測試");
  await expect(page.getByTestId("repair-history")).toContainText("老張水電");
});

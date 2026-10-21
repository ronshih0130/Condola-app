import { expect, test } from "@playwright/test";
import { ACCOUNTS, signIn } from "./session";

test("an org admin can filter 操作紀錄 and open a record history", async ({ page }) => {
  await signIn(page, ACCOUNTS.admin);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/audit");
  await expect(page.getByRole("heading", { name: "操作紀錄" })).toBeVisible();
  await expect(page.getByTestId("audit-filters")).toBeVisible();
  await expect(page.locator(".main")).not.toContainText("房東");
  await expect(page.getByTestId("audit-page")).toContainText("不會顯示在這頁");
  const list = page.getByTestId("audit-list");
  await expect(list).toBeVisible();
  const text = await list.innerText();
  expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  expect(text).not.toMatch(/[A-Z][1289]\d{8}/);
  expect(text).not.toMatch(/\+886\d{8,10}/);

  await page.getByLabel("動作").selectOption({ label: "登入" });
  await page.getByRole("button", { name: "篩選" }).click();
  await expect(page).toHaveURL(/action=sign_in/);
  await expect(page.locator(".main")).not.toContainText("房東");

  await page.goto("/m/properties");
  await page.getByTestId("property-list").getByRole("link").first().click();
  await expect(page.getByTestId("audit-history")).toBeVisible();
  await expect(page.getByTestId("audit-history")).toContainText("這筆的操作紀錄");
  await expect(page.locator(".main")).not.toContainText("房東");
  await page.screenshot({ path: "/opt/cursor/artifacts/audit-property-history.png", fullPage: true });

  await page.goto("/m/tenants");
  await page.locator(".main table").getByRole("link").first().click();
  await expect(page.getByTestId("audit-history")).toBeVisible();
  await expect(page.getByTestId("tenant-leases")).toBeVisible();

  await page.goto("/m/leases");
  await page.locator(".main table").getByRole("link").first().click();
  await expect(page.getByTestId("audit-history")).toBeVisible();
  await page.screenshot({ path: "/opt/cursor/artifacts/audit-lease-history.png", fullPage: true });
  await page.goto("/m/audit");
  await page.screenshot({ path: "/opt/cursor/artifacts/audit-log.png", fullPage: true });
});

test("managers and accountants cannot open 操作紀錄", async ({ page }) => {
  await signIn(page, ACCOUNTS.accountant);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/audit");
  await expect(page.getByTestId("forbidden")).toBeVisible();
  await expect(page.getByTestId("audit-list")).toHaveCount(0);
  await page.goto("/m/properties");
  await page.getByTestId("property-list").getByRole("link").first().click();
  await expect(page.getByTestId("audit-history")).toHaveCount(0);

  await signIn(page, ACCOUNTS.manager);
  await page.goto("/m/audit");
  await expect(page.getByTestId("forbidden")).toBeVisible();
  await expect(page.getByRole("link", { name: "操作紀錄" })).toHaveCount(0);
});

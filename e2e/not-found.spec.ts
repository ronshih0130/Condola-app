import { expect, test } from "@playwright/test";
import { resetDemo } from "./session";

const MISSING_ID = "00000000-0000-4000-8000-000000000099";

test("an unknown url shows the Chinese not-found page", async ({ page }) => {
  const response = await page.goto("/no-such-page");
  expect(response?.status()).toBe(404);
  const card = page.getByTestId("not-found");
  await expect(card).toContainText("找不到這個頁面");
  await expect(card).toContainText("可能是網址打錯，或這筆資料已經不在了。");
  await expect(card).not.toContainText("404");
  await expect(card).not.toContainText(/[A-Za-z]/);
  const home = page.getByTestId("not-found-home");
  await expect(home).toHaveText("回到首頁");
  await expect(home).toHaveAttribute("href", "/");
  await home.click();
  await page.waitForURL((url) => url.pathname !== "/no-such-page");
  await expect(page.getByTestId("not-found")).toHaveCount(0);
});

test("missing lease and owner ids show the manager not-found page", async ({ page }) => {
  await resetDemo(page);
  for (const path of [`/m/leases/${MISSING_ID}`, `/m/owners/${MISSING_ID}`, "/m/leases/missing", "/m/owners/missing"]) {
    const response = await page.goto(path);
    expect(response?.status()).toBe(404);
    const card = page.getByTestId("not-found");
    await expect(card).toContainText("找不到這個頁面");
    await expect(card).toContainText("可能是網址打錯，或這筆資料已經不在了。");
    await expect(card).not.toContainText(/[A-Za-z]/);
    await expect(page.getByTestId("not-found-home")).toHaveText("回到首頁");
    await expect(page.getByTestId("not-found-home")).toHaveAttribute("href", "/m");
  }
  await page.getByTestId("not-found-home").click();
  await expect(page).toHaveURL(/\/m$/);
});

test("the manager home shows NT$ amounts and 已繳", async ({ page }) => {
  await resetDemo(page);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m");
  await page.goto("/api/env?set=sandbox&next=/m");
  const received = page.getByTestId("dash-received");
  const outstanding = page.getByTestId("dash-outstanding");
  await expect(received).toHaveText(/^NT\$[\d,]+$/);
  await expect(outstanding).toHaveText(/^NT\$[\d,]+$/);
  await expect(page.locator("a.kpi").filter({ has: received })).toContainText("已繳");
  await expect(page.locator("a.kpi").filter({ has: outstanding })).toContainText("未結餘額");
  await expect(page.locator(".grid5")).not.toContainText("已收");
  const rows = page.getByTestId("dash-property-amounts");
  await expect(rows.first()).toBeVisible();
  const count = await rows.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    await expect(rows.nth(index)).toHaveText(/^NT\$[\d,]+ \/ NT\$[\d,]+$/);
  }
  const owing = page.getByTestId("outstanding-list");
  if ((await owing.count()) > 0) {
    const text = await owing.innerText();
    expect(text).toContain("NT$");
    expect(text).not.toMatch(/(^|[^\w])\$(?![0-9])/);
    expect(text).not.toMatch(/(^|[^T])\$\d/);
  }
});

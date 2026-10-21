import { expect, test } from "@playwright/test";
import { resetDemo } from "./session";

test("staff can lease a vacant room to an existing 租客", async ({ page }) => {
  await resetDemo(page);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/leases/new");
  await expect(page.locator("body")).not.toContainText("房東");
  await expect(page.locator("body")).not.toContainText("房客");

  const room = page.getByTestId("lease-room");
  const roomValue = await room.locator("option", { hasText: "3F C" }).first().getAttribute("value");
  expect(roomValue).toBeTruthy();
  await room.selectOption(roomValue ?? "");
  await expect(page.getByTestId("wizard-next")).toBeEnabled();
  await page.getByTestId("wizard-next").click();

  await expect(page.getByTestId("tenant-mode-new")).toBeChecked();
  await expect(page.getByTestId("tenant-name")).toBeVisible();
  await page.getByTestId("tenant-mode-existing").check();
  await expect(page.getByTestId("tenant-name")).toHaveCount(0);

  await page.getByTestId("tenant-search").fill("沒有這個人");
  await expect(page.getByTestId("tenant-none")).toBeVisible();
  await page.getByTestId("tenant-search").fill("0912-111-002");
  const option = page.getByTestId("tenant-option");
  await expect(option).toHaveCount(1);
  await expect(option).toContainText("王小美");
  await expect(option).not.toContainText("張雅文");
  await option.click();
  await expect(page.getByTestId("tenant-picked")).toHaveText("王小美");

  await page.getByTestId("tenant-search").fill("沒有這個人");
  await expect(page.getByTestId("tenant-picked")).toHaveCount(0);
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("tenant-pick-error")).toBeVisible();

  await page.getByTestId("tenant-search").fill("0912-111-002");
  await expect(page.getByTestId("tenant-option")).toHaveCount(1);
  await page.getByTestId("tenant-option").click();
  await expect(page.getByTestId("tenant-picked")).toHaveText("王小美");
  await page.getByTestId("wizard-next").click();

  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
  await page.getByTestId("start-date").fill(today);
  await page.getByTestId("term-months").fill("12");
  await page.getByTestId("rent").fill("12000");
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("deposit-months").fill("1.5");
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("due-day").fill("5");
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("utility-monthly-note")).toBeVisible();
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("lease-confirm-tenant")).toHaveText("王小美");
  await expect(page.getByTestId("lease-confirm-space")).toContainText("信義松仁");
  await expect(page.getByTestId("lease-confirm-rent")).toHaveText("NT$12,000");
  await expect(page.getByTestId("lease-confirm-deposit")).toHaveText("1.5 個月（NT$18,000）");
  await page.getByTestId("submit-lease").click();
  await expect(page).toHaveURL(/\/m\/leases\/[0-9a-f-]{36}\?created=1$/);
  await expect(page.getByTestId("lease-created")).toHaveText("租約已建立，請將簽署連結傳給租客");

  const error = page.getByTestId("lease-error");
  if (await error.isVisible().catch(() => false)) {
    throw new Error(await error.innerText());
  }
  await expect(page.getByRole("heading", { level: 1, name: /王小美/ })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("房客");

  await page.goto("/m/tenants");
  const wang = page.getByTestId("tenant-list").locator("tr").filter({ hasText: "王小美" });
  await expect(wang).toHaveCount(1);
  await expect(wang.getByTestId("tenant-lease-more")).toHaveText("+1");
});

test("a duplicate tenant email stays on the tenant step and can switch to that 租客", async ({ page }) => {
  await resetDemo(page);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/leases/new");

  const room = page.getByTestId("lease-room");
  const roomValue = await room.locator("option", { hasText: "3F C" }).first().getAttribute("value");
  expect(roomValue).toBeTruthy();
  await room.selectOption(roomValue ?? "");
  await expect(page.getByTestId("wizard-next")).toBeEnabled();
  await page.getByTestId("wizard-next").click();

  await page.getByTestId("tenant-name").fill("另一位");
  await page.getByTestId("tenant-phone").fill("0912000999");
  const email = page.getByTestId("tenant-email");
  await email.fill("Xiaomei.Wang@tenant.demo");
  await email.blur();
  await expect(page.getByTestId("tenant-email-exists")).toBeVisible();
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("tenant-email")).toBeVisible();
  await expect(page.getByTestId("start-date")).toBeHidden();

  await page.getByTestId("tenant-use-existing").click();
  await expect(page.getByTestId("tenant-mode-existing")).toBeChecked();
  await expect(page.getByTestId("tenant-picked")).toHaveText("王小美");
  await expect(page.getByTestId("tenant-email")).toHaveCount(0);
});

test("TWD rent and deposit stay whole dollars", async ({ page }) => {
  await resetDemo(page);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/leases/new");
  const room = page.getByTestId("lease-room");
  const roomValue = await room.locator("option", { hasText: "3F C" }).first().getAttribute("value");
  expect(roomValue).toBeTruthy();
  await room.selectOption(roomValue ?? "");
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("tenant-name").fill("小數");
  await page.getByTestId("tenant-phone").fill("0912000888");
  await page.getByTestId("wizard-next").click();

  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
  await page.getByTestId("start-date").fill(today);
  await page.getByTestId("term-months").fill("12");
  await page.getByTestId("rent").fill("10000.5");
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("rent-error")).toHaveText("月租未完成，請確認後再繼續。");
  await expect(page.getByTestId("deposit-months")).toBeHidden();

  await page.getByTestId("rent").fill("10001");
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("deposit-months").fill("1.3");
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("deposit-error")).toHaveText("押金以 0.5 個月為單位");
  await expect(page.getByTestId("due-day")).toBeHidden();

  await page.getByTestId("deposit-months").fill("1.5");
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("due-day")).toBeVisible();
});

test("a deposit of zero months still opens the new lease", async ({ page }) => {
  await resetDemo(page);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/leases/new");
  const room = page.getByTestId("lease-room");
  const roomValue = await room.locator("option", { hasText: "3F C" }).first().getAttribute("value");
  expect(roomValue).toBeTruthy();
  await room.selectOption(roomValue ?? "");
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("tenant-name").fill("零押金");
  await page.getByTestId("tenant-phone").fill("0912000777");
  await page.getByTestId("wizard-next").click();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
  await page.getByTestId("start-date").fill(today);
  await page.getByTestId("term-months").fill("12");
  await page.getByTestId("rent").fill("12000");
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("deposit-months").fill("0");
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("due-day").fill("5");
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("utility-monthly-note")).toBeVisible();
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("lease-confirm-space")).toContainText("信義松仁");
  await expect(page.getByTestId("lease-confirm-rent")).toHaveText("NT$12,000");
  await expect(page.getByTestId("lease-confirm-deposit")).toHaveText("0 個月（NT$0）");
  await page.getByTestId("submit-lease").click();
  await expect(page).toHaveURL(/\/m\/leases\/[0-9a-f-]{36}\?created=1$/);
  await expect(page.getByTestId("lease-created")).toHaveText("租約已建立，請將簽署連結傳給租客");
  await expect(page.getByRole("heading", { level: 1, name: /零押金/ })).toBeVisible();
});

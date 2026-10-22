import { expect, test, type Page } from "@playwright/test";
import { ACCOUNTS, resetDemo, signIn } from "./session";

const locales = [
  {
    code: "zh-TW",
    newOwner: "新屋主",
    byRoom: "分房出租",
    simulate: /模擬/,
    pay: "登記繳租",
    regenerate: "重新產生",
    reset: "已重置範例資料",
  },
  {
    code: "en",
    newOwner: "New owner",
    byRoom: "By room",
    simulate: /simulate/i,
    pay: "Record payment",
    regenerate: "Regenerate",
    reset: "Demo reset",
  },
] as const;

test.beforeEach(async ({ page }) => {
  await resetDemo(page);
});

for (const locale of locales) {
  test(`try-out tasks ${locale.code}`, async ({ page }) => {
    await page.goto(`/api/demo/locale?set=${locale.code}&next=/m/properties/new`);
    await expect(page.getByTestId("property-name")).toHaveValue("");
    await expect(page.getByTestId("owner-name")).toHaveValue("");
    await expect(page.getByTestId("room-0-label")).toHaveValue("");
    await expect(page.getByTestId("room-0-type")).toHaveValue("");
    await expect(page.getByTestId("room-0-rent")).toHaveValue("");
    await expect(page.getByTestId("property-name")).toHaveAttribute("placeholder", /.+/);
    await expect(page.getByTestId("room-0-rent")).toHaveAttribute("placeholder", /.+/);
    if (locale.code === "zh-TW") {
      await page.screenshot({ path: "/opt/cursor/artifacts/property-wizard-empty.png", fullPage: true });
    }

    await page.getByTestId("property-name").fill("松德試用");
    await page.getByTestId("property-city").fill(locale.code === "en" ? "Taipei" : "台北市");
    await page.getByTestId("property-district").fill(locale.code === "en" ? "Songshan" : "松山區");
    await page.getByTestId("property-street").fill(locale.code === "en" ? "Songde Rd" : "松德路");
    await page.locator("input[name=number]").fill("100");
    await page.getByText(locale.newOwner, { exact: true }).click();
    await page.getByTestId("owner-name").fill("試用屋主");
    await page.getByTestId("owner-phone").fill("+886912300001");
    await page.getByTestId("wizard-next").click();
    await page.getByText(locale.byRoom, { exact: true }).click();
    await page.getByTestId("wizard-next").click();
    await page.getByTestId("unit-floor").fill("3");
    await page.getByTestId("add-room").click();
    await page.getByTestId("add-room").click();
    for (const [index, label] of ["A", "B", "C"].entries()) {
      await page.getByTestId(`room-${index}-label`).fill(label);
      await page.getByTestId(`room-${index}-rent`).fill("12000");
    }
    await page.getByTestId("wizard-next").click();
    await page.getByRole("button", { name: /上一步|Back/ }).click();
    await expect(page.getByTestId("room-0-rent")).toHaveValue("12000");
    await expect(page.getByTestId("room-1-rent")).toHaveValue("12000");
    await expect(page.getByTestId("room-2-rent")).toHaveValue("12000");
    await expect(page.locator(".steps")).not.toContainText("✓.");
    await page.getByTestId("wizard-next").click();
    await page.getByTestId("submit-property").click();
    await expect(page.getByRole("heading", { name: "松德試用" })).toBeVisible();
    await expect(page.getByTestId("meter-number-prompt")).toBeVisible();
    await expect(page.getByTestId("meter-serial")).toHaveValue("");
    await page.getByTestId("meter-serial").fill("12-34-5678-90-1");
    await page.getByTestId("save-meter").click();
    await expect(page.getByTestId("meter-number")).toHaveText("12-34-5678-90-1");
    await expect(page.getByTestId("meter-serial")).toHaveValue("");

    await page.goto("/m/leases/new");
    await expect(page.getByTestId("tenant-name")).toHaveValue("");
    await expect(page.getByTestId("rent")).toHaveValue("");
    await expect(page.getByTestId("bill-total")).toHaveCount(0);
    await expect(page.getByTestId("usage")).toHaveCount(0);
    await expect(page.getByTestId("deposit-months")).toHaveValue("2");
    await expect(page.getByTestId("due-day")).toHaveValue("5");
    await expect(page.getByTestId("tenant-name")).toHaveAttribute("placeholder", /.+/);
    const room = page.getByTestId("lease-room");
    const roomValue = await room.locator("option", { hasText: "松德試用" }).first().getAttribute("value");
    await room.selectOption(roomValue ?? "");
    await page.getByTestId("wizard-next").click();
    await page.getByTestId("tenant-name").fill("試用房客");
    await page.getByTestId("tenant-phone").fill("+886912300002");
    await page.getByTestId("wizard-next").click();
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
    await page.getByTestId("start-date").fill(today);
    await page.getByTestId("term-months").fill("12");
    await page.getByTestId("rent").fill("12000");
    await expect(page.getByTestId("rent")).toHaveValue("12000");
    await page.getByTestId("wizard-next").click();
    await page.getByTestId("deposit-months").fill("2");
    await page.getByTestId("wizard-next").click();
    await page.getByTestId("due-day").fill("5");
    await page.getByTestId("wizard-next").click();

    await expect(page.getByTestId("utility-monthly-note")).toBeVisible();
    await expect(page.getByTestId("bill-total")).toHaveCount(0);
    await page.getByTestId("wizard-next").click();
    const template = page.getByTestId("lease-template");
    await expect(template).toHaveAttribute("data-lang", "zh-TW");
    await expect(template).toHaveAttribute("data-bilingual", "false");
    await expect(page.getByTestId("template-lang-zh")).toBeChecked();
    await expect(page.getByTestId("template-bilingual")).not.toBeChecked();
    await page.getByTestId("wizard-next").click();
    await page.getByTestId("submit-lease").click();
    await expect(page.getByTestId("lease-created")).toBeVisible();
    await page.locator(".tabsx a[href*='tab=sign']").click();

    const error = page.getByTestId("error-banner");
    if (await error.isVisible().catch(() => false)) {
      throw new Error(await error.innerText());
    }
    const simulate = page.getByTestId("simulate-tenant-sign");
    await expect(simulate).toBeVisible();
    await expect(simulate).toContainText(locale.simulate);
    await simulate.click();
    await page.getByTestId("sign-name").fill(locale.code === "en" ? "Ya-ting Lin" : "林雅婷");
    await page.getByTestId("sign-consent").check();
    await page.getByTestId("submit-sign").click();

    const record = page.getByTestId("record-payment");
    await expect(record).toBeVisible();
    await expect(record).toContainText(locale.pay);
    const rent = Number(await page.getByTestId("invoice-rent").getAttribute("data-minor"));
    const utility = Number(await page.getByTestId("invoice-utility").getAttribute("data-minor"));
    const deposit = Number(await page.getByTestId("invoice-deposit").getAttribute("data-minor"));
    await record.click();
    const amount = page.getByTestId("pay-amount");
    const due = Number(await amount.getAttribute("data-minor"));
    expect(due).toBe(rent + utility);
    expect(due).toBeLessThan(rent + utility + deposit);
    await expect(page.getByTestId("pay-last5")).toHaveValue("");
    if (locale.code === "zh-TW") {
      await page.screenshot({ path: "/opt/cursor/artifacts/record-payment.png", fullPage: true });
    }
    await page.getByTestId("pay-last5").fill("54321");
    await page.getByTestId("submit-payment").click();

    await page.goto("/m/bank");
    await page.getByTestId("fill-sample").click();
    await page.getByTestId("submit-import").click();
    await page.getByTestId("approve-match").first().click();
    if (locale.code === "zh-TW") {
      await page.screenshot({ path: "/opt/cursor/artifacts/bank-match.png", fullPage: true });
    }

    await page.goto("/m/statements");
    await page.getByTestId("statement-owner").selectOption({ label: "試用屋主" });
    await page.getByTestId("submit-statement").click();
    await expect(page.getByTestId("statement-rent")).toContainText("12,000");
    await expect(page.getByTestId("statement-fee")).toContainText("960");
    await expect(page.getByTestId("statement-rent")).not.toContainText("NT$0");
    await expect(page.getByTestId("tryout-panel")).toHaveCount(0);
    if (locale.code === "zh-TW") {
      await page.screenshot({ path: "/opt/cursor/artifacts/owner-statement.png", fullPage: true });
    }

    await page.goto("/m/statements");
    await page.getByTestId("statement-owner").selectOption({ label: "試用屋主" });
    await expect(page.getByTestId("submit-statement")).toHaveText(locale.regenerate);
  });
}

async function acceptReset(page: Page) {
  await page.waitForFunction(() => {
    const button = document.querySelector("[data-testid='reset-demo']");
    return Boolean(button && Object.keys(button).some((key) => key.startsWith("__reactProps")));
  });
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByTestId("reset-demo").click();
}

test("reset toast follows the locale", async ({ page }) => {
  await page.goto("/api/demo/locale?set=en&next=/m");
  await acceptReset(page);
  await expect(page.getByTestId("reset-toast")).toHaveText("Demo reset");
  await signIn(page, ACCOUNTS.admin);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m");
  await acceptReset(page);
  await expect(page.getByTestId("reset-toast")).toHaveText("已重設範例資料");
});

test("tenant picker, owner phone, and maintenance gate", async ({ page }) => {
  await page.goto("/api/demo/locale?set=zh-TW&next=/m");
  await page.screenshot({ path: "/opt/cursor/artifacts/dashboard.png", fullPage: true });
  await signIn(page, ACCOUNTS.tenant);
  await expect(page.getByTestId("liff-frame")).toBeVisible();
  await expect(page.getByTestId("lease-picker")).toBeVisible();
  await expect(page.getByTestId("lease-picker")).toContainText("松信住宅管理");
  await expect(page.getByTestId("lease-picker")).toContainText("海岸公寓管理");
  await expect(page.getByTestId("tenant-tile-pay")).toHaveText("繳租");
  await page.getByRole("button", { name: /松信住宅管理/ }).click();
  await expect(page.getByTestId("lease-picker")).toHaveCount(0);
  await page.getByTestId("tenant-tile-repair").click();
  await expect(page.getByTestId("repair-category")).toHaveValue("");
  await expect(page.getByTestId("repair-title")).toHaveValue("");
  await page.getByTestId("repair-title").fill("試用報修");
  await page.getByTestId("submit-repair").click();
  await expect(page.locator(".alert.ok")).toContainText("已送出");
  await page.screenshot({ path: "/opt/cursor/artifacts/tenant-liff.png", fullPage: true });

  await signIn(page, ACCOUNTS.owner);
  await page.goto("/o");
  const phone = page.getByRole("row", { name: /王小美/ }).getByTestId("tenant-phone");
  await expect(phone).toHaveAttribute("data-visible", "false");
  await expect(phone).not.toContainText("912111002");
  await page.screenshot({ path: "/opt/cursor/artifacts/owner-portal.png", fullPage: true });

  await signIn(page, ACCOUNTS.maintenance);
  await page.goto("/m/properties/new");
  await expect(page.getByTestId("forbidden")).toBeVisible();
  await expect(page.getByTestId("property-name")).toHaveCount(0);

  await signIn(page, ACCOUNTS.admin);
  await page.goto("/m");
  await expect(page.getByTestId("tryout-panel")).toHaveCount(0);
});

test("rent due notice shows rent only", async ({ page }) => {
  await signIn(page, ACCOUNTS.tenant2);
  await page.goto("/api/demo/locale?set=zh-TW&next=/t");
  const notice = page.getByTestId("rent-due-notice");
  await expect(notice).toContainText("租金即將到期");
  const amount = page.getByTestId("rent-due-amount");
  const deposit = page.getByTestId("rent-due-deposit");
  await expect(amount).toHaveAttribute("data-minor", "1200000");
  await expect(deposit).toHaveAttribute("data-minor", "2400000");
  await expect(amount).toHaveText("NT$12,000");
  await expect(amount).not.toContainText("36,000");
  await expect(deposit).toContainText("NT$24,000");
  await expect(deposit).toContainText("押金");
  await page.goto("/t/pay");
  await expect(page.locator("p.b")).toHaveText("NT$12,000");
  await page.goto("/t/lease");
  await expect(page.getByText("月租 NT$12,000")).toBeVisible();
  await expect(page.getByText("押金 NT$24,000")).toBeVisible();
});

test("manager phone width keeps a menu, contained tables, and the locale toggle", async ({ page }) => {
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/properties");
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 800 });
    const toggle = page.getByTestId("nav-toggle");
    await expect(toggle).toBeVisible();
    for (const id of ["locale-zh", "locale-en"]) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box, id).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    }
    await toggle.click();
    const nav = page.locator(".side a.it", { hasText: "物件" });
    await expect(nav).toBeVisible();
    const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    expect(fits).toBeTruthy();
    if (width === 390) {
      await page.screenshot({ path: "/opt/cursor/artifacts/manager-phone.png", fullPage: true });
    }
    await nav.click();
    await expect(page).toHaveURL(/\/m\/properties/);
    await expect(page.locator(".side")).toBeHidden();
  }
});

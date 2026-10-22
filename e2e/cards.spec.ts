import { expect, test, type Page } from "@playwright/test";
import { ACCOUNTS, resetDemo, signIn } from "./session";

const widths = [400, 480, 640, 960] as const;

const locales = [
  {
    code: "zh-TW" as const,
    owes: "本期淨額為負",
    reason: "本月費用高於已登記租金",
    labels: ["戶數", "本月租金（已登記）", "費用合計", "屋主淨額", "狀態"],
    rentLabels: ["租客", "月租", "本月應收", "已繳", "餘額", "狀態"],
    leaseLabels: ["物件／房間", "租期", "月租", "押金", "電費", "狀態"],
    dashLabels: ["物件／房間", "餘額"],
  },
  {
    code: "en" as const,
    owes: "Negative net this period",
    reason: "higher than recorded rent",
    labels: ["Units", "Rent recorded this month", "Total fees", "Owner net", "Status"],
    rentLabels: ["Tenant", "Rent", "Due", "Received", "Balance", "Status"],
    leaseLabels: ["Property / space", "Term", "Rent", "Deposit", "Electricity", "Status"],
    dashLabels: ["Property / space", "Balance"],
  },
];

test.use({
  hasTouch: false,
  isMobile: false,
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
});

test.beforeEach(async ({ page }) => {
  await resetDemo(page);
});

async function assertNoOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  const viewport = page.viewportSize();
  expect(viewport).toBeTruthy();
  const buttons = page.locator("a.btn, button.btn, button");
  const count = await buttons.count();
  for (let index = 0; index < count; index += 1) {
    const box = await buttons.nth(index).boundingBox();
    if (!box || box.width === 0 || box.height === 0) continue;
    expect(box.x).toBeGreaterThanOrEqual(-1);
    expect(box.x + box.width).toBeLessThanOrEqual((viewport?.width ?? 0) + 1);
  }
}

async function assertCards(page: Page, testId: string, labels: string[]) {
  const table = page.getByTestId(testId);
  await expect(table).toBeVisible();
  await expect(table.locator("thead")).toBeHidden();
  const mode = await table.evaluate((node) => getComputedStyle(node.querySelector("tbody tr") as HTMLElement).display);
  expect(mode).toBe("block");
  const titles = table.locator("tbody tr:not(.grp) td:first-child");
  const titleCount = await titles.count();
  expect(titleCount).toBeGreaterThan(0);
  for (let index = 0; index < titleCount; index += 1) {
    const box = await titles.nth(index).boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(80);
  }
  const labeled = table.locator("tbody tr:not(.grp)").first().locator("td[data-label]");
  const actual: string[] = [];
  const labelCount = await labeled.count();
  for (let index = 0; index < labelCount; index += 1) {
    actual.push((await labeled.nth(index).getAttribute("data-label")) ?? "");
  }
  expect(actual.filter(Boolean)).toEqual(labels);
  await assertNoOverflow(page);
}

for (const locale of locales) {
  for (const width of widths) {
    test(`card lists ${locale.code} ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/api/demo/locale?set=${locale.code}&next=/m/statements`);
      await expect(page.getByTestId("owner-owes").first()).toContainText(locale.owes);
      await expect(page.getByTestId("owner-owes").first()).toContainText("2,800");
      await expect(page.getByTestId("statement-list").locator("td.r .btn").first()).toBeVisible();
      const buttonWidth = await page.getByTestId("statement-list").locator("td.r .btn").first().evaluate((node) => node.getBoundingClientRect().width);
      const cellWidth = await page.getByTestId("statement-list").locator("td.r").first().evaluate((node) => node.getBoundingClientRect().width);
      expect(buttonWidth).toBeGreaterThan(cellWidth - 4);
      await assertCards(page, "statement-list", locale.labels);
      await page.screenshot({ path: `/opt/cursor/artifacts/cards-statements-${locale.code}-${width}.png`, fullPage: true });

      await page.goto("/m/rent");
      await expect(page.getByTestId("rent-roll").locator("tr.grp").first()).toBeVisible();
      await expect(page.getByText(locale.code === "zh-TW" ? "空房" : "Vacant").first()).toBeVisible();
      await expect(page.getByTestId("send-reminder").first()).toBeVisible();
      await assertCards(page, "rent-roll", locale.rentLabels);
      await page.screenshot({ path: `/opt/cursor/artifacts/cards-rent-${locale.code}-${width}.png`, fullPage: true });

      await page.goto("/m/leases");
      await assertCards(page, "lease-list", locale.leaseLabels);
      await page.screenshot({ path: `/opt/cursor/artifacts/cards-leases-${locale.code}-${width}.png`, fullPage: true });

      await page.goto("/m");
      await assertCards(page, "outstanding-list", locale.dashLabels);
      await assertCards(page, "expiring-list", [locale.dashLabels[0], locale.code === "zh-TW" ? "到期日" : "Ends"]);
      await page.screenshot({ path: `/opt/cursor/artifacts/cards-dashboard-${locale.code}-${width}.png`, fullPage: true });
    });
  }

  test(`owner owes copy ${locale.code}`, async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 900 });
    await page.goto(`/api/demo/locale?set=${locale.code}&next=/m/statements`);
    await page.getByTestId("owner-owes").first().locator("xpath=ancestor::tr").locator("a.btn").first().click();
    await expect(page.getByTestId("owner-owes")).toContainText(locale.owes);
    await expect(page.getByTestId("owner-owes")).toContainText("NT$2,800");
    await expect(page.getByTestId("statement-fee")).toHaveText("NT$0");
    const documentText = await page.getByTestId("statement-document").innerText();
    expect(documentText).toContain(locale.reason);
    if (locale.code === "zh-TW") expect(documentText).not.toContain("已收租金");
    expect(documentText).toContain("NT$0");
    expect(documentText).toContain("−NT$2,800");
    expect(documentText).not.toContain("-NT$");
    const reason = page.getByTestId("owner-owes-reason");
    await expect(reason).toHaveClass(/alert/);
    await expect(reason).toHaveClass(/warn/);
    await expect(reason).toContainText("⚠");
    await expect(reason).toContainText("−NT$2,800");
    await page.screenshot({ path: `/opt/cursor/artifacts/owner-owes-${locale.code}.png`, fullPage: true });

    await signIn(page, ACCOUNTS.owner);
    await page.goto(`/api/demo/locale?set=${locale.code}&next=/o/statements`);
    await expect(page.getByTestId("owner-owes")).toContainText(locale.owes);
    await expect(page.getByTestId("owner-owes")).toContainText("2,800");
    await page.screenshot({ path: `/opt/cursor/artifacts/owner-owes-portal-${locale.code}.png`, fullPage: true });
  });
}

test("wide content stays a table", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/statements");
  const table = page.getByTestId("statement-list");
  await expect(table.locator("thead")).toBeVisible();
  const display = await table.evaluate((node) => getComputedStyle(node.querySelector("tbody tr") as HTMLElement).display);
  expect(display).not.toBe("block");
});

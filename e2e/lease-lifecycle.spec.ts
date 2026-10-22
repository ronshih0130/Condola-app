import { Client } from "pg";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { resetDemo } from "./session";

const ORG = "10000000-0000-4000-8000-000000000001";

async function withDb<T>(run: (client: Client) => Promise<T>) {
  const client = new Client({
    connectionString: process.env.DATABASE_URL || "postgres://condola:condola@127.0.0.1:5432/condola",
  });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

const TENANT = "週期租客";
const START = "2026-11-01";
const END = "2026-12-31";
const MOVE_OUT = "2026-11-17";
const FORMULA = "NT$21,000 ÷ 30 × 17 天 ＝ NT$11,900";
const OVERRIDE_NOTE = "原金額 NT$11,900，已改為 NT$10,000";
const UNPAID = "未繳租金 2026年11月（1–17 日）";
const BANNED = ["房東", "房客", "收款", "收租", "入帳", "欠租", "已收", "代收", "本公司"];

async function roomValue(page: Page, label: string) {
  const options = page.getByTestId("lease-room").locator("option");
  const count = await options.count();
  for (let index = 0; index < count; index += 1) {
    const text = (await options.nth(index).innerText()).replace(/\s+/g, " ").trim();
    if (text.endsWith(` ${label}`)) return options.nth(index).getAttribute("value");
  }
  throw new Error(`no room ${label}`);
}

async function createExpiringLease(page: Page, rent = "21000") {
  await page.goto("/m/leases/new");
  const value = await roomValue(page, "C");
  await page.getByTestId("lease-room").selectOption(value ?? "");
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("tenant-name").fill(TENANT);
  await page.getByTestId("tenant-phone").fill("0912000893");
  await page.getByTestId("tenant-email").fill("lifecycle.qa@example.com");
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("start-date").fill(START);
  await page.getByTestId("term-months").fill("2");
  await page.getByTestId("rent").fill(rent);
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("deposit-months").fill("2");
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("due-day").fill("5");
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("utility-monthly-note")).toBeVisible();
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("lease-template")).toBeVisible();
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("submit-lease")).toBeEnabled();
  await page.getByTestId("submit-lease").click();
  await expect(page).toHaveURL(/\/m\/leases\/[0-9a-f-]{36}\?created=1$/);
  const error = page.getByTestId("error-banner");
  if (await error.isVisible().catch(() => false)) throw new Error(await error.innerText());
  return page.url().split("?")[0];
}

async function signLease(page: Page, leaseUrl: string) {
  await page.goto(`${leaseUrl}?tab=sign`);
  await page.getByTestId("simulate-tenant-sign").click();
  await expect(page.getByText("租客已簽署")).toBeVisible();
  await page.getByTestId("sign-name").fill("林雅婷");
  await page.getByTestId("sign-consent").check();
  await page.getByTestId("submit-sign").click();
  await expect(page).toHaveURL(new RegExp(`${leaseUrl.split("/").pop()}\\?tab=ledger$`));
  await page.getByRole("link", { name: "摘要" }).click();
  await expect(page.getByText("生效中")).toBeVisible();
}

function rowFor(page: Page, name: string) {
  return page.getByTestId("expiring-row").filter({ hasText: name });
}

async function expectClean(locator: Locator) {
  const body = await locator.innerText();
  for (const word of BANNED) expect(body.includes(word), word).toBe(false);
}

test("a beta org renews inside 90 days and settles move-out with the overridden rent", async ({ page }) => {
  await resetDemo(page);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/leases");
  await page.getByTestId("expiring-entry").click();
  await expect(page.getByTestId("expiring-window")).toHaveText("90 天內到期");
  await expect(page.getByTestId("expiring-empty")).toContainText("90 天內沒有到期的租約");
  await expect(page.getByTestId("expiring-empty")).toContainText("租約到期前 90 天會出現在這裡。");

  const leaseUrl = await createExpiringLease(page);
  await expect(page.getByTestId("summary-period")).toHaveAttribute("data-start", START);
  await expect(page.getByTestId("summary-period")).toHaveAttribute("data-end", END);
  await expect(page.getByTestId("summary-rent")).toHaveText("NT$21,000");
  await expect(page.getByTestId("summary-deposit")).toHaveText("NT$42,000");
  await signLease(page, leaseUrl);
  await expect(page.getByTestId("summary-period")).toHaveAttribute("data-end", END);

  await page.goto("/m/leases/expiring");
  const undecided = rowFor(page, TENANT);
  await expect(undecided.getByTestId("expiring-status-label")).toHaveText("未決定");
  await expect(undecided.getByTestId("row-renew")).toHaveText("續約");
  await expect(undecided.getByTestId("row-moveout")).toHaveText("退租");
  await undecided.getByTestId("row-renew").click();

  await expect(page.getByTestId("renew-due-day")).toHaveValue("5");
  await expect(page.getByTestId("renew-due-day").locator("option")).toHaveCount(28);
  await expect(page.getByTestId("renew-due-day").locator("option").first()).toHaveText("每月 1 日繳租");
  await expect(page.getByTestId("renew-due-day").locator("option").last()).toHaveText("每月 28 日繳租");
  await expect(page.getByTestId("renew-due-day").locator("option:checked")).toHaveText("每月 5 日繳租");
  await page.getByTestId("renew-due-day").selectOption("28");
  await page.getByTestId("renew-rent").fill("22000");
  await page.getByTestId("renew-deposit").fill("44000");
  await expect(page.getByTestId("deposit-increase")).toHaveText("押金差額 NT$2,000，款項到帳後請在繳租紀錄登記為「押金」。");
  await page.getByTestId("renew-next").click();
  await expect(page.getByTestId("renew-confirm")).toContainText("確認續約");
  await expect(page.getByTestId("confirm-old")).toHaveText(`${END} 結束後保留為歷史紀錄`);
  await expect(page.getByTestId("confirm-rent")).toHaveText("NT$22,000");
  await expect(page.getByTestId("confirm-due-day")).toHaveText("每月 28 日繳租");
  await page.getByTestId("renew-create").click();
  await expect(page.getByTestId("renewal-created")).toHaveText("新租約已建立，2027年1月 起的帳單會依新租金產生。");
  const dueDay = await withDb(async (client) => {
    const row = await client.query<{ due_day: number }>(
      `SELECT due_day FROM leases WHERE org_id = $1 AND renewed_from_id = $2`,
      [ORG, leaseUrl.split("/").pop()],
    );
    return row.rows[0]?.due_day;
  });
  expect(dueDay).toBe(28);

  await page.goto(leaseUrl);
  await expect(page.getByText("生效中")).toBeVisible();
  await expect(page.getByTestId("summary-period")).toHaveAttribute("data-end", END);

  await page.goto("/m/leases/expiring");
  const renewing = rowFor(page, TENANT);
  await expect(renewing.getByTestId("expiring-status-label")).toHaveText("續約中");
  await expect(renewing).toContainText("新租約待簽");
  await renewing.getByTestId("row-moveout").click();

  await page.getByTestId("move-out-date").fill(MOVE_OUT);
  await page.getByTestId("move-out-reason").selectOption("early");
  await expect(page.getByTestId("rent-formula")).toHaveText(FORMULA);
  await expect(page.getByTestId("mid-term-hint")).toHaveText("退租日在租期中：2026年11月 租金按天數計算為 NT$11,900，帳單會自動更新。");
  await page.getByTestId("move-out-rent").fill("10000");
  await expect(page.getByTestId("override-note")).toHaveText(OVERRIDE_NOTE);
  await expect(page.getByTestId("mid-term-hint")).toContainText("NT$11,900");
  await page.getByTestId("moveout-next").click();
  await expect(page.getByTestId("handover-at")).toHaveValue(`${MOVE_OUT}T10:00`);
  await page.getByTestId("schedule-moveout").click();

  await expect(page).toHaveURL(new RegExp(`${leaseUrl.split("/").pop()}/settlement$`));
  await expect(page.getByTestId("rent-formula")).toHaveText(FORMULA);
  await expect(page.getByTestId("override-note")).toHaveText(OVERRIDE_NOTE);
  await expect(page.getByTestId("override-stamp")).toHaveText(/已手動修改（林雅婷・\d{4}-\d{2}-\d{2} \d{2}:\d{2}）/);
  const unpaid = page.getByTestId("settlement-line").filter({ hasText: UNPAID });
  await expect(unpaid).toContainText("NT$10,000");
  await expect(page.getByTestId("settlement-deposit")).toHaveText("NT$42,000");

  await page.getByTestId("deduction-amount").fill("50000");
  await page.getByTestId("deduction-item").fill("暫時扣款");
  await page.getByTestId("add-deduction-submit").click();
  await expect(page.getByTestId("shortfall")).toContainText("押金不足扣抵");
  await expect(page.getByTestId("shortfall-body")).toHaveText("扣款超過押金，租客還需補付 NT$18,000");
  await expect(page.getByText("租客還需補付屋主")).toBeVisible();
  await expect(page.getByTestId("shortfall-amount")).toHaveText("NT$18,000");
  await page.getByTestId("remove-deduction").click();
  await expect(page.getByTestId("shortfall")).toHaveCount(0);

  await page.getByTestId("deduction-amount").fill("3000");
  await page.getByTestId("deduction-item").fill("牆面");
  await page.getByTestId("deduction-photos").setInputFiles({
    name: "wall.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  });
  await page.getByTestId("add-deduction-submit").click();
  await expect(page.getByTestId("settlement-line").filter({ hasText: "修繕：牆面（附照片 1 張）" })).toContainText("NT$3,000");

  await page.getByTestId("deduction-kind").selectOption("electricity");
  await page.getByTestId("deduction-amount").fill("860");
  await page.getByTestId("add-deduction-submit").click();
  await expect(page.getByTestId("settlement-line").filter({ hasText: "電費（租期內最後一期）" })).toContainText("NT$860");
  await expect(page.getByTestId("refund-amount")).toHaveText("NT$28,140");
  await expect(page.getByText("屋主應退還租客")).toBeVisible();
  await expect(page.getByTestId("money-disclaimer")).toHaveText("Condola 只提供管理軟體，不經手任何款項。");
  await page.getByTestId("confirm-settlement").click();

  await expect(page.getByTestId("moveout-done")).toBeVisible();
  await expect(page.getByTestId("moveout-done")).toContainText(`${TENANT} 已於 ${MOVE_OUT} 退租。押金結算已登記，物件改為空房。`);
  await expect(page.getByText("2026年11月 租金")).toBeVisible();
  await expect(page.getByTestId("done-rent")).toHaveText("NT$10,000");
  await expect(page.getByText("屋主退還租客")).toBeVisible();
  await expect(page.getByTestId("done-refund")).toHaveText("NT$28,140");
  await expect(page.getByTestId("done-refund-date")).toContainText("（已登記）");
  await expect(page.getByTestId("moveout-done")).toContainText("之後列為「電費（空房／未簽約）」");
  await expect(page.getByTestId("download-settlement-pdf")).toHaveText("下載押金結算單 PDF");
  await expect(page.getByTestId("money-disclaimer")).toHaveText("Condola 只提供管理軟體，不經手任何款項。");
  await expectClean(page.locator("body"));

  const pdf = await page.request.get(`/api/pdf/settlements/${leaseUrl.split("/").pop()}`);
  expect(pdf.ok()).toBeTruthy();
  const document = (await pdf.json()) as { title: string; footerLabel: string; blocks: Array<{ lines?: string[] }> };
  expect(document.title).toBe(`押金結算：${TENANT}`);
  expect(document.footerLabel).toBe("Condola 只提供管理軟體，不經手任何款項。");
  expect(JSON.stringify(document)).toContain("2026年11月 租金");
  expect(JSON.stringify(document)).toContain("NT$10,000");

  await page.goto(leaseUrl);
  await expect(page.getByText("已結束")).toBeVisible();
  await expect(page.getByTestId("summary-period")).toHaveAttribute("data-end", MOVE_OUT);
  await page.goto("/m/leases/expiring");
  await expect(page.getByTestId("expiring-empty")).toContainText("90 天內沒有到期的租約");
});

test("the sample company lists leases expiring within 90 days", async ({ page }) => {
  await resetDemo(page);
  const sandbox = "/api/env?set=sandbox&next=" + encodeURIComponent("/m/leases/expiring");
  await page.goto("/api/demo/locale?set=zh-TW&next=" + encodeURIComponent(sandbox));
  await expect(page.getByTestId("org-switch")).toContainText("範例公司");
  const sandboxFlag = await withDb(async (client) => {
    const row = await client.query<{ flag: string }>(
      `SELECT feature_flags->>'lease_lifecycle' AS flag
         FROM organizations
        WHERE live_org_id = $1 AND environment = 'sandbox'`,
      [ORG],
    );
    return row.rows[0]?.flag;
  });
  expect(sandboxFlag).toBe("true");
  await expect(page.getByTestId("expiring-window")).toHaveText("90 天內到期");
  await expect(page.getByTestId("expiring-empty")).toHaveCount(0);
  const sample = rowFor(page, "試測一二（範例）");
  await expect(sample.getByTestId("row-renew")).toHaveText("續約");
  await expect(sample.getByTestId("row-moveout")).toHaveText("退租");
  await expectClean(page.locator("body"));
});

test("move-out rent rounds 月租 ÷ 30 × days, including the last day, to a whole NT$", async ({ page }) => {
  await resetDemo(page);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/leases");
  const leaseUrl = await createExpiringLease(page, "10000");
  await signLease(page, leaseUrl);
  await page.goto("/m/leases/expiring");
  await rowFor(page, TENANT).getByTestId("row-moveout").click();
  await page.getByTestId("move-out-date").fill(MOVE_OUT);
  await page.getByTestId("move-out-reason").selectOption("early");
  await expect(page.getByTestId("rent-formula")).toHaveText("NT$10,000 ÷ 30 × 17 天 ＝ NT$5,667");
  await page.getByTestId("move-out-rent").fill("5000");
  await expect(page.getByTestId("override-note")).toHaveText("原金額 NT$5,667，已改為 NT$5,000");
});

test("feature_flags.lease_lifecycle is on for beta and off for pro", async ({ page }) => {
  await resetDemo(page);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/leases");
  const beta = await withDb((client) =>
    client.query<{ flag: string }>(`SELECT feature_flags->>'lease_lifecycle' AS flag FROM organizations WHERE id = $1 AND plan_tier = 'beta'`, [ORG]),
  );
  expect(beta.rows[0]?.flag).toBe("true");
  await expect(page.getByTestId("expiring-entry")).toBeVisible();

  await withDb((client) => client.query(`UPDATE organizations SET plan_tier = 'pro' WHERE id = $1`, [ORG]));
  const pro = await withDb((client) =>
    client.query<{ flag: string }>(`SELECT feature_flags->>'lease_lifecycle' AS flag FROM organizations WHERE id = $1 AND plan_tier = 'pro'`, [ORG]),
  );
  expect(pro.rows[0]?.flag).toBe("false");
  await page.goto("/m/leases");
  await expect(page.getByTestId("expiring-entry")).toHaveCount(0);
  await page.goto("/m/leases/expiring");
  await expect(page.getByTestId("not-found")).toBeVisible();
  await expect(page.getByTestId("expiring-window")).toHaveCount(0);
});

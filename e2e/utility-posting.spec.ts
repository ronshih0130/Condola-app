import { expect, test } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { Client } from "pg";
import { disposableDbUrl } from "../src/server/test-disposable-db";
import { SESSION_COOKIE } from "../src/server/auth";
import { ORG_ID } from "../src/server/ids";
import { ACCOUNTS, finishConsentGate, resetDemo, signIn } from "./session";

test("a manager confirms 電費 and the tenant sees it on the bill", async ({ page }) => {
  await resetDemo(page);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/units");

  for (const room of ["A", "B"]) {
    await page.getByTestId(`space-row-3F-${room}`).getByRole("link", { name: "編輯" }).click();
    await page.getByTestId("space-electricity").selectOption("submeter");
    await page.getByTestId("space-rate").fill("4");
    await page.getByTestId("save-space").click();
    await expect(page.getByTestId(`space-row-3F-${room}`)).toContainText("分表");
  }

  await page.goto("/m/rent");
  await page.getByTestId("utility-entry").click();
  await expect(page.getByTestId("utility-month")).toBeVisible();
  await expect(page.getByTestId("utility-form")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("房東");
  await page.getByTestId("utility-rate").fill("4");
  await page.getByTestId("kwh-prev-A").fill("0");
  await page.getByTestId("kwh-curr-A").fill("100");
  await page.getByTestId("kwh-prev-B").fill("0");
  await page.getByTestId("kwh-curr-B").fill("50");
  await page.getByTestId("utility-preview").click();
  await expect(page.getByTestId("utility-review")).toBeVisible();
  await expect(page.getByTestId("utility-confirm")).toBeVisible();
  await expect(page.getByTestId("utility-confirm")).toHaveText("確認登記電費");
  await expect(page.getByTestId("utility-repost")).toHaveCount(0);
  await expect(page.getByTestId("utility-share-desc").nth(0)).toContainText("電費 100 度 × 4 元");
  await expect(page.getByTestId("utility-share-desc").nth(1)).toContainText("電費 50 度 × 4 元");
  await page.getByTestId("utility-confirm").click();
  await expect(page.getByTestId("utility-saved")).toContainText("電費已記入租客本期帳單");
  await expect(page.getByTestId("utility-posted-lock")).toContainText("這期電費已登記，新租約不會改動金額");
  await expect(page.getByTestId("utility-confirm")).toHaveCount(0);
  await page.getByTestId("kwh-curr-A").fill("90");
  await page.getByTestId("utility-preview").click();
  await expect(page.getByTestId("utility-status")).toContainText("待重新登記");
  await expect(page.getByTestId("utility-repost")).toContainText("這個月的電費已登記過");
  await page.getByTestId("kwh-prev-A").fill("0");
  await page.getByTestId("kwh-curr-A").fill("100");
  await page.getByTestId("kwh-prev-B").fill("0");
  await page.getByTestId("kwh-curr-B").fill("50");
  await page.getByTestId("utility-preview").click();
  await expect(page.getByTestId("utility-status")).toContainText("待重新登記");
  await page.getByTestId("utility-confirm").click();
  await expect(page.getByTestId("utility-status")).toContainText("電費已登記");

  await page.goto("/m/leases");
  await page.getByRole("link", { name: "王小美" }).click();
  await page.getByRole("link", { name: "帳務" }).click();
  await expect(page.getByTestId("invoice-utility-line")).toContainText("電費 100 度 × 4 元");
  await expect(page.getByTestId("invoice-utility")).toHaveAttribute("data-minor", "40000");
  await expect(page.locator("body")).not.toContainText("房東");

  await signIn(page, ACCOUNTS.tenant2);
  await page.goto("/api/demo/locale?set=zh-TW&next=/t/pay");
  await expect(page.getByTestId("tenant-utility-line")).toContainText("電費 100 度 × 4 元");
  await expect(page.locator("body")).not.toContainText("房東");
});

test("平均分攤 saves from the property wizard and splits the bill with no room readings", async ({ page }) => {
  await resetDemo(page);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/properties/new");
  await page.getByTestId("property-name").fill("松德電費");
  await page.getByTestId("property-city").fill("台北市");
  await page.getByTestId("property-district").fill("松山區");
  await page.getByTestId("property-street").fill("松德路");
  await page.getByText("新屋主", { exact: true }).click();
  await page.getByTestId("owner-name").fill("電費屋主");
  await page.getByTestId("owner-phone").fill("0912000888");
  await page.getByTestId("wizard-next").click();
  await page.getByText("分房出租", { exact: true }).click();
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("unit-floor").fill("3F");
  await expect(page.getByTestId("unit-label")).toHaveValue("3F");
  await page.getByTestId("add-room").click();
  await page.getByTestId("add-room").click();
  for (const [index, label] of ["A", "B", "C"].entries()) {
    await page.getByTestId(`room-${index}-label`).fill(label);
    await page.getByTestId(`room-${index}-rent`).fill("12000");
    await page.getByTestId(`room-${index}-type`).selectOption("suite");
  }
  await page.getByTestId("wizard-next").click();
  await expect(page.locator('input[name="bill"]')).toHaveCount(0);
  await expect(page.locator('input[name="usage"]')).toHaveCount(0);
  await page.getByTestId("property-split").selectOption("owner");
  await expect(page.getByTestId("property-rate")).toHaveCount(0);
  await expect(page.getByTestId("property-electricity-preview")).toHaveCount(0);
  await page.getByTestId("property-split").selectOption("even");
  await page.getByTestId("property-rate").fill("5");
  await expect(page.getByTestId("property-split")).toHaveValue("even");
  await expect(page.getByTestId("property-electricity-preview")).toHaveCount(0);
  await expect(page.getByText("台電帳單金額和各房度數每月在『電費已登記』填寫", { exact: true })).toBeVisible();
  await page.getByTestId("submit-property").click();
  await expect(page.getByRole("heading", { name: "松德電費" })).toBeVisible();

  await page.goto("/m/rent/utilities");
  await page.getByTestId("utility-unit").selectOption({ label: "松德電費 · 3F" });
  await page.getByTestId("utility-month-form").getByRole("button", { name: "查看這個月" }).click();
  await expect(page.getByTestId("utility-method")).toContainText("平均分攤");
  await expect(page.getByTestId("utility-method")).toContainText("修改物件電費設定");
  await expect(page.getByTestId("kwh-prev-A")).toHaveCount(0);
  await expect(page.getByTestId("utility-bill")).toBeVisible();
  await expect(page.getByTestId("utility-total-kwh")).toBeVisible();
  await page.getByTestId("utility-rate").fill("5");
  await page.getByTestId("utility-bill").fill("3000");
  await page.getByTestId("utility-preview").click();
  await expect(page.getByTestId("utility-review")).toBeVisible();
  await expect(page.getByTestId("error-banner")).toHaveCount(0);
  await expect(page.getByTestId("utility-gap")).toHaveCount(0);
  await expect(page.getByTestId("utility-share")).toHaveCount(3);
  await page.getByTestId("utility-bill").fill("3000");
  await page.getByTestId("utility-total-kwh").fill("100");
  await page.getByTestId("utility-preview").click();
  await expect(page.getByTestId("utility-review")).toBeVisible();
  await expect(page.getByTestId("utility-gap-warn")).toContainText("請檢查每度電價");
  await expect(page.getByTestId("utility-gap")).toHaveCount(0);
  await expect(page.getByTestId("utility-share")).toHaveCount(3);
  const ownerShares = page.getByTestId("utility-share").filter({ hasText: "電費（空房／未簽約）" });
  await expect(ownerShares).toHaveCount(3);
  await expect(ownerShares.nth(0)).toContainText("NT$1,000");
  await expect(ownerShares.nth(1)).toContainText("NT$1,000");
  await expect(ownerShares.nth(2)).toContainText("NT$1,000");
  await expect(page.getByTestId("utility-share-desc").first()).toContainText("電費（平均分攤）");
});

test("公共用電 and 帳單差額 show as separate owner lines with a rate warning", async ({ page }) => {
  await resetDemo(page);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/units");
  for (const room of ["A", "B", "C"]) {
    await page.getByTestId(`space-row-3F-${room}`).getByRole("link", { name: "編輯" }).click();
    await page.getByTestId("space-electricity").selectOption("submeter");
    await page.getByTestId("space-rate").fill("5");
    await page.getByTestId("save-space").click();
    await expect(page.getByTestId(`space-row-3F-${room}`)).toContainText("分表");
  }

  await page.goto("/m/rent/utilities");
  await page.getByTestId("utility-unit").selectOption({ label: "信義松仁 · 3F" });
  await page.getByTestId("utility-month-form").getByRole("button", { name: "查看這個月" }).click();
  await page.getByTestId("utility-rate").fill("5");
  await page.getByTestId("utility-bill").fill("500");
  await page.getByTestId("utility-total-kwh").fill("160");
  await page.getByTestId("kwh-prev-A").fill("0");
  await page.getByTestId("kwh-curr-A").fill("100");
  await page.getByTestId("kwh-prev-B").fill("0");
  await page.getByTestId("kwh-curr-B").fill("50");
  await page.getByTestId("kwh-prev-C").fill("0");
  await page.getByTestId("kwh-curr-C").fill("20");
  await page.getByTestId("utility-preview").click();
  await expect(page.getByTestId("utility-public-warn")).toContainText("分表加總超過台電總度數");
  await expect(page.getByTestId("utility-gap-warn")).toContainText("請檢查每度電價");
  await expect(page.getByTestId("utility-public")).toContainText("公共用電");
  await expect(page.getByTestId("utility-public")).toContainText("-NT$50");
  await expect(page.getByTestId("utility-gap")).toContainText("電費（帳單差額）");
  await expect(page.getByTestId("utility-gap")).toContainText("-NT$300");
  await expect(page.getByTestId("utility-share").filter({ hasText: "電費（空房／未簽約）" })).toContainText("NT$100");
});

test("countersign of a pending lease does not bill the electricity posted while it was unsigned", async ({ page }) => {
  await resetDemo(page);
  await page.goto("/api/demo/locale?set=zh-TW&next=/m/units");
  for (const room of ["A", "B", "C"]) {
    await page.getByTestId(`space-row-3F-${room}`).getByRole("link", { name: "編輯" }).click();
    await page.getByTestId("space-electricity").selectOption("submeter");
    await page.getByTestId("space-rate").fill("4");
    await page.getByTestId("save-space").click();
    await expect(page.getByTestId(`space-row-3F-${room}`)).toContainText("分表");
  }

  await page.goto("/m/leases/new");
  const room = page.getByTestId("lease-room");
  const vacant = room.locator("option", { hasText: "3F C" });
  await expect(vacant).toHaveCount(1);
  await room.selectOption((await vacant.getAttribute("value")) ?? "");
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("tenant-name").fill("待副署租客");
  await page.getByTestId("tenant-phone").fill("+886912300166");
  await page.getByTestId("wizard-next").click();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
  await page.getByTestId("start-date").fill(today);
  await page.getByTestId("term-months").fill("12");
  await page.getByTestId("rent").fill("10000");
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("wizard-next").click();
  await expect(page.getByTestId("utility-monthly-note")).toBeVisible();
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("wizard-next").click();
  await page.getByTestId("submit-lease").click();
  await expect(page).toHaveURL(/\/m\/leases\/[0-9a-f-]{36}\?created=1/);
  const leaseUrl = page.url().split("?")[0];

  await page.goto("/m/rent/utilities");
  await page.getByTestId("utility-unit").selectOption({ label: "信義松仁 · 3F" });
  await page.getByTestId("utility-month-form").getByRole("button", { name: "查看這個月" }).click();
  await page.getByTestId("utility-rate").fill("4");
  await page.getByTestId("kwh-prev-A").fill("0");
  await page.getByTestId("kwh-curr-A").fill("10");
  await page.getByTestId("kwh-prev-B").fill("0");
  await page.getByTestId("kwh-curr-B").fill("10");
  await page.getByTestId("kwh-prev-C").fill("0");
  await page.getByTestId("kwh-curr-C").fill("100");
  await page.getByTestId("utility-preview").click();
  await expect(page.getByTestId("utility-confirm")).toBeVisible();
  await expect(page.getByTestId("utility-confirm")).toHaveText("確認登記電費");
  await page.getByTestId("utility-confirm").click();
  await expect(page.getByTestId("utility-status")).toContainText("電費已登記");

  await page.goto(`${leaseUrl}?tab=sign`);
  await expect(page.getByTestId("idv-sign-wait")).toBeVisible();
  await expect(page.getByTestId("simulate-tenant-sign")).toHaveCount(0);
  const leaseId = new URL(leaseUrl).pathname.split("/").at(-1);
  const identity = await page.request.post("/api/demo/id-sample", { data: { leaseId } });
  expect(identity.ok()).toBe(true);
  await page.reload();
  await expect(page.getByTestId("simulate-tenant-sign")).toHaveCount(0);
  // Authenticate the actual newly created primary tenant, with an ephemeral
  // local test session. This exercises readSession/consent, not password login.
  const db = new Client({ connectionString: disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE).href });
  await db.connect();
  let tenantSessionId: string | undefined;
  try {
    const subject = (await db.query<{ user_id: string; org_id: string }>(`SELECT c.user_id::text,l.org_id::text FROM leases l JOIN lease_parties p ON p.lease_id=l.id AND p.org_id=l.org_id AND p.role='primary' JOIN contacts c ON c.id=p.contact_id AND c.org_id=l.org_id WHERE l.id=$1`, [leaseId])).rows;
    expect(subject).toHaveLength(1);
    expect(subject[0].user_id).toBeTruthy();
    expect(subject[0].org_id).toBe(ORG_ID);
    const token = randomBytes(32).toString("hex");
    tenantSessionId = (await db.query<{ id: string }>(`INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,clock_timestamp()+interval '15 minutes') RETURNING id::text`, [subject[0].user_id, createHash("sha256").update(token).digest("hex")])).rows[0].id;
    await page.context().clearCookies();
    await page.context().addCookies([{ name: SESSION_COOKIE, value: token, url: new URL(leaseUrl).origin, httpOnly: true }]);
    await page.goto("/t");
    await finishConsentGate(page);
    const signed = await page.request.post("/api/flows/signLease", { data: { leaseId, signedName: "待副署租客", consent: true } });
    expect(signed.ok()).toBe(true);
    expect(await signed.json()).toMatchObject({ ok: true, result: { esign: "partially_signed" } });
    const events = (await db.query<{ actor: string; event: string }>(`SELECT e.actor_user_id::text AS actor,e.event FROM lease_signature_events e JOIN lease_signatures s ON s.id=e.signature_id WHERE s.lease_id=$1 AND s.signer_role='tenant' AND e.event IN ('viewed_document','consented','signed') ORDER BY e.id`, [leaseId])).rows;
    expect(events).toEqual(["viewed_document", "consented", "signed"].map(event => ({ actor: subject[0].user_id, event })));
  } finally {
    if (tenantSessionId) await db.query(`DELETE FROM auth_sessions WHERE id=$1`, [tenantSessionId]);
    await db.end();
  }
  await signIn(page, ACCOUNTS.admin);
  await page.goto(`${leaseUrl}?tab=sign`);
  await expect(page.getByText("租客已簽署")).toBeVisible();
  await expect(page.getByTestId("error-banner")).toHaveCount(0);
  await page.getByTestId("sign-name").fill("管理方");
  await page.getByTestId("sign-consent").check();
  await page.getByTestId("submit-sign").click();
  await expect(page).toHaveURL(new RegExp(`${leaseUrl.split("/").pop()}\\?tab=ledger$`));
  await expect(page).not.toHaveURL(/error=/);
  await expect(page.getByTestId("error-banner")).toHaveCount(0);
  await expect(page.getByTestId("invoice-utility-line")).toHaveCount(0);
  await expect(page.getByTestId("invoice-rent")).toBeVisible();
  await expect(page.getByTestId("invoice-deposit")).toBeVisible();
  await page.getByRole("link", { name: "摘要" }).click();
  await expect(page.getByText("生效中")).toBeVisible();
});

import assert from "node:assert/strict";
import test from "node:test";
import { makeT } from "@/i18n";
import { statementPeriodNet } from "@/server/format";
import {
  buildLeasePdf,
  buildStatementPdf,
  canDownloadLeasePdf,
  canDownloadStatementPdf,
  type LeasePdfSource,
  type StatementPdfSource,
} from "@/server/pdf-docs";
import type { Session } from "@/server/types";

const HASH = "ab".repeat(32);

function session(kind: Session["kind"], role: Session["role"]): Session {
  return {
    userId: "20000000-0000-4000-8000-000000000001",
    sessionId: "pdf",
    email: "pdf@test",
    name: "Pdf",
    kind,
    role,
    orgId: "10000000-0000-4000-8000-000000000001",
    liveOrgId: "10000000-0000-4000-8000-000000000001",
    environment: "live",
    locale: "zh-TW",
    calendar: "gregorian",
    leaseId: null,
  };
}

function lease(overrides: Partial<LeasePdfSource> = {}): LeasePdfSource {
  return {
    id: "10000000-0000-4000-8000-000000000099",
    orgId: "10000000-0000-4000-8000-000000000001",
    documentSha256: HASH,
    currency: "TWD",
    rentMinor: 1_000_000,
    depositMinor: 3_000_000,
    depositMonths: "3.00",
    depositOverrideReason: "屋主同意兩個月以上押金",
    dueDay: 5,
    rentFrequency: "monthly",
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    place: "信義松仁 3F A",
    tenant: "張雅文",
    ownerName: "陳建宏",
    address: { city: "台北市", district: "信義區", street: "松仁路88號" },
    addressDisplay: "台北市信義區松仁路88號",
    floor: "3",
    roomLabel: "A",
    scope: "partial",
    electricityMethod: "submeter",
    ratePerKwh: "4",
    bankName: "玉山銀行",
    ...overrides,
  };
}

test("lease and statement PDFs follow the same roles as the pages", () => {
  assert.equal(canDownloadLeasePdf(session("staff", "manager")), true);
  assert.equal(canDownloadLeasePdf(session("staff", "admin")), true);
  assert.equal(canDownloadLeasePdf(session("staff", "accountant")), true);
  assert.equal(canDownloadLeasePdf(session("staff", "maintenance")), false);
  assert.equal(canDownloadLeasePdf(session("tenant", null)), true);
  assert.equal(canDownloadLeasePdf(session("owner", null)), false);

  assert.equal(canDownloadStatementPdf(session("staff", "manager")), true);
  assert.equal(canDownloadStatementPdf(session("staff", "accountant")), true);
  assert.equal(canDownloadStatementPdf(session("staff", "maintenance")), false);
  assert.equal(canDownloadStatementPdf(session("owner", null)), true);
  assert.equal(canDownloadStatementPdf(session("tenant", null)), false);
});

test("a lease PDF prints the official form, the deposit reason, and the stored hash", () => {
  const doc = buildLeasePdf(lease(), makeT("zh-TW"));
  const text = JSON.stringify(doc);
  const sublessor = "二" + "房東";
  assert.equal(doc.title, "住宅租賃契約書範本");
  assert.equal(doc.footerHash, HASH);
  assert.equal(doc.footerLabel, "租約紀錄雜湊");
  assert.match(text, /紙本簽署/);
  assert.match(text, /承租人/);
  assert.match(text, /出租人/);
  assert.match(text, /陳建宏/);
  assert.match(text, /張雅文/);
  assert.match(text, /信義松仁 3F A/);
  assert.match(text, /押金調整原因/);
  assert.match(text, /屋主同意兩個月以上押金/);
  assert.match(text, /第一條/);
  assert.match(text, /第二十三條/);
  assert.match(text, /10,000元整/);
  assert.match(text, /30000元整/);
  assert.equal(text.includes(sublessor), true);
  assert.equal(text.split(sublessor).join("").includes("房東"), false);
  assert.equal(text.includes("3.00"), false);
  assert.equal(text.includes("難以繼續居住"), false);
});

test("a missing hash is labeled and omitted fields stay blank", () => {
  const doc = buildLeasePdf(
    lease({
      documentSha256: "  ",
      depositOverrideReason: null,
      ownerName: null,
      tenant: "",
      bankName: null,
      electricityMethod: null,
      ratePerKwh: null,
      endDate: null,
    }),
    makeT("zh-TW"),
  );
  const text = JSON.stringify(doc);
  assert.equal(doc.footerHash, "");
  assert.equal(doc.footerLabel, "租約紀錄雜湊尚未產生");
  assert.equal(text.includes("押金調整原因"), false);
  assert.match(text, /民國__年__月__日經承租人攜回審閱__日/);
  assert.match(text, /□所有權人□轉租人/);
  assert.match(text, /至民國     年     月     日止/);
  assert.match(text, /第一條/);
});

test("an English lease PDF localizes the paper note and keeps the official clauses", () => {
  const doc = buildLeasePdf(lease(), makeT("en"));
  const text = JSON.stringify(doc);
  const sublessor = "二" + "房東";
  assert.match(text, /This copy is for signing on paper/);
  assert.match(text, /Reason for the deposit/);
  assert.match(text, /第一條/);
  assert.match(text, /承租人/);
  assert.equal(doc.footerHash, HASH);
  assert.equal(doc.footerLabel, "Stored lease record hash");
  assert.equal(text.includes(sublessor), true);
  assert.equal(text.split(sublessor).join("").includes("房東"), false);
});

test("a shortfall statement says 本期淨額為負 and keeps the signed closing", () => {
  const source: StatementPdfSource = {
    id: "10000000-0000-4000-8000-000000000088",
    orgId: "10000000-0000-4000-8000-000000000001",
    ownerName: "陳建宏",
    periodStart: "2026-11-01",
    periodEnd: "2026-11-30",
    currency: "TWD",
    opening: 0,
    rent: 0,
    other: 0,
    fee: 0,
    expenses: 280000,
    payouts: 0,
    closing: -280000,
    lines: [{ lineType: "expense", description: "冷氣維修", amount: 280000 }],
    addresses: ["台北市信義區松仁路88號"],
    audience: "owner",
  };
  const doc = buildStatementPdf(source, "zh-TW", "gregorian", makeT("zh-TW"));
  const text = JSON.stringify(doc);
  assert.match(text, /屋主月結報表/);
  assert.match(text, /本期淨額為負/);
  assert.match(text, /−NT\$2,800/);
  assert.match(text, /期末餘額/);
  assert.match(text, /期初餘額 NT\$0 ＋ 本期淨額 −NT\$2,800 ＝ 期末餘額 −NT\$2,800/);
  assert.match(text, /NT\$0/);
  assert.equal(text.replaceAll("NT$", "").includes("$"), false);
  assert.match(text, /冷氣維修/);
  assert.match(text, /地址：台北市信義區松仁路88號/);
  assert.match(text, /數字來自管理方確認的繳款紀錄。/);
  assert.equal(text.includes("收款紀錄"), false);
  assert.equal(text.includes("電子發票"), false);
  assert.equal(text.includes("屋主應補繳"), false);
  assert.equal(text.includes("應付屋主"), false);
  const shortfallRows = doc.blocks.flatMap((block) => (block.kind === "rows" ? block.rows : []));
  assert.equal(shortfallRows.some((row) => row.label === "撥付"), false);
  assert.equal(text.includes("房東"), false);
  assert.equal(text.includes("-NT"), false);
  assert.equal(doc.footerHash, "2026-11-01/2026-11-30");

  const staff = buildStatementPdf({ ...source, audience: "staff", expenses: 0, rent: 1_000_000, closing: 920000, lines: [] }, "zh-TW", "gregorian", makeT("zh-TW"));
  const staffText = JSON.stringify(staff);
  assert.match(staffText, /電子發票/);
  assert.match(staffText, /期末/);
  assert.match(staffText, /NT\$10,000/);
  assert.equal(staffText.replaceAll("NT$", "").includes("$"), false);
  assert.equal(staffText.includes("屋主應補繳"), false);
});

test("payouts stay in the same net on the chip and the formula", () => {
  const source: StatementPdfSource = {
    id: "10000000-0000-4000-8000-000000000089",
    orgId: "10000000-0000-4000-8000-000000000001",
    ownerName: "陳建宏",
    periodStart: "2026-10-01",
    periodEnd: "2026-10-31",
    currency: "TWD",
    opening: 0,
    rent: 200_000,
    other: 0,
    fee: 0,
    expenses: 0,
    payouts: 500_000,
    closing: -300_000,
    lines: [],
    addresses: [],
    audience: "owner",
  };
  const netMinor = statementPeriodNet(source);
  assert.equal(source.opening + netMinor, source.closing);
  const doc = buildStatementPdf(source, "zh-TW", "gregorian", makeT("zh-TW"));
  const rows = doc.blocks.flatMap((block) => (block.kind === "rows" ? block.rows : []));
  const payoutRow = rows.find((row) => row.label === "撥付");
  assert.equal(payoutRow?.value, "NT$5,000");
  const chip = rows.find((row) => row.label === "本期淨額為負");
  assert.equal(chip?.value, "−NT$3,000");
  assert.equal(rows.some((row) => row.label === "應付屋主"), false);
  const formula = doc.blocks
    .flatMap((block) => (block.kind === "text" ? block.lines : []))
    .find((line) => line.includes("本期淨額"));
  assert.equal(formula, "期初餘額 NT$0 ＋ 本期淨額 −NT$3,000 ＝ 期末餘額 −NT$3,000");
  assert.equal(formula?.includes(chip?.value ?? ""), true);
  const warning = doc.blocks.flatMap((block) => (block.kind === "text" ? block.lines : [])).join("\n");
  assert.match(warning, /本期支出與撥付高於已登記租金/);
  assert.match(warning, /屋主淨額為 −NT\$3,000/);
  const english = buildStatementPdf(source, "en", "gregorian", makeT("en"));
  const englishRows = english.blocks.flatMap((block) => (block.kind === "rows" ? block.rows : []));
  assert.equal(englishRows.find((row) => row.label === "Payouts")?.value, "NT$5,000");
});

test('populated company snapshots require render-time opt-in and OFF restores legacy PDF bytes', async t => {
  const { readFileSync } = await import('node:fs');
  const { renderPdf } = await import('@/lib/pdf-render');
  const source: StatementPdfSource = {
    id: '10000000-0000-4000-8000-000000000088', orgId: '10000000-0000-4000-8000-000000000001',
    ownerName: 'Synthetic owner', periodStart: '2199-01-01', periodEnd: '2199-01-31', currency: 'TWD',
    opening: 0, rent: 10000, other: 0, fee: 1000, expenses: 0, payouts: 0, closing: 9000,
    lines: [], addresses: [], audience: 'staff',
  };
  const companyProfile = { legal_name: 'Synthetic company', tax_id: 'Private identifier', address: { city: 'City', district: 'District', street: 'Private street' } };
  const snapshot = structuredClone(companyProfile);
  const font = readFileSync(new URL('../../public/fonts/DroidSansFallback-subset.ttf', import.meta.url));
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const build = (input: StatementPdfSource) => buildStatementPdf(input, 'en', 'gregorian', makeT('en'));
  const legacy = build(source), bytes = await renderPdf(legacy, font);
  assert.notDeepEqual(await renderPdf(build({ ...source, companyProfile, companyProfileEnabled: true }), font), bytes);
  for (const companyProfileEnabled of [undefined, false, 'true', null] as unknown as (boolean | undefined)[]) {
    const off = build({ ...source, companyProfile, companyProfileEnabled });
    assert.deepEqual(off, legacy);
    assert.deepEqual(await renderPdf(off, font), bytes);
    assert.deepEqual(companyProfile, snapshot);
  }
});

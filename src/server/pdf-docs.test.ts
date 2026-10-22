import assert from "node:assert/strict";
import test from "node:test";
import { makeT } from "@/i18n";
import { moneyLabel } from "@/server/format";
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
  assert.equal(JSON.stringify(doc.blocks[0]).includes("electronic signature"), false);
  assert.equal(JSON.stringify(doc.blocks[0]).includes("e-sign"), false);
  assert.match(text, /Reason for the deposit/);
  assert.match(text, /第一條/);
  assert.match(text, /承租人/);
  assert.equal(doc.footerHash, HASH);
  assert.equal(doc.footerLabel, "Stored lease record hash");
  assert.equal(text.includes(sublessor), true);
  assert.equal(text.split(sublessor).join("").includes("房東"), false);
});

test("a shortfall statement says 本期淨額為負 and a zero fee is NT$0", () => {
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
  assert.match(text, /屋主淨額為 −NT\$2,800/);
  assert.match(text, new RegExp(moneyLabel(280000, "TWD", "zh-TW").replace("$", "\\$")));
  assert.match(text, /NT\$0/);
  assert.equal(text.replaceAll("NT$", "").includes("$"), false);
  assert.match(text, /冷氣維修/);
  assert.match(text, /地址：台北市信義區松仁路88號/);
  assert.match(text, /數字來自管理方確認的繳款紀錄。/);
  assert.equal(text.includes("收款紀錄"), false);
  assert.equal(text.includes("期末"), false);
  assert.equal(text.includes("電子發票"), false);
  assert.equal(text.includes("房東"), false);
  assert.equal(text.includes("-NT"), false);
  assert.equal(text.split("屋主淨額為 −NT$").join("").includes("−"), false);
  assert.equal(doc.footerHash, "2026-11-01/2026-11-30");

  const staff = buildStatementPdf({ ...source, audience: "staff", expenses: 0, rent: 1_000_000, closing: 920000, lines: [] }, "zh-TW", "gregorian", makeT("zh-TW"));
  const staffText = JSON.stringify(staff);
  assert.match(staffText, /電子發票/);
  assert.match(staffText, /期末/);
  assert.match(staffText, /NT\$10,000/);
  assert.equal(staffText.replaceAll("NT$", "").includes("$"), false);
  assert.equal(staffText.includes("本期淨額為負"), false);
});

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
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    notes: "備註一行",
    templateBody: null,
    place: "信義松仁 3F A",
    firm: "松信住宅管理",
    tenant: "張雅文",
    ownerName: "陳建宏",
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

test("a lease PDF lists parties, deposit reason, clauses, and the stored hash", () => {
  const doc = buildLeasePdf(lease(), "zh-TW", "gregorian", makeT("zh-TW"));
  const text = JSON.stringify(doc);
  assert.equal(doc.footerHash, HASH);
  assert.equal(doc.footerLabel, "文件雜湊");
  assert.match(text, /租客/);
  assert.match(text, /屋主/);
  assert.match(text, /陳建宏/);
  assert.match(text, /張雅文/);
  assert.match(text, /信義松仁 3F A/);
  assert.match(text, /押金調整原因/);
  assert.match(text, /屋主同意兩個月以上押金/);
  assert.match(text, /重點條款/);
  assert.match(text, /3 個月租金/);
  assert.match(text, /備註一行/);
  assert.equal(text.includes("房東"), false);
  assert.equal(text.includes("3.00"), false);
});

test("template clauses replace the generated ones and a missing hash is labeled", () => {
  const doc = buildLeasePdf(
    lease({
      documentSha256: "  ",
      templateBody: "第一條 租賃標的\n第二條 租金",
      depositOverrideReason: null,
      notes: null,
    }),
    "zh-TW",
    "gregorian",
    makeT("zh-TW"),
  );
  const clauses = doc.blocks.find((block) => block.kind === "text");
  assert.ok(clauses && clauses.kind === "text");
  assert.deepEqual(clauses.lines, ["第一條 租賃標的", "第二條 租金"]);
  assert.equal(doc.footerHash, "");
  assert.equal(doc.footerLabel, "文件雜湊尚未產生");
  assert.equal(JSON.stringify(doc).includes("押金調整原因"), false);
});

test("an English lease PDF still names the owner and the tenant", () => {
  const doc = buildLeasePdf(lease(), "en", "gregorian", makeT("en"));
  const text = JSON.stringify(doc);
  assert.match(text, /Tenant/);
  assert.match(text, /Owner/);
  assert.match(text, /Reason for the deposit/);
  assert.equal(doc.footerHash, HASH);
  assert.equal(text.includes("房東"), false);
});

test("a shortfall statement says 屋主應補繳 and a zero fee is NT$0", () => {
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
    audience: "owner",
  };
  const doc = buildStatementPdf(source, "zh-TW", "gregorian", makeT("zh-TW"));
  const text = JSON.stringify(doc);
  assert.match(text, /屋主月結報表/);
  assert.match(text, /屋主應補繳/);
  assert.match(text, new RegExp(moneyLabel(280000, "TWD", "zh-TW").replace("$", "\\$")));
  assert.match(text, /NT\$0/);
  assert.match(text, /冷氣維修/);
  assert.equal(text.includes("期末"), false);
  assert.equal(text.includes("電子發票"), false);
  assert.equal(text.includes("房東"), false);
  assert.equal(text.includes("-NT"), false);
  assert.equal(text.includes("−"), false);
  assert.equal(doc.footerHash, "2026-11-01/2026-11-30");

  const staff = buildStatementPdf({ ...source, audience: "staff", expenses: 0, rent: 1_000_000, closing: 920000, lines: [] }, "zh-TW", "gregorian", makeT("zh-TW"));
  const staffText = JSON.stringify(staff);
  assert.match(staffText, /電子發票/);
  assert.match(staffText, /期末/);
  assert.equal(staffText.includes("屋主應補繳"), false);
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import { makeT } from "@/i18n";
import { pdfContainsAscii } from "@/lib/pdf-text";
import { renderPdf } from "@/lib/pdf-render";
import { buildStatementPdf, type StatementPdfSource } from "@/server/pdf-docs";
import { ownerSettlement, statementPeriodNet } from "@/server/format";
import { renderStatementPage } from "@/server/negfix-evidence";

const ROOT = join(import.meta.dirname, "../..");
const EVIDENCE = join(ROOT, "e2e-evidence/pr-negfix");
const STORE = "/cursor/stores/self/negfix-pdfs";
const BANNED = ["收租", "收款", "欠租", "已收", "入帳", "房東", "代收", "轉付", "統一編號", "含稅", "本公司"];

type Fixture = {
  id: "net-positive" | "net-zero" | "net-negative" | "net-payouts";
  opening: number;
  rent: number;
  other: number;
  fee: number;
  expenses: number;
  payouts: number;
};

const CASES: Fixture[] = [
  { id: "net-positive", opening: 200_000, rent: 1_800_000, other: 0, fee: 180_000, expenses: 120_000, payouts: 0 },
  { id: "net-zero", opening: 500_000, rent: 1_000_000, other: 0, fee: 100_000, expenses: 900_000, payouts: 0 },
  { id: "net-negative", opening: -100_000, rent: 200_000, other: 0, fee: 80_000, expenses: 450_000, payouts: 0 },
  { id: "net-payouts", opening: 0, rent: 200_000, other: 0, fee: 0, expenses: 0, payouts: 500_000 },
];

function closingOf(row: Fixture) {
  return row.opening + statementPeriodNet(row);
}

function sourceOf(row: Fixture, closing: number): StatementPdfSource {
  return {
    id: "00000000-0000-4000-8000-000000000088",
    orgId: "00000000-0000-4000-8000-000000000001",
    ownerName: "QA屋主甲",
    periodStart: "2026-10-01",
    periodEnd: "2026-10-31",
    currency: "TWD",
    opening: row.opening,
    rent: row.rent,
    other: row.other,
    fee: row.fee,
    expenses: row.expenses,
    payouts: row.payouts,
    closing,
    lines: [{ lineType: "expense", description: "冷氣維修", amount: row.expenses }],
    addresses: ["台北市信義區松仁路88號"],
    audience: "owner",
  };
}

function pdfText(bytes: Uint8Array) {
  const dir = mkdtempSync(join(tmpdir(), "negfix-pdf-"));
  const file = join(dir, "doc.pdf");
  writeFileSync(file, bytes);
  return execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", file, "-"], { encoding: "utf8" });
}

function bannedHits(text: string) {
  return BANNED.filter((term) => text.includes(term));
}

const pdfs = new Map<string, Uint8Array>();

before(async () => {
  mkdirSync(EVIDENCE, { recursive: true });
  const font = readFileSync(join(ROOT, "public/fonts/DroidSansFallback-subset.ttf"));
  const t = makeT("zh-TW");
  const sums: string[] = [];
  if (existsSync("/cursor/stores/self")) mkdirSync(STORE, { recursive: true });
  for (const row of CASES) {
    const closing = closingOf(row);
    const figures = ownerSettlement({ ...row, closing });
    const net = statementPeriodNet(figures);
    assert.equal(closing, row.opening + net, row.id);
    const doc = buildStatementPdf(sourceOf(row, closing), "zh-TW", "gregorian", t);
    const bytes = await renderPdf(doc, font);
    pdfs.set(row.id, bytes);
    writeFileSync(join(EVIDENCE, `${row.id}-statement.html`), renderStatementPage({ ...row, closing }));
    writeFileSync(join(EVIDENCE, `${row.id}-statement.pdf.txt`), pdfText(bytes));
    if (existsSync(STORE)) {
      const name = `${row.id}-statement.pdf`;
      writeFileSync(join(STORE, name), bytes);
      sums.push(`${createHash("sha256").update(bytes).digest("hex")}  ${name}`);
    }
  }
  if (existsSync(STORE)) writeFileSync(join(STORE, "sha256sum.txt"), `${sums.join("\n")}\n`);
});

test("opening plus period net equals closing for positive, zero, negative, and payouts", () => {
  const positive = readFileSync(join(EVIDENCE, "net-positive-statement.html"), "utf8");
  const zero = readFileSync(join(EVIDENCE, "net-zero-statement.html"), "utf8");
  const negative = readFileSync(join(EVIDENCE, "net-negative-statement.html"), "utf8");
  const payouts = readFileSync(join(EVIDENCE, "net-payouts-statement.html"), "utf8");
  assert.match(positive, /data-testid="statement-document"/);
  assert.match(positive, /期初餘額/);
  assert.match(positive, /statement-opening">NT\$2,000/);
  assert.match(positive, /statement-closing">NT\$17,000/);
  assert.match(positive, /本期淨額 NT\$15,000/);
  assert.match(zero, /statement-opening">NT\$5,000/);
  assert.match(zero, /statement-closing">NT\$5,000/);
  assert.match(zero, /本期淨額 NT\$0/);
  assert.match(negative, /statement-opening">\u2212NT\$1,000/);
  assert.match(negative, /statement-closing">\u2212NT\$4,300/);
  assert.match(negative, /期末餘額/);
  assert.match(negative, /本期淨額為負/);
  assert.match(negative, /data-testid="statement-net"[^>]*>\s*(?:<span[^>]*>)?\u2212NT\$3,300/);
  assert.match(negative, /本期淨額 \u2212NT\$3,300/);
  assert.equal(negative.includes("屋主應補繳"), false);
  assert.equal(negative.includes("應付屋主"), false);
  assert.equal(negative.includes("差額請屋主補繳"), false);
  assert.equal(negative.includes("statement-payouts"), false);
  assert.match(negative, /本期支出與撥付高於已登記租金/);
  assert.match(payouts, /data-testid="owner-owes"/);
  assert.match(payouts, />撥付</);
  assert.match(payouts, /data-testid="statement-payouts">NT\$5,000/);
  assert.match(payouts, /本期淨額為負/);
  assert.match(payouts, /data-testid="statement-net"[^>]*>\s*(?:<span[^>]*>)?\u2212NT\$3,000/);
  assert.match(payouts, /本期淨額 \u2212NT\$3,000/);
  assert.match(payouts, /statement-closing">\u2212NT\$3,000/);
  assert.equal(payouts.includes("應付屋主"), false);
});

test("rendered statement PDFs show -NT$ and opening plus net equals closing", () => {
  const negativePdf = pdfs.get("net-negative");
  const positivePdf = pdfs.get("net-positive");
  const zeroPdf = pdfs.get("net-zero");
  const payoutsPdf = pdfs.get("net-payouts");
  assert.ok(negativePdf && positivePdf && zeroPdf && payoutsPdf);
  assert.equal(pdfContainsAscii(positivePdf, "NT$2,000"), true);
  assert.equal(pdfContainsAscii(positivePdf, "NT$15,000"), true);
  assert.equal(pdfContainsAscii(positivePdf, "NT$17,000"), true);
  assert.equal(pdfContainsAscii(zeroPdf, "NT$5,000"), true);
  assert.equal(pdfContainsAscii(zeroPdf, "NT$0"), true);
  assert.equal(pdfContainsAscii(negativePdf, "-NT$1,000"), true);
  assert.equal(pdfContainsAscii(negativePdf, "-NT$3,300"), true);
  assert.equal(pdfContainsAscii(negativePdf, "-NT$4,300"), true);
  assert.equal(pdfContainsAscii(payoutsPdf, "-NT$3,000"), true);
  const negativeText = readFileSync(join(EVIDENCE, "net-negative-statement.pdf.txt"), "utf8");
  const positiveText = readFileSync(join(EVIDENCE, "net-positive-statement.pdf.txt"), "utf8");
  const zeroText = readFileSync(join(EVIDENCE, "net-zero-statement.pdf.txt"), "utf8");
  const payoutsText = readFileSync(join(EVIDENCE, "net-payouts-statement.pdf.txt"), "utf8");
  assert.match(negativeText, /-NT\$1,000/);
  assert.match(negativeText, /-NT\$3,300/);
  assert.match(negativeText, /-NT\$4,300/);
  assert.match(negativeText, /期末餘額/);
  assert.match(positiveText, /NT\$2,000/);
  assert.match(positiveText, /NT\$17,000/);
  assert.match(zeroText, /NT\$5,000/);
  assert.match(payoutsText, /-NT\$3,000/);
  assert.match(payoutsText, /撥付\s+NT\$5,000/);
  assert.match(payoutsText, /本期淨額為負/);
  assert.match(payoutsText, /期末餘額/);
  assert.equal(payoutsText.includes("應付屋主"), false);
  assert.deepEqual(
    bannedHits([negativeText, payoutsText, readFileSync(join(EVIDENCE, "net-negative-statement.html"), "utf8")].join("\n")),
    [],
  );
});

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { before, test } from "node:test";
import { makeT } from "@/i18n";
import { pdfContainsAscii } from "@/lib/pdf-text";
import { renderPdf } from "@/lib/pdf-render";
import { buildStatementPdf, type StatementPdfSource } from "@/server/pdf-docs";
import { moneyLabel, ownerSettlement, signedMoneyLabel } from "@/server/format";
import { closingBalance } from "@/server/rent-settlement-math";

const ROOT = join(import.meta.dirname, "../..");
const EVIDENCE = join(ROOT, "e2e-evidence/pr52");
const BEFORE = join(EVIDENCE, "before");
const AFTER = join(EVIDENCE, "after");
const BASE = "c47122251c9185c87fb2253626d330c6b6a0194a";

const BANNED = ["收租", "收款", "欠租", "已收", "入帳", "房東", "代收", "轉付", "統一編號", "含稅", "本公司"];
const ALLOW = ["已收到", "自動計入帳單"];

type CaseId = "net-positive" | "net-zero" | "net-negative";

type Fixture = {
  id: CaseId;
  opening: number;
  rent: number;
  other: number;
  fee: number;
  expenses: number;
  payouts: number;
  firm: number;
};

const CASES: Fixture[] = [
  {
    id: "net-positive",
    opening: 200_000,
    rent: 1_800_000,
    other: 0,
    fee: 180_000,
    expenses: 120_000,
    payouts: 0,
    firm: 1_800_000,
  },
  {
    id: "net-zero",
    opening: 500_000,
    rent: 1_000_000,
    other: 0,
    fee: 100_000,
    expenses: 900_000,
    payouts: 0,
    firm: 1_000_000,
  },
  {
    id: "net-negative",
    opening: -100_000,
    rent: 200_000,
    other: 0,
    fee: 80_000,
    expenses: 450_000,
    payouts: 0,
    firm: 200_000,
  },
];

function periodNet(row: Fixture) {
  return row.firm - row.fee - row.expenses - row.payouts;
}

function closingOf(row: Fixture) {
  const closing = closingBalance(
    BigInt(row.opening),
    BigInt(row.firm),
    BigInt(row.fee + row.expenses),
    BigInt(row.payouts),
  );
  return Number(closing);
}

function headerLine(text: string, key: string) {
  const line = text.split("\n").find((item) => item.startsWith(`${key}:`));
  assert.ok(line, key);
  return line.slice(key.length + 1).trim();
}

function header(text: string, key: string) {
  return Number(headerLine(text, key));
}

function bannedHits(text: string) {
  let masked = text;
  for (const phrase of ALLOW) masked = masked.replaceAll(phrase, "");
  return BANNED.filter((term) => masked.includes(term));
}

const t = makeT("zh-TW");

function money(minor: number) {
  return moneyLabel(minor, "TWD", "zh-TW");
}

function signed(minor: number) {
  return signedMoneyLabel(minor, "TWD", "zh-TW");
}

function pdfLines(source: StatementPdfSource) {
  const doc = buildStatementPdf(source, "zh-TW", "gregorian", t);
  const lines = [`title: ${doc.title}`, `subtitle: ${doc.subtitle}`];
  for (const block of doc.blocks) {
    if (block.kind === "rows") {
      if (block.heading) lines.push(`# ${block.heading}`);
      for (const row of block.rows) lines.push(`${row.label}\t${row.value}`);
    } else {
      for (const line of block.lines) lines.push(line);
    }
  }
  return { doc, text: lines.join("\n") };
}

function statementSource(row: Fixture, closing: number): StatementPdfSource {
  return {
    id: "10000000-0000-4000-8000-000000000088",
    orgId: "10000000-0000-4000-8000-000000000001",
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
    firm: row.firm,
    lines: [{ lineType: "expense", description: "冷氣維修", amount: row.expenses }],
    addresses: ["台北市信義區松仁路88號"],
    audience: "owner",
  };
}

/** Settlement PDF uses the same inputs as settlementPdfForSession: opening 0, closing = month net. */
function settlementSource(row: Fixture, net: number): StatementPdfSource {
  return {
    ...statementSource(row, net),
    opening: 0,
    payouts: 0,
    closing: net,
    firm: undefined,
    lines: [],
    addresses: [],
    audience: "staff",
  };
}

function htmlTable(title: string, rows: [string, string][]) {
  const body = rows
    .map(([label, value]) => `<tr><td>${label}</td><td class="num">${value}</td></tr>`)
    .join("");
  return `<!DOCTYPE html><meta charset="utf-8"><title>${title}</title><table><tbody>${body}</tbody></table>\n`;
}

function settlementList(row: Fixture) {
  const figures = ownerSettlement({
    opening: row.opening,
    rent: row.rent,
    other: row.other,
    fee: row.fee,
    expenses: row.expenses,
    payouts: row.payouts,
    closing: closingOf(row),
  });
  const netLabel =
    figures.owes > 0 ? `${t("owner_owes")} ${signed(-figures.owes)}` : money(figures.payable);
  return {
    figures,
    rows: [
      [t("i_stmt_rent"), money(figures.rent)],
      [t("i_stmt_costs"), money(figures.costs)],
      [t("i_stmt_net"), netLabel],
    ] as [string, string][],
  };
}

let negativeStatementPdf: Uint8Array;
let negativeSettlementPdf: Uint8Array;

before(async () => {
  mkdirSync(AFTER, { recursive: true });
  const font = readFileSync(join(ROOT, "public/fonts/DroidSansFallback-subset.ttf"));
  for (const row of CASES) {
    const net = periodNet(row);
    const closing = closingOf(row);
    const statement = pdfLines(statementSource(row, closing));
    const settlement = pdfLines(settlementSource(row, net));
    const list = settlementList(row);
    const head = [
      "version: after #52",
      `base: ${BASE}`,
      `case: ${row.id}`,
      `opening_minor: ${row.opening}`,
      `rent_minor: ${row.rent}`,
      `other_minor: ${row.other}`,
      `fee_minor: ${row.fee}`,
      `expenses_minor: ${row.expenses}`,
      `payouts_minor: ${row.payouts}`,
      `firm_minor: ${row.firm}`,
      `period_net_minor: ${net}`,
      `closing_minor: ${closing}`,
      `owner_net_minor: ${list.figures.net}`,
      `identity_closing_eq_opening_plus_period_net: ${closing === row.opening + net}`,
    ];
    const statementText = [...head, "surface: monthly-statement", "", "--- pdf model ---", statement.text, ""].join("\n");
    const settlementText = [
      ...head,
      "surface: settlement",
      "",
      "--- list ---",
      ...list.rows.map(([label, value]) => `${label}\t${value}`),
      "",
      "--- pdf model ---",
      settlement.text,
      "",
    ].join("\n");
    writeFileSync(join(AFTER, `${row.id}-statement.txt`), statementText);
    writeFileSync(join(AFTER, `${row.id}-settlement.txt`), settlementText);
    writeFileSync(join(AFTER, `${row.id}-statement.html`), htmlTable(`${row.id} monthly statement`, statementRows(statement.text)));
    writeFileSync(join(AFTER, `${row.id}-settlement.html`), htmlTable(`${row.id} settlement`, list.rows));
    if (row.id === "net-negative") {
      negativeStatementPdf = await renderPdf(statement.doc, font);
      negativeSettlementPdf = await renderPdf(settlement.doc, font);
      writeFileSync(
        join(AFTER, "net-negative-statement.pdf.txt"),
        pdfEvidence("monthly-statement", negativeStatementPdf),
      );
      writeFileSync(
        join(AFTER, "net-negative-settlement.pdf.txt"),
        pdfEvidence("settlement", negativeSettlementPdf),
      );
    }
  }
});

function statementRows(model: string): [string, string][] {
  return model
    .split("\n")
    .filter((line) => line.includes("\t"))
    .map((line) => {
      const [label, value] = line.split("\t");
      return [label, value] as [string, string];
    });
}

function pdfEvidence(surface: string, bytes: Uint8Array) {
  const amounts = ["-NT$1,000", "-NT$3,300", "-NT$4,300", "-NT$15,000", "-NT$17,000"].filter((amount) =>
    pdfContainsAscii(bytes, amount),
  );
  return [
    "version: after #52",
    `base: ${BASE}`,
    `surface: ${surface}`,
    `pdf_contains_ascii_-NT$: ${pdfContainsAscii(bytes, "-NT$")}`,
    `amounts: ${amounts.join(", ")}`,
    `byte_length: ${bytes.length}`,
    "",
  ].join("\n");
}

test("closing balance equals opening balance plus period net for each case", () => {
  for (const row of CASES) {
    const net = periodNet(row);
    const closing = closingOf(row);
    assert.equal(closing, row.opening + net, row.id);
    for (const side of [BEFORE, AFTER]) {
      for (const surface of ["statement", "settlement"]) {
        const text = readFileSync(join(side, `${row.id}-${surface}.txt`), "utf8");
        assert.equal(header(text, "opening_minor") + header(text, "period_net_minor"), header(text, "closing_minor"), `${side} ${row.id} ${surface}`);
        assert.equal(headerLine(text, "identity_closing_eq_opening_plus_period_net"), "true");
      }
    }
  }
});

test("before and after snapshots keep the three nets and show the signed closing only after", () => {
  const positiveBefore = readFileSync(join(BEFORE, "net-positive-statement.txt"), "utf8");
  const zeroBefore = readFileSync(join(BEFORE, "net-zero-statement.txt"), "utf8");
  const negativeBefore = readFileSync(join(BEFORE, "net-negative-statement.txt"), "utf8");
  assert.match(positiveBefore, /應付屋主\tNT\$15,000/);
  assert.match(positiveBefore, /期末\tNT\$17,000/);
  assert.match(zeroBefore, /應付屋主\tNT\$0/);
  assert.match(zeroBefore, /期末\tNT\$5,000/);
  assert.match(negativeBefore, /屋主應補繳 NT\$3,300/);
  assert.equal(negativeBefore.includes("期末"), false);
  assert.equal(negativeBefore.includes("-NT$"), false);
  assert.equal(negativeBefore.includes("\u2212NT$"), false);
  assert.match(readFileSync(join(BEFORE, "net-negative-settlement.txt"), "utf8"), /應付屋主\t屋主應補繳 NT\$3,300/);
  assert.match(readFileSync(join(BEFORE, "net-negative-statement.pdf.txt"), "utf8"), /pdf_contains_ascii_-NT\$: false/);

  const positiveAfter = readFileSync(join(AFTER, "net-positive-statement.txt"), "utf8");
  const zeroAfter = readFileSync(join(AFTER, "net-zero-statement.txt"), "utf8");
  const negativeAfter = readFileSync(join(AFTER, "net-negative-statement.txt"), "utf8");
  assert.match(positiveAfter, /屋主淨額（本月）\tNT\$15,000/);
  assert.match(positiveAfter, /期末餘額\tNT\$17,000/);
  assert.match(zeroAfter, /屋主淨額（本月）\tNT\$0/);
  assert.match(zeroAfter, /期末餘額\tNT\$5,000/);
  assert.match(negativeAfter, /期初餘額\t−NT\$1,000/);
  assert.match(negativeAfter, /本期淨額為負 −NT\$3,300/);
  assert.match(negativeAfter, /期末餘額\t−NT\$4,300/);
  assert.match(readFileSync(join(AFTER, "net-negative-statement.html"), "utf8"), /期末餘額/);
  assert.match(readFileSync(join(AFTER, "net-negative-settlement.txt"), "utf8"), /屋主淨額\t本期淨額為負 −NT\$3,300/);
  assert.match(readFileSync(join(AFTER, "net-positive-settlement.txt"), "utf8"), /屋主淨額\tNT\$15,000/);
  assert.match(readFileSync(join(AFTER, "net-zero-settlement.txt"), "utf8"), /屋主淨額\tNT\$0/);
});

test("negative-case wording skips the banned payment terms", () => {
  assert.deepEqual(bannedHits("已收到租金，自動計入帳單"), []);
  assert.deepEqual(bannedHits("已收"), ["已收"]);
  const negative = [
    readFileSync(join(AFTER, "net-negative-statement.txt"), "utf8"),
    readFileSync(join(AFTER, "net-negative-statement.html"), "utf8"),
    readFileSync(join(AFTER, "net-negative-settlement.txt"), "utf8"),
    readFileSync(join(AFTER, "net-negative-settlement.html"), "utf8"),
  ].join("\n");
  assert.deepEqual(bannedHits(negative), []);
  assert.equal(negative.includes("差額請屋主補繳"), false);
  assert.equal(negative.includes("屋主應補繳"), false);
});

test("the negative PDF shows -NT$ for the statement and the settlement", () => {
  assert.equal(pdfContainsAscii(negativeStatementPdf, "-NT$1,000"), true);
  assert.equal(pdfContainsAscii(negativeStatementPdf, "-NT$3,300"), true);
  assert.equal(pdfContainsAscii(negativeStatementPdf, "-NT$4,300"), true);
  assert.equal(pdfContainsAscii(negativeSettlementPdf, "-NT$3,300"), true);
  assert.equal(pdfContainsAscii(negativeSettlementPdf, "-NT$4,300"), false);
  const statementNote = readFileSync(join(AFTER, "net-negative-statement.pdf.txt"), "utf8");
  const settlementNote = readFileSync(join(AFTER, "net-negative-settlement.pdf.txt"), "utf8");
  assert.match(statementNote, /pdf_contains_ascii_-NT\$: true/);
  assert.match(statementNote, /-NT\$1,000/);
  assert.match(statementNote, /-NT\$4,300/);
  assert.match(settlementNote, /pdf_contains_ascii_-NT\$: true/);
  assert.match(settlementNote, /-NT\$3,300/);
});

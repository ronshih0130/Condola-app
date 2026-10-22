import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { makeT } from "@/i18n";
import { formatMoney, moneyLabel, signedMoneyLabel } from "@/server/format";
import { buildStatementPdf } from "@/server/pdf-docs";

const MINUS = "\u2212";
const WARNING = `本月費用高於已登記租金，屋主淨額為 ${MINUS}NT$3,300。費用怎麼處理，請和屋主確認。`;

test("formatMoney shows a negative TWD amount as −NT$ and keeps zero unsigned", () => {
  assert.equal(formatMoney(-330_000, "TWD", "zh-TW"), `${MINUS}NT$3,300`);
  assert.equal(moneyLabel(-330_000, "TWD", "en"), `${MINUS}NT$3,300`);
  assert.equal(signedMoneyLabel(-330_000, "TWD", "zh-TW"), `${MINUS}NT$3,300`);
  assert.equal(formatMoney(0, "TWD", "zh-TW"), "NT$0");
  assert.equal(moneyLabel(0, "TWD", "zh-TW"), "NT$0");
  assert.equal(formatMoney(-100, "TWD", "zh-TW").includes("-NT$"), false);
  assert.equal(moneyLabel(1_800_000, "TWD", "zh-TW"), "NT$18,000");
});

test("a negative owner net keeps the signed closing row, the P08 label, and the neutral warning", () => {
  const source = readFileSync(new URL("./statement-document.tsx", import.meta.url), "utf8");
  assert.equal(source.includes("Math.max(0, figures.closing)"), false);
  assert.equal(source.includes("Math.max(0, closing)"), false);

  const zh = JSON.parse(readFileSync(new URL("../i18n/zh-TW.json", import.meta.url), "utf8")) as Record<string, string>;
  assert.equal(zh.owner_owes, "本期淨額為負");
  assert.equal(
    zh.i_stmt_negative,
    "本月費用高於已登記租金，屋主淨額為 \u2212NT${amount}。費用怎麼處理，請和屋主確認。",
  );

  assert.match(source, /data-testid="statement-closing"/);
  assert.match(source, /signed\(figures\.opening\)/);
  assert.match(source, /signed\(figures\.closing\)/);
  assert.match(source, /i_stmt_negative/);
  assert.equal(source.includes("owner_owes_reason"), false);
  const closingAt = source.indexOf('data-testid="statement-closing"');
  const netAt = source.indexOf('data-testid="statement-net"');
  assert.ok(netAt > 0 && closingAt > netAt);

  const pdf = buildStatementPdf({
    id: "10000000-0000-4000-8000-000000000088",
    orgId: "10000000-0000-4000-8000-000000000001",
    ownerName: "QA屋主甲",
    periodStart: "2026-10-01",
    periodEnd: "2026-10-31",
    currency: "TWD",
    opening: -100_000,
    rent: 0,
    other: 0,
    fee: 0,
    expenses: 330_000,
    payouts: 0,
    closing: -330_000,
    lines: [],
    addresses: [],
    audience: "owner",
  }, "zh-TW", "gregorian", makeT("zh-TW"));
  const text = JSON.stringify(pdf);
  assert.match(text, /期末餘額/);
  assert.match(text, new RegExp(`${MINUS}NT\\$3,300`));
  assert.match(text, new RegExp(`${MINUS}NT\\$1,000`));
  assert.match(text, /本期淨額為負/);
  assert.equal(text.includes(WARNING), true);
  assert.equal(text.includes("差額請屋主補繳"), false);
});

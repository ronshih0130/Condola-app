import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { makeT } from "@/i18n";
import { moneyLabel } from "@/server/format";
import { buildStatementPdf } from "@/server/pdf-docs";

const root = new URL("../", import.meta.url);

function read(path: string) {
  return readFileSync(new URL(path, root), "utf8");
}

/** A bare dollar is $ followed by a digit, after NT$ prefixes are removed. */
function bareDollars(text: string) {
  return text.replaceAll("NT$", "").match(/\$\d/g);
}

const SCREENS = [
  "components/statement-document.tsx",
  "app/m/properties/[id]/page.tsx",
  "app/m/rent/page.tsx",
  "app/m/reports/page.tsx",
];

test("statement, property, rent, and reports render TWD as NT$", () => {
  assert.equal(moneyLabel(0, "TWD", "zh-TW"), "NT$0");
  assert.equal(moneyLabel(950_000, "TWD", "zh-TW"), "NT$9,500");
  const zh = JSON.parse(read("i18n/zh-TW.json")) as Record<string, string>;
  assert.equal(zh.i_rent_received, "已確認租金");

  for (const file of SCREENS) {
    const source = read(file);
    assert.match(source, /moneyLabel/, file);
    assert.doesNotMatch(source, /formatMoney/, file);
    assert.doesNotMatch(source, /style:\s*["']currency["']/, file);
    assert.doesNotMatch(source, /toLocaleString/, file);
    assert.doesNotMatch(source, /`\$\$\{/, file);
  }

  const t = makeT("zh-TW");
  const pdf = buildStatementPdf(
    {
      id: "10000000-0000-4000-8000-000000000088",
      orgId: "10000000-0000-4000-8000-000000000001",
      ownerName: "陳建宏",
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
      currency: "TWD",
      opening: 0,
      rent: 950_000,
      other: 0,
      fee: 0,
      expenses: 0,
      payouts: 0,
      closing: 950_000,
      lines: [],
      addresses: [],
      audience: "staff",
    },
    "zh-TW",
    "gregorian",
    t,
  );
  const pdfText = JSON.stringify(pdf);
  assert.equal(bareDollars(pdfText), null, pdfText);
  assert.match(pdfText, /NT\$0/);
  assert.match(pdfText, /NT\$9,500/);
  assert.match(pdfText, /已確認租金/);
});

test("rendered screens do not format amounts with a bare dollar", () => {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
      const text = readFileSync(path, "utf8");
      if (!text.includes("formatMoney")) continue;
      if (path.endsWith(`${join("server", "format.ts")}`)) continue;
      if (path.endsWith(`${join("t", "pay", "page.tsx")}`) && text.includes('moneyLabel as formatMoney')) continue;
      hits.push(path);
    }
  };
  walk(root.pathname);
  assert.deepEqual(hits, []);
});

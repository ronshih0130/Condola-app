import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { makeT } from "@/i18n";
import { moneyLabel, signedMoney, signedMoneyLabel, statementSignedMoney } from "@/server/format";
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

test("signedMoney selects the brand minus sign and keeps zero unsigned", () => {
  assert.equal(signedMoney(-280000, "TWD", "zh-TW", true), "\u2212NT$2,800");
  assert.equal(signedMoney(-280000, "TWD", "zh-TW", false), "-NT$2,800");
  for (const v2 of [false, true]) {
    assert.equal(signedMoney(0, "TWD", "zh-TW", v2), "NT$0");
  }
});

test("statement document wraps negative row amounts only when v2 is enabled", () => {
  const source = read("components/statement-document.tsx");
  assert.match(source, /const amount = \(value: string\) => v2 && value\.startsWith\("\\u2212"\) \? <span className="amount-neg">\{value\}<\/span> : value;/);
  assert.equal((source.match(/className="amount-neg"/g) || []).length, 1);
  assert.match(source, /\{amount\(value\)\}/);
  assert.match(source, /\{amount\(signed\(figures\.payouts\)\)\}/);
  assert.match(source, /\{amount\(signed\(periodNet\)\)\}/);
  assert.match(source, /\{amount\(signed\(figures\.closing\)\)\}/);
  assert.match(source, /\{amount\(signed\(Number\(line\.amount\)\)\)\}/);
});

test("server pages select signed money by brand, and documents use U+2212", () => {
  assert.equal(signedMoneyLabel(-5_000, "TWD", "zh-TW"), "-NT$50");
  assert.equal(signedMoneyLabel(-30_000, "TWD", "zh-TW"), "-NT$300");
  assert.equal(signedMoneyLabel(0, "TWD", "zh-TW"), "NT$0");
  assert.equal(statementSignedMoney(-5_000, "TWD", "zh-TW"), "\u2212NT$50");
  for (const file of ["app/m/rent/utilities/page.tsx", "app/t/pay/page.tsx", "app/m/statements/page.tsx", "app/o/statements/page.tsx"]) {
    const source = read(file);
    assert.match(source, /import \{ brandV2EnabledForOrg \} from "@\/server\/brand-v2";/, file);
    assert.match(source, /const v2 = await brandV2EnabledForOrg\(session\.orgId\);/, file);
    assert.match(source, /signedMoney\([^;\n]*, v2\)/, file);
    assert.doesNotMatch(source, /signedMoneyLabel|statementSignedMoney/, file);
  }
  for (const file of ["components/statement-document.tsx", "server/pdf-docs.ts"]) {
    const source = read(file);
    assert.match(source, /statementSignedMoney/, file);
    assert.doesNotMatch(source, /signedMoneyLabel/, file);
  }
});

test("TWD amounts stay NT$ when the currency code is padded, and 已收 is not payment copy", () => {
  assert.equal(moneyLabel(0, "TWD ", "zh-TW"), "NT$0");
  assert.equal(moneyLabel(0, "twd", "zh-TW"), "NT$0");
  assert.equal(moneyLabel(0, " USD ", "en"), "$0.00");
  const zh = JSON.parse(read("i18n/zh-TW.json")) as Record<string, string>;
  assert.equal(zh.i_paid, "已繳");
  assert.equal(zh.i_rent_received, "已繳租金");
  assert.equal(zh.i_audit_ev_go_live, "開始正式使用");
  assert.equal(zh.i_mail_overdue, "繳款提醒");
  assert.equal(zh.i_mail_tenant_overdue, "寄送繳款提醒給租客（逾期第 1 天）");
  const overdueLabel = "欠租" + "提醒";
  for (const [key, value] of Object.entries(zh)) {
    assert.equal(value.replaceAll("已收到", "").includes("已收"), false, `${key}: ${value}`);
    assert.equal(value.includes(overdueLabel), false, `${key}: ${value}`);
  }
  const leases = read("app/m/leases/page.tsx");
  assert.match(leases, /data-testid="lease-rent"/);
  assert.match(leases, /data-testid="lease-deposit"/);
  assert.match(leases, /money\(row\.rent, row\.currency\)/);
  assert.match(leases, /money\(row\.deposit, row\.currency\)/);
  assert.doesNotMatch(leases, /formatMoney/);
});

test("the lease wizard confirm step and the saved summary render TWD as NT$", () => {
  assert.equal(moneyLabel(1_500_000, "TWD", "zh-TW"), "NT$15,000");
  assert.equal(moneyLabel(3_000_000, "TWD", "zh-TW"), "NT$30,000");
  const wizard = read("components/lease-wizard.tsx");
  assert.match(wizard, /return formatMajor\(major, currency, locale\)/);
  assert.match(wizard, /data-testid="lease-confirm-rent">\{money\(/);
  assert.match(wizard, /data-testid="lease-confirm-deposit">\{confirmDeposit\(/);
  assert.doesNotMatch(wizard, /style:\s*["']currency["']/);
  const page = read("app/m/leases/[id]/page.tsx");
  assert.match(page, /const money = \(minor: number\) => moneyLabel\(minor, lease\.currency, session\.locale\)/);
  assert.match(page, /data-testid="summary-rent">\{money\(Number\(lease\.rent\)\)\}/);
  assert.match(page, /data-testid="summary-deposit">\{money\(Number\(lease\.deposit\)\)\}/);
  assert.doesNotMatch(page, /formatMoney/);
});

test("statement, property, rent, and reports render TWD as NT$", () => {
  assert.equal(moneyLabel(0, "TWD", "zh-TW"), "NT$0");
  assert.equal(moneyLabel(950_000, "TWD", "zh-TW"), "NT$9,500");
  const zh = JSON.parse(read("i18n/zh-TW.json")) as Record<string, string>;
  assert.equal(zh.i_rent_received, "已繳租金");
  assert.equal(zh.i_rent_this_month, "本月已繳租金");
  assert.equal(zh.i_audit_ev_go_live, "開始正式使用");
  const en = JSON.parse(read("i18n/en.json")) as Record<string, string>;
  assert.equal(en.i_rent_received, "Rent paid");

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
  assert.match(pdfText, /已繳租金/);
  assert.equal(pdfText.includes("已確認租金"), false);
});

test("已確認租金 is not shown to users", () => {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (/\.test\.tsx?$/.test(entry)) continue;
      if (!/\.(ts|tsx|json)$/.test(entry)) continue;
      const text = readFileSync(path, "utf8");
      if (text.includes("已確認租金")) hits.push(path);
    }
  };
  walk(root.pathname);
  assert.deepEqual(hits, []);
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
      if (!/\bformatMoney\b/.test(text)) continue;
      if (path.endsWith(`${join("server", "format.ts")}`)) continue;
      if (path.endsWith(`${join("t", "pay", "page.tsx")}`) && text.includes('moneyLabel as formatMoney')) continue;
      hits.push(path);
    }
  };
  walk(root.pathname);
  assert.deepEqual(hits, []);
});

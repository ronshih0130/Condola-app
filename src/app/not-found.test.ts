import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { moneyLabel, formatMoney } from "@/server/format";

const root = new URL("./", import.meta.url);

function read(path: string) {
  return readFileSync(new URL(path, root), "utf8");
}

const zh = JSON.parse(read("../i18n/zh-TW.json")) as Record<string, string>;
const en = JSON.parse(read("../i18n/en.json")) as Record<string, string>;

const BANNED = ["收款", "收租", "入帳", "測試模式", "示範", "404", "Not Found", "Home"];

test("the Chinese missing page is the only copy on / and /m", () => {
  assert.equal(zh.i_page_missing_title, "找不到這個頁面");
  assert.equal(zh.i_page_missing_body, "這個頁面可能已經移除，或網址有誤。");
  assert.equal(zh.i_page_missing_home, "回到首頁");
  for (const key of ["i_page_missing_title", "i_page_missing_body", "i_page_missing_home"]) {
    assert.equal(en[key], zh[key], key);
    assert.equal(/[A-Za-z]/.test(zh[key]), false, key);
    for (const word of BANNED) assert.equal(zh[key].includes(word), false, `${key} ${word}`);
  }

  const block = read("../components/missing-page.tsx");
  assert.match(block, /makeT\("zh-TW"\)/);
  assert.match(block, /i_page_missing_title/);
  assert.match(block, /i_page_missing_body/);
  assert.match(block, /i_page_missing_home/);
  assert.match(block, /className="btn pri"/);
  assert.doesNotMatch(block, /404|Not Found|Home|回到首頁|找不到/);

  const publicPage = read("./not-found.tsx");
  const managerPage = read("./m/not-found.tsx");
  assert.match(publicPage, /<MissingPage href="\/" \/>/);
  assert.match(publicPage, /className="main"/);
  assert.match(managerPage, /<MissingPage href="\/m" \/>/);
  assert.doesNotMatch(managerPage, /className="main"/);
  for (const source of [publicPage, managerPage, block]) {
    for (const word of BANNED) assert.equal(source.includes(word), false, word);
  }

  const lease = read("./m/leases/[id]/page.tsx");
  const owner = read("./m/owners/[id]/page.tsx");
  for (const source of [lease, owner]) {
    assert.match(source, /if \(!isUuid\(id\)\) notFound\(\)/);
    assert.match(source, /if \(!\w+\) notFound\(\)/);
  }
});

test("dashboard money uses an NT$ prefix and the received tile says 已繳", () => {
  assert.equal(zh.i_paid, "已繳");
  assert.equal(zh.i_open_balance, "未結餘額");
  for (const word of ["收款", "收租", "入帳", "測試模式", "示範"]) {
    assert.equal(zh.i_paid.includes(word), false);
  }
  assert.equal(formatMoney(0, "TWD", "zh-TW"), "$0");
  assert.equal(moneyLabel(0, "TWD", "zh-TW"), "NT$0");
  assert.equal(moneyLabel(1_200_000, "TWD", "zh-TW"), "NT$12,000");
  assert.equal(moneyLabel(0, "TWD", "en"), "NT$0");
  assert.equal(moneyLabel(1_200_000, "TWD", "en"), "NT$12,000");

  const dash = read("./m/page.tsx");
  assert.match(dash, /moneyLabel/);
  assert.doesNotMatch(dash, /formatMoney/);
  assert.match(dash, /data-testid="dash-received"/);
  assert.match(dash, /data-testid="dash-outstanding"/);
  assert.match(dash, /data-testid="dash-property-amounts"/);
  assert.match(dash, /t\("i_paid"\)/);
  assert.match(dash, /t\("i_open_balance"\)/);
  assert.match(dash, /\{money\(received\)\} \/ \{money\(billed\)\}/);
  assert.match(dash, /money\(row\.balance, row\.currency\)/);
});

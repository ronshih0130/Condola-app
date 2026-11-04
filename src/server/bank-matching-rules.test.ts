import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BANK_MATCH_REASON_CODES, bankMatchReasonCode, parseBankCsv } from "./bank-matching-rules";
test("bank CSV validates mapped fields, quoting and exact signed amounts", () => {
  assert.deepEqual(parseBankCsv('交易日期,存入金額,帳號末五碼,備註\n2026-01-02,123.45,00123,"rent, apt"\n2026-01-02,-0.01,,"a\nb"'),[
    {date:"2026-01-02",amountMinor:BigInt(12345),last5:"00123",memo:"rent, apt"}, {date:"2026-01-02",amountMinor:-BigInt(1),last5:null,memo:"a\nb"}]);
  assert.deepEqual(parseBankCsv('交易日期,存入金額\n115/01/02,"1,234.50"',"roc"),[{date:"2026-01-02",amountMinor:BigInt(123450),last5:null,memo:""}]);
  assert.throws(() => parseBankCsv('date,amount\n115/01/02,1',"iso"));
  assert.throws(() => parseBankCsv('date,amount\n000/01/02,1',"roc"));
  for (const row of ['2026-02-30,1','2026-01-01,1.001','2026-01-01,NaN','2026-01-01,"1','2026-01-01,92233720368547758.08','2026-01-01,1,x']) assert.throws(() => parseBankCsv(`date,amount\n${row}`));
});

test("a bank match reason is one fixed code", () => {
  for (const code of BANK_MATCH_REASON_CODES) assert.equal(bankMatchReasonCode(`  ${code}\n`), code);
  for (const value of ["", " ", "Synthetic", "synthetic rejection", "corrected_signature", null, 1, "other org"]) {
    assert.equal(bankMatchReasonCode(value), null);
  }
  const ui = readFileSync(new URL("../components/bank-matching.tsx", import.meta.url), "utf8");
  const copy = readFileSync(new URL("../i18n/bank-matching.ts", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../../supabase/migrations/20261031100225_b009_decision_reason_codes.sql", import.meta.url), "utf8");
  assert.match(ui, /<select[^>]*name="reason"/);
  assert.match(ui, /BANK_MATCH_REASON_CODES/);
  assert.doesNotMatch(ui, /maxLength=\{500\}/);
  for (const code of BANK_MATCH_REASON_CODES) {
    assert.match(copy, new RegExp(code));
    assert.match(migration, new RegExp(code));
  }
});

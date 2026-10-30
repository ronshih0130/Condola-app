import assert from "node:assert/strict";
import test from "node:test";
import { parseBankCsv } from "./bank-matching-rules";
test("bank CSV validates mapped fields, quoting and exact signed amounts", () => {
  assert.deepEqual(parseBankCsv('交易日期,存入金額,帳號末五碼,備註\n2026-01-02,123.45,00123,"rent, apt"\n2026-01-02,-0.01,,"a\nb"'),[
    {date:"2026-01-02",amountMinor:BigInt(12345),last5:"00123",memo:"rent, apt"}, {date:"2026-01-02",amountMinor:-BigInt(1),last5:null,memo:"a\nb"}]);
  assert.deepEqual(parseBankCsv('交易日期,存入金額\n115/01/02,"1,234.50"',"roc"),[{date:"2026-01-02",amountMinor:BigInt(123450),last5:null,memo:""}]);
  assert.throws(() => parseBankCsv('date,amount\n115/01/02,1',"iso"));
  assert.throws(() => parseBankCsv('date,amount\n000/01/02,1',"roc"));
  for (const row of ['2026-02-30,1','2026-01-01,1.001','2026-01-01,NaN','2026-01-01,"1','2026-01-01,92233720368547758.08','2026-01-01,1,x']) assert.throws(() => parseBankCsv(`date,amount\n${row}`));
});

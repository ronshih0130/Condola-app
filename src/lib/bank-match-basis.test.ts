import assert from "node:assert/strict";
import test from "node:test";
import { bankMatchBasis } from "./bank-match-basis";

const empty = { amountExact: false, last5Matched: false, dateDeltaDays: null };
test("stored basis exposes only recognized facts, without raw account digits or unknown metadata", () => {
  const result = bankMatchBasis(JSON.parse('{"amount_exact":true,"last5":"01234","date_delta_days":0,"private":"raw-marker","__proto__":{"amount_exact":true}}'));
  assert.deepEqual(result, { amountExact: true, last5Matched: true, dateDeltaDays: 0 });
  assert.equal(JSON.stringify(result).includes("01234"), false);
  assert.equal(JSON.stringify(result).includes("raw-marker"), false);
  assert.deepEqual(bankMatchBasis(Object.assign(Object.create(null), {date_delta_days:Number.MAX_SAFE_INTEGER})), { ...empty, dateDeltaDays:Number.MAX_SAFE_INTEGER });
});
test("non-records, inherited facts and accessors cannot supply basis", () => {
  for (const value of [null, undefined, true, 1, "{}", [], [true], new Date(), Object.create({amount_exact:true})]) assert.deepEqual(bankMatchBasis(value), empty);
  assert.deepEqual(bankMatchBasis(Object.defineProperty({}, "amount_exact", {get() { throw new Error("must not read"); }})), empty);
});
test("malformed recognized fields are discarded independently", () => {
  for (const amount_exact of [false, "true", 1, {}, null]) assert.deepEqual(bankMatchBasis({amount_exact}), empty);
  for (const last5 of [12345, "1234", "123456", " 12345", "12345\n", "１２３４５", {}, null]) assert.deepEqual(bankMatchBasis({last5}), empty);
  for (const date_delta_days of [-1, 1.5, "2", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, {}, null]) assert.deepEqual(bankMatchBasis({date_delta_days}), empty);
  assert.deepEqual(bankMatchBasis({amount_exact:true,last5:12345,date_delta_days:7,other:true}), {amountExact:true,last5Matched:false,dateDeltaDays:7});
});

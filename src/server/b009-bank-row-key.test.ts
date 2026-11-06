import test from "node:test";
import assert from "node:assert/strict";
import { bankDecisionDigest, bankRowKeys, isUuid } from "./bank-matching-rules";

const row = {date:"2026-01-01",amountMinor:BigInt(100),last5:"12345",memo:"Payment"};
const other = {...row,date:"2026-01-02"};

test("bank row keys are deterministic SHA-256 hex", () => {
  const keys = bankRowKeys("account",[row,other]);
  assert.deepEqual(keys,bankRowKeys("account",[row,other]));
  for (const key of keys) assert.match(key,/^[0-9a-f]{64}$/);
});

test("identical rows receive distinct keys", () => {
  const keys = bankRowKeys("account",[row,row]);
  assert.notEqual(keys[0],keys[1]);
});

test("reordered files preserve the key set", () => {
  const keys = bankRowKeys("account",[row,other,row]);
  const reordered = bankRowKeys("account",[row,row,other]);
  assert.deepEqual(new Set(keys),new Set(reordered));
});

test("different accounts change row keys", () => {
  assert.notEqual(bankRowKeys("account",[row])[0],bankRowKeys("other",[row])[0]);
});

test("memo whitespace is normalized", () => {
  assert.deepEqual(
    bankRowKeys("account",[{...row,memo:"  payment\t received\n "}]),
    bankRowKeys("account",[{...row,memo:"payment received"}]),
  );
});

test("memo case is normalized", () => {
  assert.deepEqual(
    bankRowKeys("account",[{...row,memo:"Payment"}]),
    bankRowKeys("account",[{...row,memo:"payment"}]),
  );
});

test("memo fullwidth characters are NFKC normalized", () => {
  assert.deepEqual(
    bankRowKeys("account",[{...row,memo:"Ｐａｙｍｅｎｔ"}]),
    bankRowKeys("account",[{...row,memo:"payment"}]),
  );
});

test("decision digests include reason and payment", () => {
  const input = {decision:"match",bankId:"bank",paymentId:"payment",reason:"confirmed_amount"};
  const digest = bankDecisionDigest(input);
  assert.match(digest,/^[0-9a-f]{64}$/);
  assert.equal(digest,bankDecisionDigest(input));
  assert.notEqual(digest,bankDecisionDigest({...input,reason:"other"}));
  assert.notEqual(digest,bankDecisionDigest({...input,paymentId:"other"}));
});

test("isUuid accepts UUIDs and rejects invalid values", () => {
  assert.equal(isUuid("AABBCCDD-1234-5678-90AB-1234567890AB"),true);
  assert.equal(isUuid("x"),false);
});

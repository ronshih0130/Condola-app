import assert from "node:assert/strict";
import test from "node:test";
import { buildSnapshot, computeOwnerNet, reconcileSnapshot, snapshotAmountKeys, type OwnerNetInput } from "./owner-net-ledger-rules";

const input: OwnerNetInput = {opening:BigInt(100),companyRent:BigInt(1000),directRent:BigInt(900),otherIncome:BigInt(50),
  managementFee:BigInt(100),expenses:BigInt(200),payouts:BigInt(300),prepayDraws:BigInt(0)};
const context = {currency:"USD",periodStart:"2028-02-01",periodEnd:"2028-02-29",statementId:"statement",calculationFingerprint:"calculation"};
test("positive, zero and negative balances keep informational lines outside the identity",()=>{
  const result=computeOwnerNet(input);
  assert.equal(result.closing,BigInt(550)); assert.equal(result.net,BigInt(450)); assert.equal(result.closingNegative,false);
  assert.deepEqual(result.lines.map(l=>l.key),["opening","company_rent","direct_rent","other_income","management_fee","expenses","prepay_draws","payouts","closing"]);
  assert.deepEqual(result.lines.filter(l=>!l.affectsBalance).map(l=>l.key),["direct_rent","prepay_draws"]);
  const even=computeOwnerNet({...input,payouts:BigInt(850)}); assert.equal(even.closing,BigInt(0)); assert.equal(even.closingNegative,false);
  assert.equal(computeOwnerNet({...input,payouts:BigInt(851)}).closingNegative,true);
  assert.equal(computeOwnerNet({...input,directRent:BigInt("9000000000000000"),prepayDraws:BigInt(99)}).closing,result.closing);
});
test("snapshot arithmetic and stable fingerprints preserve integers above 2^53",()=>{
  const big={...input,opening:BigInt("9007199254740993")};
  const snapshot=buildSnapshot(big,context);
  assert.equal(snapshot.closing_minor,"9007199254741443"); assert.equal(reconcileSnapshot(snapshot),true);
  assert.deepEqual(buildSnapshot(big,{...context}),snapshot);
  assert.notEqual(buildSnapshot(big,{...context,calculationFingerprint:"changed"}).fingerprint,snapshot.fingerprint);
  assert.notEqual(buildSnapshot({...big,directRent:BigInt(901)},context).fingerprint,snapshot.fingerprint);
  assert.equal(snapshot.schema,"b014-v1"); assert.equal(snapshot.reserved_prepay,true); assert.equal(snapshot.deposits_excluded,true);
});
test("snapshot validation rejects altered identity, reserved draws, invalid strings and overflow",()=>{
  const snapshot=buildSnapshot(input,context);
  assert.equal(reconcileSnapshot({...snapshot,closing_minor:"551"}),false);
  assert.equal(reconcileSnapshot({...snapshot,prepay_draws_minor:"1"}),false);
  assert.throws(()=>buildSnapshot({...input,prepayDraws:BigInt(1)},context));
  for (const field of snapshotAmountKeys) {
    for (const value of [undefined,null,0,1.5,"1.5","1e3"," 1","","12345678901234567890"]) {
      assert.equal(reconcileSnapshot({...snapshot,[field]:value}),false,`${field}: ${value}`);
    }
  }
  assert.equal(reconcileSnapshot({...snapshot,opening_minor:"9223372036854775807",closing_minor:"9223372036854776257"}),false);
  for (const value of [null,undefined,[],"snapshot"]) assert.equal(reconcileSnapshot(value),false);
});

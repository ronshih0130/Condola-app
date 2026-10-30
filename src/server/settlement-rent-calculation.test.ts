import assert from "node:assert/strict";
import test from "node:test";
import { calculateReconciledRent } from "./settlement-rent-calculation";
const base={depositMinor:4000,unrelatedDeductions:[300],finalRentMinor:1600,rentCashMinor:3000,chargedRentMinor:3000,sourceCoverage:"verified" as const,outstanding:"resolved" as const,priorOutcomes:"reconciled" as const};
test("rent credit is distinct from deposit and charge adjustment, contributing once",()=>{
  assert.deepEqual(calculateReconciledRent(base),{authoritative:true,netMinor:5100,refundMinor:5100,topUpMinor:0,chargeAdjustmentMinor:-1400,rentAdjustmentMinor:1400});
  const due=calculateReconciledRent({...base,depositMinor:100,unrelatedDeductions:[300],rentCashMinor:1200});assert.equal(due.rentAdjustmentMinor,-400);assert.equal(due.netMinor,-600);assert.equal(due.topUpMinor,600);assert.equal(due.refundMinor,0);
  const equal=calculateReconciledRent({...base,finalRentMinor:3000});assert.equal(equal.chargeAdjustmentMinor,0);assert.equal(equal.rentAdjustmentMinor,0);assert.equal(equal.netMinor,3700);
});
test("missing facts or unresolved sources never yield authoritative net",()=>{
  for(const value of [{...base,sourceCoverage:"unknown" as const},{...base,outstanding:"unresolved" as const,rentCashMinor:1200},{...base,priorOutcomes:"unresolved" as const},{...base,rentCashMinor:null}])assert.equal(calculateReconciledRent(value).authoritative,false);
  assert.throws(()=>calculateReconciledRent({...base,rentCashMinor:-1}));
  assert.throws(()=>calculateReconciledRent({...base,depositMinor:Number.MAX_SAFE_INTEGER}));
});

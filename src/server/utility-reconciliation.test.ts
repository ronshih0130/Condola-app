import assert from "node:assert/strict";
import test from "node:test";
import { reconcileUtility } from "./utility-reconciliation";
test("utility conservation includes vacant, public, gap and remainder in both directions", () => {
  for (const [bill,tenant,owner,publicAmountMinor,billGapMinor,remainderMinor] of [[1000,400,100,200,250,50],[0,0,0,0,0,0],[500,600,100,-100,-150,50]] as const) {
    const result = reconcileUtility(bill,tenant,owner,{publicAmountMinor,billGapMinor,remainderMinor});
    assert.ok(result); assert.equal(result.difference,0);
    assert.equal(reconcileUtility(bill+1,tenant,owner,{publicAmountMinor,billGapMinor,remainderMinor})?.difference,1);
  }
  assert.equal(reconcileUtility(null,0,0,{}),null);
  assert.equal(reconcileUtility(100,0,0,{publicAmountMinor:0,billGapMinor:0}),null);
});

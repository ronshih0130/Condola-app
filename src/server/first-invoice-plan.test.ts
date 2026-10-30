import assert from "node:assert/strict";
import test from "node:test";
import { FIRST_PERIOD_VERSION, firstInvoicePlan } from "./first-invoice-plan";

test("legacy source keeps rent, deposit and actual utility lines", () => {
  const result=firstInvoicePlan({rentMinor:1000000,depositMinor:2000000,utility:{id:"allocation",amountMinor:15000},basis:null});
  assert.equal(result.calculation,null);
  assert.deepEqual(result.lines.map((line)=>[line.type,line.amount,line.allocationId]),[["rent",1000000,null],["deposit",2000000,null],["utility",15000,"allocation"]]);
  assert.equal(result.totalMinor,3015000);
});

test("captured basis supplies the exact rent used in the invoice line", () => {
  const basis={version:FIRST_PERIOD_VERSION,actor:"20000000-0000-4000-8000-000000000001",capturedAt:"2026-01-01T00:00:00Z",startDate:"2028-02-15",endDate:"2029-02-14",monthlyRentMinor:1000100,currency:"TWD",rentFrequency:"monthly",prorateFirstPeriod:true};
  const result=firstInvoicePlan({rentMinor:9000000,depositMinor:100000,utility:null,basis});
  assert.equal(result.lines[0].amount,500100);
  assert.equal(result.lines[0].amount,result.calculation?.rentMinor);
  assert.equal(result.totalMinor,600100);
  assert.throws(()=>firstInvoicePlan({rentMinor:1,depositMinor:0,utility:null,basis:{...basis,version:"unknown"}}));
  assert.throws(()=>firstInvoicePlan({rentMinor:1,depositMinor:0,utility:null,basis:{...basis,actor:null}}));
});

import assert from "node:assert/strict";
import test from "node:test";
import { calculateFinalRent, calculateSettlement } from "./settlement-calculation";
const base = {country:"TW",currency:"TWD",frequency:"monthly",monthlyMinor:3000000,periodStart:"2028-02-01",periodEnd:"2028-02-29",leaseStart:"2028-01-01",moveOut:"2028-02-29"};
test("approved final rent uses known periods, inclusive days and whole TWD rounding",()=>{
  assert.equal(calculateFinalRent(base).amountMinor,3000000);
  assert.equal(calculateFinalRent({...base,periodStart:"2027-01-01",periodEnd:"2027-01-31",leaseStart:"2026-01-01",moveOut:"2027-01-31"}).amountMinor,3000000);
  assert.equal(calculateFinalRent({...base,moveOut:"2028-02-16"}).amountMinor,1600000);
  // A short first-period charge is not the full agreed monthly cycle.
  assert.equal(calculateFinalRent({...base,leaseStart:"2028-02-15",moveOut:"2028-02-29"}).amountMinor,1500000);
  // The agreed cycle may begin mid-month; it need not be a calendar month.
  assert.equal(calculateFinalRent({...base,periodStart:"2028-02-15",periodEnd:"2028-03-14",leaseStart:"2028-01-01",moveOut:"2028-03-14"}).amountMinor,3000000);
  assert.equal(calculateFinalRent({...base,monthlyMinor:100,moveOut:"2028-02-15"}).amountMinor,100); // half-up once to one TWD
  assert.equal(calculateFinalRent({...base,periodStart:"2027-01-01",periodEnd:"2027-01-31",leaseStart:"2027-01-02",moveOut:"2027-01-31"}).amountMinor,3000000);
  for (const value of [{...base,monthlyMinor:101},{...base,currency:"USD"},{...base,frequency:"yearly"},{...base,moveOut:"2028-02-30"},{...base,moveOut:"2028-03-01"},{...base,monthlyMinor:Number.MAX_SAFE_INTEGER},{...base,periodStart:"2028-01-01",periodEnd:"2028-12-31",moveOut:"2028-01-10"},{...base,periodStart:"2028-02-01",periodEnd:"2028-02-01",moveOut:"2028-02-01"}]) assert.throws(()=>calculateFinalRent(value));
});
test("unknown deposit is not a net and known amounts conserve value",()=>{
  assert.deepEqual(calculateSettlement(null,[100]),{authoritative:false,netMinor:null,refundMinor:null,topUpMinor:null});
  assert.deepEqual(calculateSettlement(1000,[300,200]),{authoritative:true,netMinor:500,refundMinor:500,topUpMinor:0});
  assert.deepEqual(calculateSettlement(1000,[1200]),{authoritative:true,netMinor:-200,refundMinor:0,topUpMinor:200});
  assert.throws(()=>calculateSettlement(1,[-1])); assert.throws(()=>calculateSettlement(0,[Number.MAX_SAFE_INTEGER,1]));
});

import assert from "node:assert/strict";
import test from "node:test";
import { calculateFirstPeriod } from "./first-period-calculation";

test("partial period uses inclusive days and rounds once to the existing currency unit", () => {
  const base={startDate:"2028-02-15",endDate:"2029-02-14",monthlyRentMinor:1000100,currency:"TWD",rentFrequency:"monthly",prorateFirstPeriod:true};
  const tw=calculateFirstPeriod(base);
  assert.deepEqual([tw.periodStart,tw.periodEnd,tw.days,tw.denominator,tw.rentMinor,tw.prorated],["2028-02-15","2028-02-29",15,30,500100,true]);
  const usd=calculateFirstPeriod({...base,currency:"USD",monthlyRentMinor:10001});
  assert.equal(usd.rentMinor,5001);
  const shorter=calculateFirstPeriod({...base,endDate:"2028-02-20"});
  assert.equal(shorter.days,6);
  assert.equal(shorter.rentMinor,200000);
  assert.equal(calculateFirstPeriod({...base,startDate:"2027-01-02",endDate:"2027-01-31",monthlyRentMinor:100000}).rentMinor,100000);
  assert.equal(calculateFirstPeriod({...base,monthlyRentMinor:0}).rentMinor,0);
});

test("full calendar months and the explicit false choice keep full monthly rent", () => {
  for (const [start,end] of [["2028-02-01","2028-02-29"],["2027-02-01","2027-02-28"],["2027-01-01","2027-01-31"]]) {
    const full=calculateFirstPeriod({startDate:start,endDate:end,monthlyRentMinor:100000,currency:"TWD",rentFrequency:"monthly",prorateFirstPeriod:true});
    assert.equal(full.rentMinor,100000); assert.equal(full.prorated,false);
  }
  const optedOut=calculateFirstPeriod({startDate:"2027-01-15",endDate:null,monthlyRentMinor:100000,currency:"TWD",rentFrequency:"quarterly",prorateFirstPeriod:false});
  assert.equal(optedOut.rentMinor,100000); assert.equal(optedOut.days,17);
});

test("invalid source dates, ordering, amounts and TWD fractions fail closed", () => {
  const base={startDate:"2027-01-15",endDate:null,monthlyRentMinor:100000,currency:"TWD",rentFrequency:"monthly",prorateFirstPeriod:true};
  for (const patch of [{startDate:"2027-02-29"},{endDate:"2027-01-14"},{monthlyRentMinor:100001},{monthlyRentMinor:-1},{currency:""},{currency:"JPY"},{rentFrequency:"quarterly"}]) assert.throws(()=>calculateFirstPeriod({...base,...patch}));
  assert.throws(()=>calculateFirstPeriod({...base,prorateFirstPeriod:"true" as unknown as boolean}));
});

import test from "node:test";
import assert from "node:assert/strict";
import { renewalMinor,renewalMajor,validRenewalDate,parseRenewalInput,renewalDiff } from "./renewal-comparison";
import type { RenewalInput, RenewalTerms } from "./renewal-comparison";
const current={startDate:"2024-01-01",endDate:null,rentMinor:"10000",frequency:"monthly",dueDay:31,depositMinor:"20000",currency:"TWD",minorUnit:2};
test("exact decimal parsing honors currency scale and bigint bounds",()=>{assert.equal(renewalMinor("12.34",2),"1234");assert.equal(renewalMinor("0",0),"0");assert.equal(renewalMinor("1.2345",4),"12345");for(const bad of [""," ","1e2","-1","1.234","NaN"])assert.equal(renewalMinor(bad,2),null);assert.equal(renewalMinor("92233720368547758.08",2),null);assert.equal(renewalMajor("12345",4),"1.2345");});
test("calendar boundaries and explicit terms",()=>{assert.equal(validRenewalDate("2024-02-29"),true);assert.equal(validRenewalDate("2023-02-29"),false);assert.equal(validRenewalDate("0000-01-01"),false);const proposal=parseRenewalInput({startDate:"2025-01-01",endMode:"date",endDate:"2025-12-31",rent:"100.00",frequency:"yearly",dueDay:"31",deposit:"200.00"},current);assert.ok(proposal);assert.equal(renewalDiff(current,proposal).frequency,true);assert.equal(parseRenewalInput({startDate:"2025-02-01",endMode:"date",endDate:"2025-01-01",rent:"0",frequency:"monthly",dueDay:"0",deposit:"0"},current),null);});
test("open-ended proposal is explicit and never inferred from blank",()=>{const base={startDate:'2025-01-01',endMode:'open_ended',endDate:'',rent:'1',frequency:'monthly',dueDay:'1',deposit:'0'};const open=parseRenewalInput(base,current);assert.ok(open);assert.equal(open.endDate,null);assert.equal(parseRenewalInput({...base,endMode:'date'},current),null);assert.equal(parseRenewalInput({...base,endDate:'2025-12-31'},current),null);assert.equal(parseRenewalInput({...base,endMode:'other'},current),null);const fixed=parseRenewalInput({...base,endMode:'date',endDate:'2025-12-31'},current);assert.ok(fixed);assert.equal(renewalDiff(open,fixed).endDate,true);});

const fixedCurrent: RenewalTerms = {
  startDate: "2030-01-01", endDate: "2030-12-31", rentMinor: "10000",
  frequency: "monthly", dueDay: 1, depositMinor: "20000", currency: "USD", minorUnit: 2,
};
const fixedInput: RenewalInput = {
  startDate: "2030-01-01", endMode: "date", endDate: "2030-12-31",
  rent: "100.00", frequency: "monthly", dueDay: "1", deposit: "200.00",
};
const changedInput: RenewalInput = {
  startDate: "2031-01-01", endMode: "date", endDate: "2031-12-31",
  rent: "123.45", frequency: "quarterly", dueDay: "15", deposit: "250.00",
};
const unchanged = { startDate: false, endDate: false, rent: false, frequency: false, dueDay: false, deposit: false };

test("comparison exposes every changed term", () => {
  const proposed = parseRenewalInput(changedInput, fixedCurrent);
  assert.deepEqual(proposed, {
    startDate: "2031-01-01", endDate: "2031-12-31", rentMinor: "12345",
    frequency: "quarterly", dueDay: 15, depositMinor: "25000", currency: "USD", minorUnit: 2,
  });
  assert.ok(proposed);
  assert.deepEqual(renewalDiff(fixedCurrent, proposed), {
    startDate: true, endDate: true, rent: true, frequency: true, dueDay: true, deposit: true,
  });
  const same = parseRenewalInput(fixedInput, fixedCurrent);
  assert.deepEqual(same, fixedCurrent);
  assert.ok(same);
  assert.deepEqual(renewalDiff(fixedCurrent, same), unchanged);

  // Change one field at a time: one comparator cannot stand in for another.
  for (const key of Object.keys(unchanged) as (keyof typeof unchanged)[]) {
    const value = key === "startDate" ? "2030-02-01" : changedInput[key];
    const single = parseRenewalInput({ ...fixedInput, [key]: value }, fixedCurrent);
    assert.ok(single, key);
    assert.deepEqual(renewalDiff(fixedCurrent, single), { ...unchanged, [key]: true }, key);
  }
});

test("missing terms reject independently, including explicit open-ended mode", () => {
  for (const endMode of ["date", "open_ended"] as const) {
    const valid = { ...changedInput, endMode, endDate: endMode === "date" ? changedInput.endDate : "" };
    assert.ok(parseRenewalInput(valid, fixedCurrent), endMode);
    for (const key of Object.keys(valid) as (keyof RenewalInput)[]) {
      const omitted: Partial<RenewalInput> = { ...valid };
      delete omitted[key];
      assert.equal(parseRenewalInput(omitted as RenewalInput, fixedCurrent), null, `${endMode}: omitted ${key}`);
      for (const blank of ["", " "]) {
        if (endMode === "open_ended" && key === "endDate" && blank === "") continue;
        assert.equal(parseRenewalInput({ ...valid, [key]: blank }, fixedCurrent), null, `${endMode}: blank ${key}`);
      }
    }
  }
});

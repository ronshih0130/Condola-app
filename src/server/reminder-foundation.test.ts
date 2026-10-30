import assert from "node:assert/strict";
import test from "node:test";
import { localReminderDate, planScheduledReminder, reminderEligible, type ReminderCandidate } from "./reminder-foundation";

const invoice: ReminderCandidate = { leaseStatus:"active", terminatedOn:null, invoiceStatus:"open", balanceMinor:100, hasRent:true, dueDate:"2026-03-08", timeZone:"America/Los_Angeles" };
const schedule = {due:[-3,0],overdue:[1,7]};

test("uses organization calendar dates across DST and stable due-date occurrence keys", () => {
  assert.equal(localReminderDate(new Date("2026-03-08T07:59:59Z"), "America/Los_Angeles"), "2026-03-07");
  assert.equal(localReminderDate(new Date("2026-03-08T08:00:00Z"), "America/Los_Angeles"), "2026-03-08");
  assert.deepEqual(planScheduledReminder(invoice,schedule,new Date("2026-03-08T10:00:00Z")), [{kind:"rent_due",localDate:"2026-03-08",occurrenceKey:"2026-03-08:0"}]);
  assert.deepEqual(planScheduledReminder(invoice,schedule,new Date("2026-03-09T07:00:00Z")), [{kind:"rent_overdue",localDate:"2026-03-09",occurrenceKey:"2026-03-08:1"}]);
  assert.equal(localReminderDate(new Date("2026-03-08T08:00:00Z"),"Asia/Taipei"),"2026-03-08");
});

test("paid, terminated, non-rent and invalid invoice balances cannot produce reminders", () => {
  for (const change of [{leaseStatus:"terminated"},{terminatedOn:"2026-03-01"},{invoiceStatus:"paid"},{balanceMinor:0},{balanceMinor:-1},{hasRent:false}]) {
    const candidate={...invoice,...change};
    assert.equal(reminderEligible(candidate),false);
    assert.deepEqual(planScheduledReminder(candidate,schedule,new Date("2026-03-08T12:00:00Z")),[]);
  }
});

test("bad zones, calendar dates and offset configuration fail closed", () => {
  assert.throws(()=>planScheduledReminder({...invoice,timeZone:"bad/zone"},schedule,new Date()));
  assert.throws(()=>planScheduledReminder({...invoice,dueDate:"2026-02-30"},schedule,new Date()));
  assert.throws(()=>planScheduledReminder(invoice,{due:[1],overdue:[]},new Date()));
  assert.throws(()=>planScheduledReminder(invoice,{due:[0],overdue:[NaN]},new Date()));
});

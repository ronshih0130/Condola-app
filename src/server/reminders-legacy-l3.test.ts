// QA B010 L3 (receipts/qa-B010-B018/verdict.md): the legacy reminder cron must
// not send overdue mail for a lease that has ended, and must take "today" from
// the organization's own time zone, not a fixed Asia/Taipei date.
// Uses only planners that already existed before the fix, so it is a
// red-on-base proof.
import assert from "node:assert/strict";
import test from "node:test";
import { planLeaseReminders, planOverdueReminders } from "./reminders";

const origin = "https://app.condola.app";
const staff = [{ name: "林雅婷", email: "admin@example.com", prefs: {} }];
const overdue = {
  orgId: "org-1", invoiceId: "inv-1", environment: "live", dueDate: "2026-10-30", periodStart: "2026-10-01",
  balanceMinor: 1800000, orgName: "松信管理", contactEmail: null as string | null, contactPhone: null as string | null,
  settings: {}, propertyName: "府後街", address: "台中市西區府後街38號", unitLabel: "3F", roomLabel: "A",
  tenants: [{ name: "周美玲", email: "tenant@example.com" }], staff, origin, leaseStatus: "active",
};
const lease = {
  orgId: "org-1", leaseId: "lease-1", environment: "live", status: "active", renewalStatus: "none",
  startDate: "2025-12-31", endDate: "2026-11-30", rentMinor: 1800000, orgName: "松信管理",
  contactEmail: "firm@example.com", contactPhone: "04-2222-3333", settings: {}, propertyName: "府後街",
  address: "台中市西區府後街38號", unitLabel: "3F", roomLabel: "A", ownerName: "陳屋主",
  tenants: [{ name: "周美玲", email: "tenant@example.com" }], staff, origin,
};

test("L3: a lease that has ended, been terminated or cancelled gets no overdue reminder", () => {
  assert.equal(planOverdueReminders(overdue, "2026-10-31").length, 2, "control: an active lease on day 1 is reminded");
  for (const leaseStatus of ["ended", "terminated", "cancelled", "draft", "pending_signature"]) {
    assert.deepEqual(planOverdueReminders({ ...overdue, leaseStatus }, "2026-10-31"), [], `L3 ended lease still reminded: status ${leaseStatus}`);
  }
  assert.deepEqual(planOverdueReminders({ ...overdue, leaseTerminatedOn: "2026-10-15" }, "2026-10-31"), [], "L3 ended lease still reminded: terminated_on set");
});

// 2026-10-31T20:00Z is 2026-11-01 04:00 in Taipei but 2026-10-31 13:00 in Los Angeles.
const taipeiDate = "2026-11-01";
const losAngelesDate = "2026-10-31";

test("L3: the overdue day is counted on the organization's own date, not Asia/Taipei", () => {
  const plans = planOverdueReminders({ ...overdue, orgToday: losAngelesDate }, taipeiDate);
  assert.deepEqual(plans.map((p) => `${p.kind}:${p.threshold}`), ["rent_overdue_admin:1", "rent_overdue_tenant:1"], "L3 overdue day counted on Asia/Taipei date");
});

test("L3: lease-ending reminders count days on the organization's own date, not Asia/Taipei", () => {
  const plans = planLeaseReminders({ ...lease, orgToday: losAngelesDate }, taipeiDate);
  assert.deepEqual(plans.map((p) => `${p.kind}:${p.threshold}`), ["lease_expiry_admin:30", "lease_expiry_tenant:30"], "L3 lease days counted on Asia/Taipei date");
});

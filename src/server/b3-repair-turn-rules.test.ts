import assert from "node:assert/strict";
import test from "node:test";
import { repairTurn, vendorRepairTurn, type RepairTurnInput, type RepairStatus } from "./b3-repair-turn-rules";
import { turnDayNumber } from "./b3-payment-turns";
const date = "2026-11-01T10:00:00Z";
const base: RepairTurnInput = { status: "open", approvals: true, dispatch: true, currentJob: false, capability: false,
  dispatchAllowed: false, retainedEstimate: false, requiresOwner: false, decision: null, emergency: false,
  reported: false, confirmed: false, event: "none", submittedAt: date, decidedAt: date, reportedAt: date,
  eventAt: date, jobCreatedAt: date, resolvedAt: date, fallbackAt: date, uninterrupted: true };
const work = { currentJob: true, capability: true, dispatchAllowed: true };
const cases: [string, Partial<RepairTurnInput>, string, string, boolean][] = [
  ["R1", { status: "closed", ...work, reported: true, requiresOwner: true, emergency: true }, "none", "done", false],
  ["R2", { ...work, reported: true, requiresOwner: true }, "manager", "confirm_cost", true],
  ["R3", { status: "resolved", requiresOwner: true }, "owner", "approve_estimate", true],
  ["R5", { decision: "rejected" }, "manager", "re_estimate", true],
  ["R6", { ...work, event: "vendor_rejected" }, "manager", "dispatch", true],
  ["R7a", { ...work, status: "resolved", event: "vendor_completion_submitted" }, "vendor", "report_cost", true],
  ["R7b", work, "vendor", "do_repair", false],
  ["R8-blocked", { status: "resolved", emergency: true }, "manager", "dispatch", false],
  ["R4", { status: "resolved" }, "none", "done", false],
  ["R8", {}, "manager", "dispatch", false],
];
for (const [rule, input, holder, step, exact] of cases) test(`PLT-52/53 first-match ${rule}`, () => {
  const result = repairTurn({ ...base, ...input });
  assert.equal(result.rule, rule); assert.equal(result.holder, holder); assert.equal(result.step, step); assert.equal(result.sinceExact, exact);
  assert.equal(vendorRepairTurn(result).viewerCanAct, rule === "R7a" || rule === "R7b");
});
test("B1–B3: terminals dominate; all resolved/emergency/current-job truth-table rows", () => {
  for (const resolved of [false, true]) for (const emergency of [false, true]) for (const currentJob of [false, true]) {
    const input = { ...base, ...work, status: (resolved ? "resolved" : "open") as RepairStatus, emergency, currentJob };
    assert.equal(repairTurn(input).rule, currentJob ? "R7b" : emergency ? "R8-blocked" : resolved ? "R4" : "R8");
    for (const status of ["closed", "cancelled"] as const) assert.equal(repairTurn({ ...input, status, reported: true }).rule, "R1");
  }
  for (const decision of ["rejected", "more_information"] as const) {
    assert.equal(repairTurn({ ...base, ...work, emergency: true, decision }).rule, "R7b");
    assert.equal(repairTurn({ ...base, ...work, emergency: true, decision, event: "vendor_rejected" }).rule, "R6");
  }
});
test("B-026 closure guard takes priority over reporting and resolved, all flags", () => {
  for (const approvals of [false, true]) for (const dispatch of [false, true]) for (const retainedEstimate of [false, true]) {
    const input = { ...base, ...work, approvals, dispatch, retainedEstimate, status: "resolved" as const, reported: true };
    assert.equal(repairTurn(input).rule, dispatch && (!retainedEstimate || approvals) ? "R2" : "R8-blocked");
    if (!approvals) assert.equal(repairTurn({ ...input, reported: false }).rule, dispatch && !retainedEstimate ? "R7b" : "R8-blocked");
  }
  assert.equal(repairTurn({ ...base, ...work, status: "resolved", reported: true, retainedEstimate: true, dispatchAllowed: false }).rule, "R8-blocked");
  const pending = { ...base, ...work, reported: true, dispatchAllowed: false, requiresOwner: true, retainedEstimate: true };
  assert.equal(repairTurn(pending).rule, "R3");
  assert.equal(repairTurn({ ...pending, decision: "rejected" }).rule, "R5");
  assert.equal(repairTurn({ ...pending, retainedEstimate: false }).rule, "R2");
  assert.equal(repairTurn({ ...base, ...work, requiresOwner: true, dispatchAllowed: false, event: "vendor_rejected" }).rule, "R3");
});
test("all enums; disabled private inputs cannot affect legacy output", () => {
  for (const status of ["open", "triaged", "assigned", "in_progress", "on_hold", "resolved", "closed", "cancelled"] as const) {
    const result = repairTurn({ ...base, status });
    assert.equal(result.rule, ["closed", "cancelled"].includes(status) ? "R1" : status === "resolved" ? "R4" : "R8");
    assert.deepEqual(repairTurn({ ...base, ...work, status, approvals: false }), repairTurn({ ...base, ...work,
      status, approvals: false, emergency: true, requiresOwner: true, decision: "rejected", event: "vendor_rejected" }));
  }
});
test("time: sharing delay, emergency-before-approval, interruptions, DST/property-local day", () => {
  const input = { ...base, ...work, sharingRequired: true, requiresOwner: true, emergency: true, authorizedAt: date,
    decision: "approved" as const, decidedAt: "2026-11-05T10:00:00Z", sharingApprovedAt: "2026-11-03T10:00:00Z" };
  assert.equal(repairTurn(input).since, input.sharingApprovedAt);
  for (const [, state] of cases) assert.equal(repairTurn({ ...base, ...state, uninterrupted: false }).sinceExact, false);
  assert.equal(turnDayNumber({ since: "2026-11-01T06:30:00Z", sinceExact: true, timezone: "America/Los_Angeles" }, new Date("2026-11-02T08:30:00Z")), 3);
  assert.equal(turnDayNumber({ since: date, sinceExact: false, timezone: "America/Los_Angeles" }), null);
});

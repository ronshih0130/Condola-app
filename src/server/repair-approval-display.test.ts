import assert from "node:assert/strict";
import test from "node:test";
import {
  approvalAmount, assertDecision, decisionLabel, emergencyPhotoRefShape,
  evidenceShapeOk, intentStatusLabel, pendingClassify, reapprovalHint,
} from "./repair-approval-rules";
import { repairApprovalCopy } from "../i18n/repair-approval";

test("pendingClassify respects the captured requirement, head and terminal decision", () => {
  for (const [requiresOwnerDecision, isCurrent, decision, expected] of [
    [true, true, null, "pending_approval"],
    [false, true, null, "policy_qualified"],
    [true, false, null, "superseded"],
    [true, false, "approved", "superseded"],
    [true, true, "approved", "approved"],
    [true, true, "rejected", "rejected"],
    [true, true, "more_information", "more_information"],
  ] as const) {
    assert.equal(pendingClassify({ requiresOwnerDecision, isCurrent, decision }), expected);
  }
});
test("decision labels and reasons", () => {
  assert.equal(decisionLabel(null), "undecided");
  assert.equal(decisionLabel("unknown"), "undecided");
  for (const decision of ["approved", "rejected", "more_information"] as const) {
    assert.equal(decisionLabel(decision), decision);
    assert.doesNotThrow(() => assertDecision({ decision, reason: "Please clarify" }));
    if (decision !== "approved") assert.throws(() => assertDecision({ decision, reason: " " }));
  }
});
test("intent status is intent only and superseded approval does not carry forward", () => {
  assert.equal(intentStatusLabel(null), "—");
  assert.equal(intentStatusLabel(undefined), "—");
  assert.equal(intentStatusLabel("2026-11-05T12:00:00Z"), "intent recorded");
  assert.equal(reapprovalHint(true), null);
  assert.match(reapprovalHint(false)!, /earlier approval does not carry forward/);
  for (const locale of ["zh-TW", "en"]) {
    assert.doesNotMatch(JSON.stringify(repairApprovalCopy(locale)), /\b(sent|delivered|landlord|payment|demo)\b|示範|測試模式|即將推出|LINE 登入與推播/i);
  }
});
test("emergencyPhotoRefShape bounds and evidence's empty-list allowance", () => {
  assert.equal(evidenceShapeOk([]), true);
  for (const value of [null, {}, [], [{ id: "" }], [{ id: " " }], [{ id: 1 }],
    Array.from({ length: 9 }, () => ({ id: "p" }))]) assert.equal(emergencyPhotoRefShape(value), false);
  assert.equal(emergencyPhotoRefShape([{ id: "p", private: "not a display reference" }]), true);
  assert.equal(emergencyPhotoRefShape(Array.from({ length: 8 }, () => ({ id: "p" }))), true);
});
test("amount formatting preserves bigint values and currency scale", () => {
  assert.equal(approvalAmount("9223372036854775807", "USD", 2), "USD 92233720368547758.07");
  assert.equal(approvalAmount("1", "USD", 2), "USD 0.01");
  assert.equal(approvalAmount("500000", "TWD", 0), "TWD 500000");
  assert.throws(() => approvalAmount("-1", "TWD", 0));
});

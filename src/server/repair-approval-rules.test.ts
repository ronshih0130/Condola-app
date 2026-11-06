import assert from "node:assert/strict";
import test from "node:test";
import { FlowError } from "./errors";
import {
  assertAppointment,
  assertDecision,
  assertEmergency,
  assertEstimate,
  classifyThreshold,
  evidenceShapeOk,
  reminderDue,
  requiresNewVersion,
  stableJson,
  vendorRejectionKeepsOpen,
  type EstimateSnapshot,
} from "./repair-approval-rules";

for (const [name, amount, threshold, expected] of [
  ["equal", 100, 100, "policy_qualified"],
  ["less", 99, 100, "policy_qualified"],
  ["greater", 101, 100, "pending_approval"],
  ["zero", 0, 0, "policy_qualified"],
  ["bigint equal", BigInt("9007199254740993"), BigInt("9007199254740993"), "policy_qualified"],
  ["bigint less", BigInt("9007199254740992"), BigInt("9007199254740993"), "policy_qualified"],
  ["bigint greater", BigInt("9007199254740993"), BigInt("9007199254740992"), "pending_approval"],
  ["mixed", BigInt(101), 100, "pending_approval"],
] as const) {
  test("thresholdStrictGt: " + name, () => {
    assert.equal(classifyThreshold(amount, threshold), expected);
  });
}

for (const amount of [Number.MAX_SAFE_INTEGER + 1, -1, 1.5, NaN, Infinity]) {
  test("thresholdStrictGt rejects invalid number: " + String(amount), () => {
    assert.throws(() => classifyThreshold(amount, 100), FlowError);
    assert.throws(() => classifyThreshold(100, amount), FlowError);
  });
}

const snapshot: EstimateSnapshot = {
  amountMinor: BigInt(100),
  currency: "TWD",
  minorUnit: 2,
  scope: "Repair pipe",
  evidence: [{ id: "photo-1", metadata: { a: 1, b: 2 } }],
  designatedPrincipal: "owner-1",
};

for (const [name, changes, expected] of [
  ["unchanged", {}, false],
  ["number and bigint agree", { amountMinor: 100 }, false],
  ["amount", { amountMinor: BigInt(101) }, true],
  ["currency", { currency: "USD" }, true],
  ["minor unit", { minorUnit: 0 }, true],
  ["scope", { scope: "Replace pipe" }, true],
  ["evidence", { evidence: [{ id: "photo-2" }] }, true],
  ["evidence metadata", { evidence: [{ id: "photo-1", metadata: { a: 1, b: 3 } }] }, true],
  ["owner", { designatedPrincipal: "owner-2" }, true],
  ["key order", { evidence: [{ metadata: { b: 2, a: 1 }, id: "photo-1" }] }, false],
] satisfies Array<[string, Partial<EstimateSnapshot>, boolean]>) {
  test("requiresNewVersion: " + name, () => {
    assert.equal(requiresNewVersion(snapshot, { ...snapshot, ...changes }), expected);
  });
}

test("requiresNewVersion ignores later default threshold changes", () => {
  const prev = { ...snapshot, capturedThresholdMinor: BigInt(50) };
  const next = { ...snapshot, capturedThresholdMinor: BigInt(200) };
  assert.equal(requiresNewVersion(prev, next), false);
});

for (const [decision, reason, valid] of [
  ["approved", undefined, true],
  ["approved", null, true],
  ["approved", "Reviewed", true],
  ["approved", " ", false],
  ["rejected", undefined, false],
  ["rejected", null, false],
  ["rejected", " ", false],
  ["rejected", "Too costly", true],
  ["more_information", undefined, false],
  ["more_information", " ", false],
  ["more_information", "Please itemize", true],
  ["approve", "Reviewed", false],
  ["approved", "x".repeat(4001), false],
] as const) {
  test("assertDecision: " + decision + "/" + String(reason).slice(0, 30), () => {
    const act = () => assertDecision({ decision, reason });
    if (valid) assert.doesNotThrow(act);
    else assert.throws(act, FlowError);
  });
}

const submittedAt = Date.parse("2026-11-01T00:00:00Z");
const reminder = {
  submittedAt,
  now: submittedAt + 24 * 60 * 60 * 1000,
  requiresOwnerDecision: true,
  hasDecision: false,
  alreadyReminded: false,
};
for (const [name, changes, expected] of [
  ["23h59", { now: submittedAt + (23 * 60 + 59) * 60 * 1000 }, false],
  ["24h", {}, true],
  ["after 24h", { now: reminder.now + 1 }, true],
  ["future submission", { now: submittedAt - 1 }, false],
  ["decided", { hasDecision: true }, false],
  ["already reminded", { alreadyReminded: true }, false],
  ["not requiring decision", { requiresOwnerDecision: false }, false],
] satisfies Array<[string, Partial<typeof reminder>, boolean]>) {
  test("reminderDue: " + name, () => {
    assert.equal(reminderDue({ ...reminder, ...changes }), expected);
  });
}

test("reminderDue accepts equivalent timestamps and never changes the input", () => {
  const input = {
    ...reminder,
    submittedAt: "2026-11-01T08:00:00+08:00",
    now: new Date("2026-11-02T00:00:00Z"),
  };
  const before = structuredClone(input);
  assert.equal(reminderDue(input), true);
  assert.deepEqual(input, before);
  assert.equal(reminderDue({ ...input, alreadyReminded: true }), false);
  assert.throws(() => reminderDue({ ...input, now: "invalid" }), FlowError);
});

const emergency = {
  isAdmin: true,
  category: "water",
  reason: "Active leak",
  photos: [{ id: "photo-1" }],
};
for (const [name, changes, valid] of [
  ["valid water", {}, true],
  ["valid electricity", { category: "electricity" }, true],
  ["valid safety", { category: "safety" }, true],
  ["non-admin", { isAdmin: false }, false],
  ["bad category", { category: "cosmetic" }, false],
  ["empty reason", { reason: " " }, false],
  ["long reason", { reason: "x".repeat(4001) }, false],
  ["0 photos", { photos: [] }, false],
  ["8 photos", { photos: Array.from({ length: 8 }, (_, i) => ({ id: String(i) })) }, true],
  ["9 photos", { photos: Array.from({ length: 9 }, (_, i) => ({ id: String(i) })) }, false],
  ["bad photo", { photos: [{ id: "" }] }, false],
] satisfies Array<[string, Partial<typeof emergency>, boolean]>) {
  test("assertEmergency: " + name, () => {
    const act = () => assertEmergency({ ...emergency, ...changes });
    if (valid) assert.doesNotThrow(act);
    else assert.throws(act, FlowError);
  });
}

for (const status of ["open", "triaged", "assigned", "in_progress", "on_hold", "resolved", "closed", "cancelled"]) {
  test("vendorRejectionKeepsOpen preserves " + status, () => {
    assert.equal(vendorRejectionKeepsOpen(status), status);
  });
}

for (const [name, evidence, expected] of [
  ["empty", [], true],
  ["one", [{ id: "photo-1" }], true],
  ["eight", Array.from({ length: 8 }, (_, i) => ({ id: String(i) })), true],
  ["nine", Array.from({ length: 9 }, (_, i) => ({ id: String(i) })), false],
  ["null", null, false],
  ["object", { id: "photo-1" }, false],
  ["string entry", ["photo-1"], false],
  ["missing id", [{}], false],
  ["numeric id", [{ id: 1 }], false],
  ["blank id", [{ id: " " }], false],
  ["null entry", [null], false],
  ["sparse array", new Array(1), false],
] as const) {
  test("evidenceShapeOk: " + name, () => {
    assert.equal(evidenceShapeOk(evidence), expected);
  });
}

test("stableJson sorts nested keys, preserves array order and encodes bigint exactly", () => {
  assert.equal(stableJson({ z: BigInt("9007199254740993"), a: { b: 2, a: 1 } }),
    '{"a":{"a":1,"b":2},"z":"9007199254740993"}');
  assert.notEqual(stableJson([{ id: "a" }, { id: "b" }]), stableJson([{ id: "b" }, { id: "a" }]));
  const circular: { self?: unknown } = {};
  circular.self = circular;
  for (const invalid of [circular, undefined, NaN, Infinity, new Date(), { a: undefined }, new Array(1)]) {
    assert.throws(() => stableJson(invalid), FlowError);
  }
});

test("assertEstimate checks SQL bigint bounds and estimate shape", () => {
  const input = { amountMinor: BigInt("9223372036854775807"), currency: "TWD", minorUnit: 2,
    workScope: "Repair", evidence: [] };
  assert.doesNotThrow(() => assertEstimate(input));
  for (const changes of [
    { amountMinor: BigInt("9223372036854775808") }, { currency: "twd" },
    { minorUnit: 5 }, { minorUnit: 1.5 }, { workScope: " " }, { evidence: [{}] },
  ]) {
    assert.throws(() => assertEstimate({ ...input, ...changes }), FlowError);
  }
});

test("assertAppointment checks event names, timestamps and confirmation bounds", () => {
  const input = { eventKind: "company_confirmed",
    confirmedStart: "2026-11-05T10:00:00Z", confirmedEnd: "2026-11-05T11:00:00Z" };
  assert.doesNotThrow(() => assertAppointment(input));
  for (const changes of [
    { eventKind: "unknown" }, { confirmedStart: null }, { confirmedEnd: null },
    { confirmedEnd: "2026-11-05T09:00:00Z" }, { confirmedEnd: "invalid" },
    { proposedStart: "2026-11-05T11:00:00Z", proposedEnd: "2026-11-05T10:00:00Z" },
  ]) {
    assert.throws(() => assertAppointment({ ...input, ...changes }), FlowError);
  }
});


test("appointment rejection requires a bounded reason; completion permits photo-backed omission", () => {
  for (const reason of [undefined, null, "", "   ", "x".repeat(4001)]) {
    assert.throws(() => assertAppointment({ eventKind: "vendor_rejected", reason }), FlowError);
  }
  for (const reason of ["x", " x ", "x".repeat(4000), "😀".repeat(4000)]) {
    assert.doesNotThrow(() => assertAppointment({ eventKind: "vendor_rejected", reason }));
  }
  assert.doesNotThrow(() => assertAppointment({ eventKind: "vendor_completion_submitted" }));
  assert.throws(() => assertAppointment({ eventKind: "vendor_completion_submitted", reason: " " }), FlowError);
});

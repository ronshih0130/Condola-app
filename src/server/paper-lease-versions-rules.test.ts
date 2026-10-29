import assert from "node:assert/strict";
import test from "node:test";
import {
  PAPER_LEASE_VERSIONS_ENABLED,
  paperLeaseVersionsOn,
  validatePaperLeaseReason,
} from "./paper-lease-versions-rules";

test("paper versions require the global switch and strict boolean org opt-in", () => {
  assert.equal(PAPER_LEASE_VERSIONS_ENABLED, false);
  assert.equal(paperLeaseVersionsOn(false, { paper_lease_versions: true }), false);
  assert.equal(paperLeaseVersionsOn(true, { paper_lease_versions: true }), true);
  for (const flags of [
    undefined, null, false, "true", [], {},
    { paper_lease_versions: "true" },
    { paper_lease_versions: 1 },
    { paper_lease_versions: false },
    { vendor_link: true },
  ]) {
    assert.equal(paperLeaseVersionsOn(true, flags), false);
  }
});

test("first upload needs no reason; replacements require trimmed 1..500 characters", () => {
  assert.deepEqual(validatePaperLeaseReason(false, undefined), { ok: true, value: null });
  assert.deepEqual(validatePaperLeaseReason(false, null), { ok: true, value: null });
  assert.deepEqual(validatePaperLeaseReason(false, " \n "), { ok: true, value: null });
  for (const value of [undefined, null, "", " \n\t ", 1, {}]) {
    assert.deepEqual(validatePaperLeaseReason(true, value), { ok: false });
  }
  assert.deepEqual(validatePaperLeaseReason(true, "  corrected signature \n"), {
    ok: true, value: "corrected signature",
  });
  assert.deepEqual(validatePaperLeaseReason(true, " x "), { ok: true, value: "x" });
  assert.equal(validatePaperLeaseReason(true, ` ${"a".repeat(500)} `).ok, true);
  assert.equal(validatePaperLeaseReason(true, "a".repeat(501)).ok, false);
  assert.equal(validatePaperLeaseReason(false, "a".repeat(501)).ok, false);
  assert.equal(validatePaperLeaseReason(true, "𠮷".repeat(500)).ok, true);
  assert.equal(validatePaperLeaseReason(true, "𠮷".repeat(501)).ok, false);
});

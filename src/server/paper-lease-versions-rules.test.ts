import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  PAPER_LEASE_REASON_CODES,
  paperLeaseVersionsGlobalEnabled,
  paperLeaseVersionsOn,
  validatePaperLeaseReason,
} from "./paper-lease-versions-rules";

test("the global switch accepts only the exact configured true string", () => {
  assert.equal(paperLeaseVersionsGlobalEnabled("true"), true);
  for (const value of [undefined, null, false, true, 1, "", "false", "TRUE", " true ", "1"]) {
    assert.equal(paperLeaseVersionsGlobalEnabled(value), false);
  }
});

test("paper versions require the global switch and strict boolean org opt-in", () => {
  assert.equal(paperLeaseVersionsGlobalEnabled(undefined), false);
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

test("the default switch keeps the legacy panel path regardless of org opt-in", () => {
  for (const flags of [
    undefined, null, false, true, "true", [], {},
    { paper_lease_versions: true },
    { paper_lease_versions: false },
    { paper_lease_versions: "true" },
    { paper_lease_versions: 1 },
  ]) {
    assert.equal(paperLeaseVersionsOn(paperLeaseVersionsGlobalEnabled(undefined), flags), false);
  }
});

test("replacements accept only a reason code and first uploads store none", () => {
  assert.deepEqual(validatePaperLeaseReason(false, undefined), { ok: true, value: null });
  assert.deepEqual(validatePaperLeaseReason(false, null), { ok: true, value: null });
  assert.deepEqual(validatePaperLeaseReason(false, " \n "), { ok: true, value: null });
  for (const value of [undefined, null, "", " \n\t ", 1, {}, "corrected signature", "更正簽名", "user@example.com", "x".repeat(500)]) {
    assert.deepEqual(validatePaperLeaseReason(true, value), { ok: false });
  }
  for (const code of PAPER_LEASE_REASON_CODES) {
    assert.deepEqual(validatePaperLeaseReason(true, `  ${code} \n`), { ok: true, value: code });
    assert.deepEqual(validatePaperLeaseReason(false, code), { ok: true, value: code });
  }
});

test("the paper panel offers the reason codes and does not collect free text", () => {
  const panel = readFileSync(new URL("./paper-lease-versions-panel.tsx", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../../supabase/migrations/20261031100223_b004_reason_codes.sql", import.meta.url), "utf8");
  assert.match(panel, /<select/);
  assert.doesNotMatch(panel, /<textarea/);
  assert.match(panel, /PAPER_LEASE_REASON_CODES/);
  assert.match(migration, /lease_signed_pdfs_replace_reason_code/);
  assert.match(migration, /VALUES \([\s\S]*\n\s+code\n/);
  assert.doesNotMatch(migration, /VALUES \([\s\S]*NEW\.replace_reason/);
  for (const code of PAPER_LEASE_REASON_CODES) assert.match(migration, new RegExp(code));
});

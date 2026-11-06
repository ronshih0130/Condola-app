import assert from "node:assert/strict";
import test from "node:test";
import { assertCompletion, assertVendorResponse } from "./vendor-job-rules";

const start = "2026-11-06T01:00:00.000Z";
const end = "2026-11-06T02:00:00.000Z";

test("vendor rejection requires a nonblank reason", () => {
  for (const reason of [undefined, null, "", " \n "]) {
    assert.throws(() => assertVendorResponse({ action: "reject", reason }));
  }
  assert.doesNotThrow(() => assertVendorResponse({ action: "reject", reason: "Unavailable" }));
});

test("proposals require an ordered, explicitly zoned pair", () => {
  assert.doesNotThrow(() => assertVendorResponse({
    action: "propose", times: { proposedStart: start, proposedEnd: end },
  }));
  for (const times of [
    undefined, {}, { proposedStart: start }, { proposedEnd: end },
    { proposedStart: end, proposedEnd: start },
    { proposedStart: "invalid", proposedEnd: end },
    { proposedStart: "2026-11-06T09:00", proposedEnd: "2026-11-06T10:00" },
  ]) assert.throws(() => assertVendorResponse({ action: "propose", times }));
});

test("accept_confirm validates confirmed times independently", () => {
  assert.doesNotThrow(() => assertVendorResponse({
    action: "accept_confirm", times: { confirmedStart: start, confirmedEnd: end },
  }));
  assert.throws(() => assertVendorResponse({
    action: "accept_confirm", times: { proposedStart: start, proposedEnd: end },
  }));
  assert.throws(() => assertVendorResponse({ action: "company_confirmed" }));
});

test("completion_requires_reason_when_no_photo", () => {
  for (const reason of [undefined, null, "", " \t "]) {
    assert.throws(() => assertCompletion({ hasAfterPhoto: false, reason }));
  }
  assert.doesNotThrow(() => assertCompletion({ hasAfterPhoto: false, reason: "Camera unavailable" }));
  assert.doesNotThrow(() => assertCompletion({ hasAfterPhoto: true }));
});

test("reason length is bounded for both commands", () => {
  const reason = "x".repeat(4001);
  assert.throws(() => assertVendorResponse({ action: "reject", reason }));
  assert.throws(() => assertCompletion({ hasAfterPhoto: true, reason }));
});

test("runtime boolean validation does not trust truthy photo claims", () => {
  assert.throws(() => assertCompletion({
    hasAfterPhoto: "true" as unknown as boolean,
  }));
});

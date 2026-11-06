import test from "node:test";
import assert from "node:assert/strict";
import { FlowError } from "./errors";
import { assertNoNegativeClaim, assertPreviewMatchesPlan } from "./monthly-bill-rules";

test("credits exceeding gross produce zero net and carry", () => {
  assert.deepEqual(assertNoNegativeClaim({ grossMinor: "100", creditOffsetMinor: "150" }), { netMinor: "0", carryMinor: "50" });
});

test("credits equal to gross produce zero net and no carry", () => {
  assert.deepEqual(assertNoNegativeClaim({ grossMinor: "100", creditOffsetMinor: "100" }), { netMinor: "0", carryMinor: "0" });
});

test("preview digest mismatch throws FlowError", () => {
  assert.throws(() => assertPreviewMatchesPlan({ previewDigest: "old", planDigest: "new" }), (error: unknown) => error instanceof FlowError && error.key === "errors.preview_mismatch");
  assert.doesNotThrow(() => assertPreviewMatchesPlan({ previewDigest: "same", planDigest: "same" }));
});

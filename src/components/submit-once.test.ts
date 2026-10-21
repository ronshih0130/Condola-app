import assert from "node:assert/strict";
import test from "node:test";
import { claimFormSubmit, releaseFormSubmit } from "./submit-once";

test("a second submit in the same turn is refused until the guard is released", () => {
  const guard = { current: false };
  assert.equal(claimFormSubmit(guard), true);
  assert.equal(claimFormSubmit(guard), false);
  assert.equal(guard.current, true);
  releaseFormSubmit(guard);
  assert.equal(claimFormSubmit(guard), true);
});

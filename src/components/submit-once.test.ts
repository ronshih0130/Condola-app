import assert from "node:assert/strict";
import test from "node:test";
import { claimFormSubmit, enterCommitsControl, releaseFormSubmit } from "./submit-once";

test("a second submit in the same turn is refused until the guard is released", () => {
  const guard = { current: false };
  assert.equal(claimFormSubmit(guard), true);
  assert.equal(claimFormSubmit(guard), false);
  assert.equal(guard.current, true);
  releaseFormSubmit(guard);
  assert.equal(claimFormSubmit(guard), true);
});

test("Enter still commits a select, so the first unit choice is not discarded", () => {
  assert.equal(enterCommitsControl({ tagName: "SELECT" }), true);
  assert.equal(enterCommitsControl({ tagName: "OPTION" }), true);
  assert.equal(enterCommitsControl({ tagName: "TEXTAREA" }), true);
  assert.equal(enterCommitsControl({ tagName: "BUTTON", type: "submit" }), true);
  assert.equal(enterCommitsControl({ tagName: "BUTTON", type: "button" }), false);
  assert.equal(enterCommitsControl({ tagName: "INPUT" }), false);
  assert.equal(enterCommitsControl(null), false);
});

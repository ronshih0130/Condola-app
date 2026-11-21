import assert from "node:assert/strict";
import test from "node:test";
import { can } from "./perms";
import { firstIncompleteStep, readCompletedAt, setupChecklist, type SetupDone } from "./onboarding-progress-rules";

test("MGT-54-AC1/AC2: four independent steps use the first incomplete index", () => {
  for (let mask = 0; mask < 16; mask++) {
    const done = [0, 1, 2, 3].map(i => !!(mask & (1 << i))) as unknown as SetupDone;
    const first = done.indexOf(false);
    assert.equal(firstIncompleteStep(done), first < 0 ? 4 : first);
  }
});
test("MGT-54-AC5: manager has n／3; admin n／4; custom grants filter every step", () => {
  const done: SetupDone = [true, true, false, false];
  const admin = setupChecklist(done, null, key => can("admin", key));
  const manager = setupChecklist(done, null, key => can("manager", key));
  assert.equal(admin.total, 4); assert.equal(admin.completed, 2);
  assert.equal(manager.total, 3); assert.equal(manager.completed, 1);
  assert.deepEqual(manager.steps.map(s => s.id), ["unit", "invite", "joined"]);
  assert.deepEqual(setupChecklist(done, null, key => key === "settings.edit").steps.map(s => s.id), ["company"]);
});
test("MGT-54-AC2: a stored completion remains independent of current step counts", () => {
  const at = "2026-11-13T12:00:00Z";
  assert.equal(setupChecklist([true, true, true, false], at, () => true).completedAt, at);
  assert.equal(readCompletedAt({ onboarding_progress: { completed_at: at, required: {} } }), at);
  for (const settings of [null, [], {}, { onboarding_progress: { completed_at: "invalid" } }]) assert.equal(readCompletedAt(settings), null);
});

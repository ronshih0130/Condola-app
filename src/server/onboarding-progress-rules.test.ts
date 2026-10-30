import assert from "node:assert/strict";
import test from "node:test";
import { groupState, readOnboardingPolicy } from "./onboarding-progress-rules";

test("invitation policy requires an explicit, well-formed decision", () => {
  for (const value of [null, {}, {version:1,required:{}}, {version:1,required:{tenant:true,owner:false,team:false},actor:"x",decided_at:"bad"}]) assert.equal(readOnboardingPolicy(value),null);
  assert.ok(readOnboardingPolicy({version:1,required:{tenant:true,owner:false,team:false},actor:"x",decided_at:"2026-01-01T00:00:00Z"}));
  assert.equal(groupState(true,0,0),"incomplete");
  assert.equal(groupState(true,2,1),"incomplete");
  assert.equal(groupState(true,2,2),"complete");
  assert.equal(groupState(false,0,0),"skipped");
});

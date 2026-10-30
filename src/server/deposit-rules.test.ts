import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { depositMinorForFrequency, depositPolicyCap, depositPolicyState, type DepositPolicy } from "./deposit-rules";

test("deposit policy distinguishes legacy, regional warning, override and hard block", () => {
  const base: DepositPolicy = { regionalEnabled: false, ruleId: null, maxMonths: null, enforcement: null };
  assert.equal(depositPolicyState(base, 2), "none");
  assert.equal(depositPolicyState(base, 2.5), "reason");
  assert.equal(depositPolicyCap(base, 2.5), 2);
  const missing = { ...base, regionalEnabled: true };
  assert.equal(depositPolicyState(missing, 3), "none");
  const warn: DepositPolicy = { ...missing, maxMonths: 1, enforcement: "warn" };
  assert.equal(depositPolicyState(warn, 1), "none");
  assert.equal(depositPolicyState(warn, 1.5), "warn");
  assert.equal(depositPolicyState({ ...warn, enforcement: "override_required" }, 1.5), "reason");
  assert.equal(depositPolicyState({ ...warn, enforcement: "hard_block" }, 1.5), "block");
  assert.equal(depositPolicyState({ ...warn, regionalEnabled: false }, 2.5), "reason");
});


test("deposit rounding uses the full monthly basis for quarterly and yearly rents", () => {
  assert.equal(depositMinorForFrequency("USD", 10001, 1.5, "monthly"), 15002);
  assert.equal(depositMinorForFrequency("USD", 12001, 1.5, "quarterly"), 6001);
  assert.equal(depositMinorForFrequency("USD", 12001, 1.5, "yearly"), 1500);
  assert.equal(depositMinorForFrequency("TWD", 100, 2.5, "monthly"), 300);
});


test("deposit policy entrypoint requires current consent before resolving the session", () => {
  const source = readFileSync(new URL("./deposit-rules-actions.ts", import.meta.url), "utf8");
  const entry = source.slice(source.indexOf("export async function actionDepositPolicy"));
  assert.ok(entry.indexOf("await requireCurrentConsent()") >= 0);
  assert.ok(entry.indexOf("await requireCurrentConsent()") < entry.indexOf("await getSession()"));
});

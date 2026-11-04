import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import type { Client } from "pg";
import { depositMinorForFrequency, depositPolicyCap, depositPolicyState, resolveDepositPolicy, type DepositPolicy } from "./deposit-rules";

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


test("OFF ignores every regional enforcement and cap", () => {
  for (const enforcement of ["warn", "override_required", "hard_block"] as const) {
    const policy: DepositPolicy = { regionalEnabled: false, ruleId: "rule", maxMonths: 1, enforcement };
    assert.equal(depositPolicyState(policy, 1.5), "none");
    assert.equal(depositPolicyState(policy, 3), "reason");
    assert.equal(depositPolicyCap(policy, 1.5), null);
    assert.equal(depositPolicyCap(policy, 3), 2);
    assert.equal(depositPolicyCap({ ...policy, regionalEnabled: true }, 3), 1);
  }
});

test("resolver rolls back undefined_function and returns the legacy policy", async () => {
  const calls: string[] = [];
  const client = { query: async (sql: string) => {
    calls.push(sql);
    if (sql.includes("FROM public.resolve_deposit_rule")) throw { code: "42883" };
    return { rows: [] };
  } } as unknown as Client;
  assert.deepEqual(await resolveDepositPolicy(client, "org", "property", "2026-01-01"),
    { regionalEnabled: false, ruleId: null, maxMonths: null, enforcement: null });
  assert.equal(calls[0], "SAVEPOINT b007_resolve_policy");
  assert.equal(calls[2], "ROLLBACK TO SAVEPOINT b007_resolve_policy");
  assert.equal(calls[3], "RELEASE SAVEPOINT b007_resolve_policy");
});

test("resolver discards regional data while OFF and releases its savepoint", async () => {
  const calls: string[] = [];
  const client = { query: async (sql: string) => {
    calls.push(sql);
    return { rows: sql.includes("FROM public.resolve_deposit_rule")
      ? [{ regional_enabled: false, rule_id: "rule", max_months: "1", enforcement: "hard_block" }]
      : [] };
  } } as unknown as Client;
  assert.deepEqual(await resolveDepositPolicy(client, "org", "property", "2026-01-01"),
    { regionalEnabled: false, ruleId: null, maxMonths: null, enforcement: null });
  assert.equal(calls.at(-1), "RELEASE SAVEPOINT b007_resolve_policy");
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

import type { Client } from "pg";
import { FlowError } from "./errors";

export type DepositPolicy = {
  regionalEnabled: boolean;
  ruleId: string | null;
  maxMonths: number | null;
  enforcement: "info" | "warn" | "override_required" | "hard_block" | null;
};

export async function resolveDepositPolicy(client: Client, orgId: string, propertyId: string, on: string): Promise<DepositPolicy> {
  const legacy: DepositPolicy = { regionalEnabled: false, ruleId: null, maxMonths: null, enforcement: null };
  await client.query("SAVEPOINT b007_resolve_policy");
  let row;
  try {
    const result = await client.query<{ regional_enabled: boolean; rule_id: string | null; max_months: string | null; enforcement: DepositPolicy["enforcement"] }>(
      `SELECT regional_enabled, rule_id::text, max_months::text, enforcement
         FROM public.resolve_deposit_rule($1::uuid,$2::uuid,$3::date)`, [orgId, propertyId, on],
    );
    row = result.rows[0];
    if (!row) throw new FlowError("errors.notFound");
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT b007_resolve_policy");
    await client.query("RELEASE SAVEPOINT b007_resolve_policy");
    if ((error as { code?: string } | null)?.code === "42883") return legacy;
    throw error;
  }
  await client.query("RELEASE SAVEPOINT b007_resolve_policy");
  if (!row.regional_enabled) return legacy;
  return { regionalEnabled: true, ruleId: row.rule_id, maxMonths: row.max_months === null ? null : Number(row.max_months), enforcement: row.enforcement };
}

export function depositPolicyState(policy: DepositPolicy, months: number): "none" | "warn" | "reason" | "block" {
  const regionalOver = policy.regionalEnabled && policy.maxMonths !== null && Number.isFinite(months) && months > policy.maxMonths;
  if (regionalOver && policy.enforcement === "hard_block") return "block";
  if (regionalOver && policy.enforcement === "override_required") return "reason";
  if (!policy.regionalEnabled && Number.isFinite(months) && months > 2) return "reason";
  if (regionalOver && policy.enforcement === "warn") return "warn";
  return "none";
}

export function depositPolicyCap(policy: DepositPolicy, months: number): number | null {
  if (!policy.regionalEnabled) return Number.isFinite(months) && months > 2 ? 2 : null;
  return policy.maxMonths;
}

/** Use the unrounded monthly basis, then round only the final deposit. */
export function depositMinorForFrequency(currency: string, rentMinor: number, months: number, frequency: "monthly" | "quarterly" | "yearly"): number {
  const divisor = frequency === "quarterly" ? 3 : frequency === "yearly" ? 12 : 1;
  const amount = rentMinor * months / divisor;
  return currency === "TWD" ? Math.round(amount / 100) * 100 : Math.round(amount);
}

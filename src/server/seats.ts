import type { Client } from "pg";
import { planSnapshot } from "./sandbox-data";
import { seatLimit } from "./billing";
import { query } from "./db";
import { FlowError } from "./errors";
import { pricingTrialOn } from "./b056-trial-rules";
import { effectivePlan, effectivePlanOn, PRICING_TRIAL_SETTING_SQL } from "./b056-trial";

export async function commercialTier(orgId: string) {
  const row = await query<{ plan_tier: string; settings: unknown; feature_flags: unknown; pricing_trial: unknown }>(
    `SELECT plan_tier::text, settings, feature_flags, ${PRICING_TRIAL_SETTING_SQL} AS pricing_trial FROM organizations WHERE id = $1`,
    [orgId],
  );
  // B-056 (flag pricing_trial ON): the effective plan replaces legacy settings.plan / plan_tier.
  if (row.rows[0] && pricingTrialOn(row.rows[0].pricing_trial, row.rows[0].feature_flags, orgId)) {
    const effective = await effectivePlan(orgId);
    if (effective) return effective.tier;
  }
  return planSnapshot(row.rows[0]?.plan_tier, row.rows[0]?.settings ?? null).tier;
}

export async function seatUsage(orgId: string) {
  const row = await query<{ members: number; pending: number }>(
    `SELECT
       (SELECT count(*)::int FROM org_members WHERE org_id = $1 AND status = 'active') AS members,
       (SELECT count(*)::int FROM invitations
         WHERE org_id = $1 AND kind = 'team_member' AND status = 'pending' AND expires_at > now()) AS pending`,
    [orgId],
  );
  const members = row.rows[0]?.members ?? 0;
  const pending = row.rows[0]?.pending ?? 0;
  return { members, pending, used: members + pending };
}

/**
 * Serialize seat increases on the organization. The caller owns the transaction
 * and must acquire this lock before locking an invitation or membership.
 */
export async function lockSeatOrganization(client: Client, orgId: string) {
  const result = await client.query<{ environment: "live" | "sandbox"; plan_tier: string; settings: unknown; feature_flags: unknown; pricing_trial: unknown }>(
    `SELECT environment::text, plan_tier::text, settings, feature_flags, ${PRICING_TRIAL_SETTING_SQL} AS pricing_trial
       FROM organizations WHERE id = $1 FOR UPDATE`,
    [orgId],
  );
  const row = result.rows[0];
  if (!row) throw new FlowError("errors.notFound");
  // B-056 (flag pricing_trial ON): seat limit follows the effective plan (MGT-97-AC2). Read after
  // the organizations lock, matching the design lock order (organizations → b056 row).
  const effective = pricingTrialOn(row.pricing_trial, row.feature_flags, orgId) ? await effectivePlanOn(client, orgId) : null;
  return {
    environment: row.environment,
    limit: effective ? effective.seatLimit : seatLimit(planSnapshot(row.plan_tier, row.settings).tier),
  };
}

export async function assertSeatAvailableOn(
  client: Client,
  orgId: string,
  organization: Awaited<ReturnType<typeof lockSeatOrganization>>,
  includePending = true,
) {
  if (organization.environment !== "live" || organization.limit == null) return;
  const result = await client.query<{ used: number }>(
    `SELECT (
       (SELECT count(*) FROM org_members WHERE org_id = $1 AND status = 'active')
       + CASE WHEN $2::boolean THEN
           (SELECT count(*) FROM invitations WHERE org_id = $1 AND kind = 'team_member'
             AND status = 'pending' AND expires_at > now())
         ELSE 0 END
     )::int AS used`,
    [orgId, includePending],
  );
  if (result.rows[0].used >= organization.limit) throw new FlowError("errors.seatLimit");
}

/** Test mode has no seat cap. Free is 1 and Standard is 5, counting active members and pending invites. */
export async function assertSeatAvailable(orgId: string, environment: "live" | "sandbox") {
  if (environment !== "live") return;
  const limit = seatLimit(await commercialTier(orgId));
  if (limit == null) return;
  const usage = await seatUsage(orgId);
  if (usage.used >= limit) throw new FlowError("errors.seatLimit");
}

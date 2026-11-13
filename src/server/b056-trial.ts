// B-056 trial engine — server IO. Pure rules: ./b056-trial-rules. SQL: app.b056_* (PR-1).
// Stories: MGT-96-AC2, MGT-96-AC4, MGT-97-AC1, MGT-97-AC2.
//
// Flag OFF (pricing_trial): nothing here calls an app.b056_* function and callers keep their
// pre-B-056 behaviour. The app.b056_* functions are EXECUTE-granted to service_role only; the
// owner path (withClient/query) can call them as the function owner. No outbound of any kind.
import type { Client } from "pg";
import { svc, withClient } from "./db";
import { FlowError } from "./errors";
import { assertStaff, type Session } from "./types";
import { guardEffectiveSession, withEffectiveAuthority } from "./b017-custom-role-governance";
import { pricingTrialOn, resolveEffectivePlan, type EffectivePlan, type PlanFacts, type TrialPlan } from "./b056-trial-rules";

type Queryable = Pick<Client, "query">;

/** SQL fragment: the platform setting, for reading together with organizations.feature_flags. */
export const PRICING_TRIAL_SETTING_SQL = `(SELECT value FROM platform_settings WHERE key = 'pricing_trial')`;

/** Flag check on any client that can read platform_settings and organizations (owner or service_role). */
/** A query error is thrown, never read as OFF: an org whose flag is ON must not fall back to the
 *  legacy plan because a read failed (Codex PR-2 r1 重要). */
export async function pricingTrialOnFor(client: Queryable, orgId: string): Promise<boolean> {
  const row = (await client.query<{ value: unknown; feature_flags: unknown }>(
    `SELECT ${PRICING_TRIAL_SETTING_SQL} AS value, feature_flags FROM organizations WHERE id = $1`,
    [orgId],
  )).rows[0];
  return row ? pricingTrialOn(row.value, row.feature_flags, orgId) : false;
}

/** Facts from app.b056_plan_facts; null when the flag is OFF for the org (the function returns no row). */
export async function planFactsOn(client: Queryable, orgId: string): Promise<PlanFacts | null> {
  const row = (await client.query<{ as_of: Date; trial_plan: string | null; trial_ends_at: Date | null; paid_plan: string | null }>(
    `SELECT as_of, trial_plan, trial_ends_at, paid_plan FROM app.b056_plan_facts($1)`,
    [orgId],
  )).rows[0];
  if (!row) return null;
  return { asOf: row.as_of, trialPlan: row.trial_plan, trialEndsAt: row.trial_ends_at, paidPlan: row.paid_plan };
}

/** Effective plan, or null when the flag is OFF (caller keeps legacy behaviour). */
export async function effectivePlanOn(client: Queryable, orgId: string): Promise<EffectivePlan | null> {
  const facts = await planFactsOn(client, orgId);
  return facts ? resolveEffectivePlan(facts) : null;
}

/** Owner-path convenience for pages and loaders. Null when the flag is OFF. */
export async function effectivePlan(orgId: string): Promise<EffectivePlan | null> {
  return withClient(async (client) => ((await pricingTrialOnFor(client, orgId)) ? effectivePlanOn(client, orgId) : null));
}

const DB_REFUSALS: Record<string, string> = {
  b056_disabled: "errors.notFound",
  b056_forbidden: "errors.forbidden",
  b056_invalid_plan: "errors.required",
};

function mapDbError(error: unknown): never {
  const message = error instanceof Error ? error.message : "";
  const key = DB_REFUSALS[message];
  if (key) throw new FlowError(key);
  throw error;
}

/**
 * MGT-96-AC2 / MGT-96-AC4: start the org's one trial. Admin only (app layer and again in SQL);
 * the org is always session.liveOrgId, never a client-supplied id. A second start, a start by a
 * paid org, or a lost race is refused with the existing 「無權限」 copy (no new copy without an
 * approved mockup string, OQ-B056-25). Writes one audit row in the same transaction.
 */
export async function startTrial(session: Session, plan: TrialPlan): Promise<{ endsAt: Date }> {
  session = await guardEffectiveSession(session, "settings.edit");
  assertStaff(session, ["admin"], "settings.edit");
  const orgId = session.liveOrgId;
  if (!orgId) throw new FlowError("errors.forbidden");
  // B-017 authority is re-validated in the same transaction after the SQL has waited for and taken
  // its locks; a permission revoked meanwhile rolls back the trial and its audit (Codex PR-2 r1 阻塞).
  const result = await svc(session.userId, async (client) =>
    withEffectiveAuthority(client, session, "settings.edit", async () => {
      try {
        return (await client.query<{ started: boolean; refusal: string | null; trial_ends_at: Date | null }>(
          `SELECT started, refusal, trial_ends_at FROM app.b056_start_trial($1, $2, $3)`,
          [orgId, session.userId, plan],
        )).rows[0];
      } catch (error) {
        return mapDbError(error);
      }
    }));
  if (!result?.started || !result.trial_ends_at) throw new FlowError("errors.forbidden");
  return { endsAt: result.trial_ends_at };
}

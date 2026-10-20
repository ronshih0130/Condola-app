import { planSnapshot } from "./sandbox-data";
import { seatLimit } from "./billing";
import { query } from "./db";
import { FlowError } from "./errors";

export async function commercialTier(orgId: string) {
  const row = await query<{ plan_tier: string; settings: unknown }>(
    `SELECT plan_tier::text, settings FROM organizations WHERE id = $1`,
    [orgId],
  );
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

/** Test mode has no seat cap. Free is 1 and Standard is 5, counting active members and pending invites. */
export async function assertSeatAvailable(orgId: string, environment: "live" | "sandbox") {
  if (environment !== "live") return;
  const limit = seatLimit(await commercialTier(orgId));
  if (limit == null) return;
  const usage = await seatUsage(orgId);
  if (usage.used >= limit) throw new FlowError("errors.seatLimit");
}

import { guardEffectiveSession } from "@/server/b017-custom-role-governance";
import type { Client } from "pg";
import { writeAudit } from "./audit";
import { withClient } from "./db";
import { groupState, readOnboardingPolicy, type OnboardingChoices, type OnboardingGroup } from "./onboarding-progress-rules";
import type { Session } from "./types";

type Counts = { properties: number; leases: number; drafts: number; bills: number; tenant_total: number; tenant_ready: number; tenant_pending: number; tenant_expired: number; owner_total: number; owner_ready: number; owner_pending: number; owner_expired: number; team_total: number; team_ready: number; team_pending: number; team_expired: number };
export type OnboardingProgress = { policy: ReturnType<typeof readOnboardingPolicy>; counts: Counts; groups: Record<OnboardingGroup, ReturnType<typeof groupState>> | null };

function eligible(session: Session) {
  return session.kind === "staff" && session.role === "admin" && session.environment === "live" && session.orgId === session.liveOrgId && !session.needsSandbox;
}

// Verify membership, session and both rollout controls on every transaction.
async function authorized(client: Client, session: Session, write: boolean) {
  if (!eligible(session)) return null;
  if (write) await client.query("LOCK TABLE public.platform_settings IN SHARE MODE");
  const org = await client.query<{ settings: unknown }>(
    `SELECT o.settings FROM organizations o JOIN org_members m ON m.org_id=o.id AND m.user_id=$2 AND m.role='admin' AND m.status='active'
     JOIN auth_sessions s ON s.id=$3 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at > now()
     WHERE o.id=$1 AND o.environment='live' AND o.feature_flags->'onboarding_progress'='true'::jsonb
       AND EXISTS (SELECT 1 FROM platform_settings p WHERE p.key='onboarding_progress' AND p.value->'enabled'='true'::jsonb
         AND jsonb_typeof(p.value->'allowed_org_ids')='array' AND p.value->'allowed_org_ids' @> jsonb_build_array(o.id::text))
     ${write ? "FOR UPDATE OF o FOR SHARE OF m,s" : ""}`,
    [session.orgId, session.userId, session.sessionId]);
  return org.rows[0] ?? null;
}

const countsSql = `WITH props AS (
 SELECT p.id FROM properties p WHERE p.org_id=$1 AND p.archived_at IS NULL
 AND NOT EXISTS (SELECT 1 FROM sample_marks sm WHERE sm.org_id=$1 AND sm.entity_table='properties' AND sm.entity_id=p.id)
), leases_ok AS (
 SELECT l.* FROM leases l JOIN props p ON p.id=l.property_id JOIN units u ON u.id=l.unit_id AND u.org_id=l.org_id
 LEFT JOIN rooms r ON r.id=l.target_room_id AND r.org_id=l.org_id
 WHERE l.org_id=$1 AND u.property_id=l.property_id AND u.archived_at IS NULL AND (l.target_room_id IS NULL OR (r.id IS NOT NULL AND r.archived_at IS NULL))
 AND l.esign_status NOT IN ('declined','voided')
 AND NOT EXISTS (SELECT 1 FROM sample_marks sm WHERE sm.org_id=$1 AND ((sm.entity_table='leases' AND sm.entity_id=l.id) OR (sm.entity_table='units' AND sm.entity_id=u.id) OR (sm.entity_table='rooms' AND sm.entity_id=r.id)))
), portal_targets AS (
 SELECT DISTINCT 'tenant' AS kind,c.id,c.user_id FROM leases_ok l JOIN lease_parties lp ON lp.org_id=l.org_id AND lp.lease_id=l.id AND lp.role='primary'
 JOIN contacts c ON c.id=lp.contact_id AND c.org_id=l.org_id AND c.archived_at IS NULL AND c.is_tenant
 WHERE l.status IN ('pending_signature','active') AND NOT EXISTS (SELECT 1 FROM sample_marks sm WHERE sm.org_id=$1 AND ((sm.entity_table='contacts' AND sm.entity_id=c.id) OR (sm.entity_table='lease_parties' AND sm.entity_id=lp.id)))
 UNION
 SELECT DISTINCT 'owner',c.id,c.user_id FROM property_owners po JOIN props p ON p.id=po.property_id JOIN contacts c ON c.id=po.owner_contact_id AND c.org_id=po.org_id AND c.archived_at IS NULL AND c.is_owner
 WHERE po.org_id=$1 AND po.effective_from <= (SELECT timezone(o.timezone,now())::date FROM organizations o WHERE o.id=$1) AND (po.effective_to IS NULL OR po.effective_to >= (SELECT timezone(o.timezone,now())::date FROM organizations o WHERE o.id=$1))
 AND NOT EXISTS (SELECT 1 FROM sample_marks sm WHERE sm.org_id=$1 AND ((sm.entity_table='contacts' AND sm.entity_id=c.id) OR (sm.entity_table='property_owners' AND sm.entity_id=po.id)))
), portal_status AS (
 SELECT t.kind, (u.encrypted_password IS NOT NULL AND btrim(u.encrypted_password)<>'' AND NOT EXISTS (
   SELECT 1 FROM invitations pending WHERE pending.org_id=$1 AND pending.contact_id=t.id AND pending.kind IN ('owner','tenant')
   AND pending.status='pending' AND pending.expires_at>now()
   AND NOT EXISTS (SELECT 1 FROM sample_marks sm WHERE sm.org_id=$1 AND sm.entity_table='invitations' AND sm.entity_id=pending.id)
   AND NOT EXISTS (SELECT 1 FROM invitations accepted WHERE accepted.org_id=$1 AND accepted.contact_id=t.id
     AND accepted.kind=t.kind::invitation_kind AND accepted.status='accepted' AND accepted.accepted_by=t.user_id
     AND accepted.accepted_at IS NOT NULL AND accepted.accepted_at >= pending.created_at
     AND NOT EXISTS (SELECT 1 FROM sample_marks sm WHERE sm.org_id=$1 AND sm.entity_table='invitations' AND sm.entity_id=accepted.id))
 )) AS ready,
 EXISTS (SELECT 1 FROM invitations i WHERE i.org_id=$1 AND i.contact_id=t.id AND i.kind=t.kind::invitation_kind AND i.status='pending' AND i.expires_at>now() AND NOT EXISTS (SELECT 1 FROM sample_marks sm WHERE sm.org_id=$1 AND sm.entity_table='invitations' AND sm.entity_id=i.id)) AS pending,
 EXISTS (SELECT 1 FROM invitations i WHERE i.org_id=$1 AND i.contact_id=t.id AND i.kind=t.kind::invitation_kind AND (i.status='expired' OR (i.status='pending' AND i.expires_at<=now())) AND NOT EXISTS (SELECT 1 FROM sample_marks sm WHERE sm.org_id=$1 AND sm.entity_table='invitations' AND sm.entity_id=i.id)) AS expired
 FROM portal_targets t LEFT JOIN auth.users u ON u.id=t.user_id
), portal AS (
 SELECT kind, count(*)::int AS total, count(*) FILTER (WHERE ready)::int AS ready,
 count(*) FILTER (WHERE NOT ready AND pending)::int AS pending,
 count(*) FILTER (WHERE NOT ready AND NOT pending AND expired)::int AS expired
 FROM portal_status GROUP BY kind
), members AS (
 SELECT m.user_id, m.is_billing_owner, m.status, lower(btrim(coalesce(nullif(p.email::text,''),u.email::text,''))) AS email
 FROM org_members m LEFT JOIN profiles p ON p.id=m.user_id JOIN auth.users u ON u.id=m.user_id
 WHERE m.org_id=$1 AND m.status<>'removed' AND m.role IN ('admin','manager','accountant','maintenance')
 AND NOT EXISTS (SELECT 1 FROM sample_marks sm WHERE sm.org_id=$1 AND sm.entity_table='org_members' AND sm.entity_id=m.id)
), outstanding AS (
 SELECT coalesce(nullif(lower(btrim(i.email::text)),''),i.id::text) AS target, bool_or(i.status='pending' AND i.expires_at>now()) AS pending
 FROM invitations i WHERE i.org_id=$1 AND i.kind='team_member' AND i.status IN ('pending','expired') AND i.role IN ('admin','manager','accountant','maintenance')
 AND NOT EXISTS (SELECT 1 FROM sample_marks sm WHERE sm.org_id=$1 AND sm.entity_table='invitations' AND sm.entity_id=i.id)
 AND NOT EXISTS (SELECT 1 FROM members m WHERE m.email<>'' AND m.email=lower(btrim(i.email::text)))
 AND NOT EXISTS (SELECT 1 FROM invitations accepted JOIN members m ON m.user_id=accepted.accepted_by
   WHERE accepted.org_id=$1 AND accepted.kind='team_member' AND accepted.status='accepted' AND lower(btrim(accepted.email::text))=lower(btrim(i.email::text))
   AND NOT EXISTS (SELECT 1 FROM sample_marks sm WHERE sm.org_id=$1 AND sm.entity_table='invitations' AND sm.entity_id=accepted.id))
 GROUP BY coalesce(nullif(lower(btrim(i.email::text)),''),i.id::text)
), team AS (SELECT ((SELECT count(*) FROM members WHERE NOT is_billing_owner)+(SELECT count(*) FROM outstanding))::int AS total, (SELECT count(*)::int FROM members WHERE NOT is_billing_owner AND status='active') AS ready,
 (SELECT count(*)::int FROM outstanding WHERE pending) AS pending, (SELECT count(*)::int FROM outstanding WHERE NOT pending) AS expired)
SELECT (SELECT count(*)::int FROM props) AS properties,
 (SELECT count(*)::int FROM leases_ok WHERE status IN ('pending_signature','active','ended','terminated')) AS leases,
 (SELECT count(*)::int FROM leases_ok WHERE status='draft') AS drafts,
 (SELECT count(*)::int FROM invoices i JOIN leases_ok l ON l.id=i.lease_id AND l.property_id=i.property_id WHERE i.org_id=$1 AND l.status IN ('pending_signature','active','ended','terminated') AND i.status IN ('open','partially_paid','paid','written_off') AND i.voided_at IS NULL AND NOT EXISTS (SELECT 1 FROM sample_marks sm WHERE sm.org_id=$1 AND sm.entity_table='invoices' AND sm.entity_id=i.id)) AS bills,
 coalesce((SELECT total FROM portal WHERE kind='tenant'),0) AS tenant_total, coalesce((SELECT ready FROM portal WHERE kind='tenant'),0) AS tenant_ready, coalesce((SELECT pending FROM portal WHERE kind='tenant'),0) AS tenant_pending, coalesce((SELECT expired FROM portal WHERE kind='tenant'),0) AS tenant_expired,
 coalesce((SELECT total FROM portal WHERE kind='owner'),0) AS owner_total, coalesce((SELECT ready FROM portal WHERE kind='owner'),0) AS owner_ready, coalesce((SELECT pending FROM portal WHERE kind='owner'),0) AS owner_pending, coalesce((SELECT expired FROM portal WHERE kind='owner'),0) AS owner_expired,
 (SELECT total FROM team) AS team_total, (SELECT ready FROM team) AS team_ready, (SELECT pending FROM team) AS team_pending, (SELECT expired FROM team) AS team_expired`;

export async function readOnboardingOn(client: Client, session: Session): Promise<OnboardingProgress | null> {
  session = await guardEffectiveSession(session, null);
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const org = await authorized(client, session, false);
    if (!org) { await client.query("COMMIT"); return null; }
    const settings = org.settings && typeof org.settings === "object" && !Array.isArray(org.settings) ? org.settings as Record<string, unknown> : {};
    const policy = readOnboardingPolicy(settings.onboarding_progress);
    const counts = (await client.query<Counts>(countsSql, [session.orgId])).rows[0];
    const groups = policy ? {
      tenant: groupState(policy.required.tenant, counts.tenant_total, counts.tenant_ready),
      owner: groupState(policy.required.owner, counts.owner_total, counts.owner_ready),
      team: groupState(policy.required.team, counts.team_total, counts.team_ready),
    } : null;
    await client.query("COMMIT");
    return { policy, counts, groups };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}

export async function saveOnboardingOn(client: Client, session: Session, choices: OnboardingChoices): Promise<boolean> {
  session = await guardEffectiveSession(session, null);
  if (!choices || !["tenant", "owner", "team"].every((key) => typeof choices[key as OnboardingGroup] === "boolean")) return false;
  await client.query("BEGIN");
  try {
    const org = await authorized(client, session, true);
    if (!org) { await client.query("ROLLBACK"); return false; }
    if (!org.settings || typeof org.settings !== "object" || Array.isArray(org.settings)) { await client.query("ROLLBACK"); return false; }
    const required = { tenant: choices.tenant, owner: choices.owner, team: choices.team };
    const result = await client.query<{ policy: unknown }>(`UPDATE organizations SET settings=jsonb_set(settings,'{onboarding_progress}',jsonb_build_object('version',1,'required',$2::jsonb,'actor',$3::text,'decided_at',now()),true) WHERE id=$1 RETURNING settings->'onboarding_progress' AS policy`, [session.orgId, JSON.stringify(required), session.userId]);
    await writeAudit(session.orgId, session.userId, "onboarding_invitation_policy_changed", { required, not_needed: Object.entries(required).filter(([, needed]) => !needed).map(([key]) => key) }, client);
    if (!result.rows[0]) throw new Error("Onboarding update failed");
    await client.query("COMMIT");
    return true;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}
export async function readOnboarding(session: Session) { return withClient((client) => readOnboardingOn(client, session)); }
export async function saveOnboarding(session: Session, choices: OnboardingChoices) { return withClient((client) => saveOnboardingOn(client, session, choices)); }

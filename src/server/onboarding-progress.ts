import { customAuthorityAllowsOn, guardEffectiveSession, requireEffectivePerm, resolveCustomRoleSession } from "@/server/b017-custom-role-governance";
import type { Client } from "pg";
import type { EmptySetup } from "@/lib/empty-cta";
import { writeAudit } from "./audit";
import { withClient } from "./db";
import { FlowError } from "./errors";
import { can, PERMS, type PermKey } from "./perms";
import { firstIncompleteStep, readCompletedAt, setupChecklist, type SetupDone } from "./onboarding-progress-rules";
import type { Session } from "./types";

type Counts = { units: number; only_unit: string | null; has_units: boolean; invitations: number; bindings: number; bound_tenants: number; tenant_ready: number; leases: number; unjoined_leases: string[] };
export type SetupProgress = EmptySetup & { tenantJoined: boolean; permissions: PermKey[]; checklist: ReturnType<typeof setupChecklist> | null };
function eligible(session: Session) {
  return session.kind === "staff" && (session.role === "admin" || session.role === "manager") && session.environment === "live"
    && session.orgId === session.liveOrgId && !session.needsSandbox;
}

/** B-042 PR-4c can add the share-source count here in one line. Secrets and opens never count. */
export function hasSharedTenantInvitation(counts: { invitations: number; bindings: number }): boolean {
  return counts.invitations > 0 || counts.bindings > 0;
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
), units_ok AS (
 SELECT u.id FROM units u JOIN props p ON p.id=u.property_id WHERE u.org_id=$1 AND u.archived_at IS NULL
 AND NOT EXISTS (SELECT 1 FROM sample_marks sm WHERE sm.org_id=$1 AND sm.entity_table='units' AND sm.entity_id=u.id)
), bindings_ok AS (
 SELECT b.* FROM app.unit_bindings b
 LEFT JOIN units u ON u.id=b.unit_id AND u.org_id=b.org_id
 LEFT JOIN properties p ON p.id=u.property_id AND p.org_id=b.org_id
 WHERE b.org_id=$1 AND NOT EXISTS (SELECT 1 FROM sample_marks sm WHERE sm.org_id=$1 AND
 ((sm.entity_table IN ('unit_bindings','app.unit_bindings') AND sm.entity_id=b.id) OR (sm.entity_table='contacts' AND sm.entity_id=b.contact_id)
 OR (sm.entity_table='units' AND sm.entity_id=b.unit_id) OR (sm.entity_table='properties' AND sm.entity_id=p.id)))
), invitations_ok AS (
 SELECT i.id FROM invitations i
 LEFT JOIN leases l ON l.id=i.lease_id AND l.org_id=i.org_id
 LEFT JOIN units u ON u.id=l.unit_id AND u.org_id=i.org_id
 WHERE i.org_id=$1 AND i.kind='tenant' AND i.status IN ('pending','accepted')
 AND NOT EXISTS (SELECT 1 FROM sample_marks sm WHERE sm.org_id=$1 AND
 ((sm.entity_table='invitations' AND sm.entity_id=i.id) OR (sm.entity_table='contacts' AND sm.entity_id=i.contact_id)
 OR (sm.entity_table='leases' AND sm.entity_id=l.id) OR (sm.entity_table='units' AND sm.entity_id=u.id)
 OR (sm.entity_table='rooms' AND sm.entity_id=l.target_room_id) OR (sm.entity_table='properties' AND sm.entity_id=l.property_id)))
)
SELECT
 (SELECT count(*)::int FROM units_ok) AS units,
 (SELECT min(id::text) FROM units_ok) AS only_unit,
 EXISTS (SELECT 1 FROM units u WHERE u.org_id=$1 AND u.archived_at IS NULL) AS has_units,
 (SELECT count(*)::int FROM invitations_ok) AS invitations,
 (SELECT count(*)::int FROM bindings_ok) AS bindings,
 (SELECT count(*)::int FROM bindings_ok WHERE status IN ('pending','lease_linked')) AS bound_tenants,
 coalesce((SELECT ready FROM portal WHERE kind='tenant'),0) AS tenant_ready,
 (SELECT count(*)::int FROM leases_ok) AS leases,
 ARRAY(SELECT l.id::text FROM leases_ok l WHERE NOT EXISTS (
   SELECT 1 FROM lease_parties lp JOIN contacts c ON c.id=lp.contact_id AND c.org_id=lp.org_id
   JOIN auth.users u ON u.id=c.user_id WHERE lp.org_id=$1 AND lp.lease_id=l.id AND lp.role='primary'
   AND nullif(btrim(u.encrypted_password),'') IS NOT NULL
 )) AS unjoined_leases`;

/** Within the separate completion transaction; preserve every other settings key. */
async function saveOnboardingOn(client: Client, session: Session): Promise<string> {
  const result = await client.query<{ completed_at: string }>(`UPDATE organizations SET settings=jsonb_set(
    coalesce(settings,'{}'::jsonb),'{onboarding_progress}',
    (CASE WHEN jsonb_typeof(settings->'onboarding_progress')='object' THEN settings->'onboarding_progress' ELSE '{}'::jsonb END)
      || jsonb_build_object('completed_at',now()),true)
    WHERE id=$1 RETURNING settings->'onboarding_progress'->>'completed_at' AS completed_at`, [session.orgId]);
  await writeAudit(session.orgId, session.userId, "onboarding_setup_completed", {}, client);
  return result.rows[0].completed_at;
}

export async function readSetupStepOn(client: Client, session: Session): Promise<SetupProgress> {
  session = await resolveCustomRoleSession(session);
  // An aggregate used on every management page has no single feature permission.
  // Require one current native-ceiling grant, then filter each disclosed action/step.
  const readPermission = PERMS.find(([key]) => can(session, key))?.[0];
  if (!readPermission) throw new FlowError("errors.forbidden");
  session = await guardEffectiveSession(session, readPermission);
  if (session.kind !== "staff") throw new FlowError("errors.forbidden");
  let result: SetupProgress;
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    result = await readSetupSnapshotOn(client, session, readPermission, false);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }

  if (result.checklistOn && result.tenantJoined && !result.checklist?.completedAt) {
    // End the read snapshot first. READ COMMITTED sees a prior writer's completion
    // after waiting for the org lock, so concurrent views produce just one audit.
    await client.query("BEGIN");
    try {
      result = await readSetupSnapshotOn(client, session, readPermission, true);
      if (result.checklistOn && result.tenantJoined && result.checklist && !result.checklist.completedAt) {
        result.checklist.completedAt = await saveOnboardingOn(client, session);
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
  }
  return result;
}

async function readSetupSnapshotOn(client: Client, session: Session, readPermission: PermKey, lock: boolean): Promise<SetupProgress> {
  // Only the completion writer takes the old rollout/org/member/session locks.
  if (lock) await client.query("LOCK TABLE public.platform_settings IN SHARE MODE");
  const org = (await client.query<{ settings: unknown; company: boolean; checklist_on: boolean; invite_on: boolean }>(`
    SELECT o.settings,
      (nullif(btrim(o.name),'') IS NOT NULL AND nullif(btrim(o.contact_phone),'') IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM sample_marks sm WHERE sm.org_id=o.id AND sm.entity_table='organizations' AND sm.entity_id=o.id)) AS company,
      (o.feature_flags->'onboarding_progress'='true'::jsonb AND EXISTS (
        SELECT 1 FROM platform_settings p WHERE p.key='onboarding_progress' AND p.value->'enabled'='true'::jsonb
        AND jsonb_typeof(p.value->'allowed_org_ids')='array' AND p.value->'allowed_org_ids' @> jsonb_build_array(o.id::text))) AS checklist_on,
      app.unit_line_invite_on(o.id) AS invite_on
    FROM organizations o JOIN org_members m ON m.org_id=$4 AND m.user_id=$2 AND m.status='active' AND m.role::text=$5
    JOIN auth_sessions s ON s.id=$3 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>now()
    WHERE o.id=$1 AND o.environment::text=$6 AND (o.id=m.org_id OR (o.environment='sandbox' AND o.live_org_id=m.org_id))
    ${lock ? "FOR UPDATE OF o FOR SHARE OF m,s" : ""}`,
    [session.orgId, session.userId, session.sessionId, session.liveOrgId, session.role, session.environment])).rows[0];
  if (!org) throw new FlowError("errors.forbidden");
  if (lock) await requireEffectivePerm(client, session, readPermission);
  else if (!await customAuthorityAllowsOn(client, session, readPermission)) throw new FlowError("errors.forbidden");
  const counts = (await client.query<Counts>(countsSql, [session.orgId])).rows[0];
  const tenantJoined = counts.tenant_ready > 0 || counts.bound_tenants > 0;
  const done: SetupDone = [org.company, counts.units > 0, hasSharedTenantInvitation(counts), tenantJoined];
  const checklistOn = eligible(session) && org.checklist_on === true;
  const completedAt = readCompletedAt(org.settings);
  const inviteMode = org.invite_on ? "m4" : counts.leases > 0 ? "lease" : "no_lease";
  // B-040 slice 2 is absent in this checkout. Its owner must wire/confirm the invite query before shipment.
  // This read never issues a secret or counts a visit as a share.
  const inviteHref = inviteMode === "m4"
    ? counts.units === 1 ? `/m/units?invite=${counts.only_unit}` : "/m/units"
    : inviteMode === "no_lease" ? "/m/leases/new"
    : counts.unjoined_leases.length === 1 ? `/m/leases/${counts.unjoined_leases[0]}` : "/m/leases";
  return { step: firstIncompleteStep(done), checklistOn, hasUnits: counts.has_units,
    tenantJoined, inviteMode, inviteHref: can(session, "props.edit") ? inviteHref : "/m/leases",
    permissions: PERMS.flatMap(([key]) => can(session, key) ? [key] : []),
    checklist: checklistOn ? setupChecklist(done, completedAt, key => can(session, key)) : null };
}

export async function readSetupStep(session: Session): Promise<SetupProgress> {
  // readSetupStepOn validates current membership, session and effective grants before reading.
  return withClient(client => readSetupStepOn(client, session));
}

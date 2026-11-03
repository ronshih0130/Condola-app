import type { Connection } from "./repo";
import type { OrgRole } from "../types";
import { esignEnabled, requireEsignOrganization } from "./access";
import { admitLeaseArchiveAncestry } from "../record-archive-admission";
import { assertCurrentArchiveCaller } from "../record-archive-caller";

/** Trusted request context; never populate it from a command payload. */
export type SigningActor = {
  userId: string;
  sessionId: string;
  orgId: string;
  liveOrgId: string;
  environment: "live" | "sandbox";
  kind: "staff" | "owner" | "tenant";
  role: OrgRole | null;
};

async function authorized(c: Connection, actor: SigningActor, caseId?: string, versionId?: string) {
  const result = await c.query<{ lease_id: string | null }>(
    `SELECT ec.lease_id::text FROM organizations o
       LEFT JOIN esign_cases ec ON ec.id=$6::uuid AND ec.org_id=o.id
      WHERE o.id=$1::uuid AND o.environment::text=$2 AND coalesce(o.live_org_id,o.id)=$3::uuid
        AND (($2='live' AND o.id=$3::uuid) OR ($2='sandbox' AND o.live_org_id=$3::uuid))
        AND ($6::uuid IS NULL OR ec.id IS NOT NULL)
        AND (($4='staff' AND $5 IN ('admin','manager') AND EXISTS (
          SELECT 1 FROM org_members m WHERE m.org_id=o.id AND m.user_id=$7::uuid AND m.status='active' AND m.role::text=$5
        )) OR ($4 IN ('owner','tenant') AND $5::text IS NULL AND $6::uuid IS NOT NULL AND EXISTS (
          SELECT 1 FROM esign_versions v JOIN esign_signers s ON s.version_id=v.id
           WHERE v.case_id=ec.id AND ($8::uuid IS NULL OR v.id=$8::uuid) AND s.id=$7::uuid AND s.party_role=$4
        ) AND NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id=o.id AND m.user_id=$7::uuid AND m.status='active' AND m.role IN ('admin','manager'))))`,
    [actor.orgId, actor.environment, actor.liveOrgId, actor.kind, actor.role, caseId ?? null, actor.userId, versionId ?? null],
  );
  if (result.rowCount !== 1) throw new Error("Signing context unavailable");
  return result.rows[0].lease_id;
}

/** Authorize before locking, acquire lease then case, and reauthorize after waits. */
export async function lockSigningCase(c: Connection, actor: SigningActor, caseId: string, versionId?: string, enabled = esignEnabled(), requireActiveAncestry = false) {
  await requireEsignOrganization(c, actor, true, enabled);
  const leaseId = await authorized(c, actor, caseId, versionId);
  if (!leaseId) throw new Error("Signing context unavailable");
  const target = requireActiveAncestry ? await admitLeaseArchiveAncestry(c,actor.orgId,leaseId) : null;
  if (target) await assertCurrentArchiveCaller(c,actor);
  const lease = await c.query<{property_id:string;unit_id:string;target_room_id:string|null}>("SELECT property_id::text,unit_id::text,target_room_id::text FROM leases WHERE id=$1 AND org_id=$2 FOR UPDATE", [leaseId,actor.orgId]);
  if (lease.rowCount !== 1) throw new Error("Signing context unavailable");
  if (target && JSON.stringify(lease.rows[0]) !== JSON.stringify(target)) throw new Error("Signing context unavailable");
  const found = await c.query("SELECT id FROM esign_cases WHERE id=$1 AND org_id=$2 AND lease_id=$3 FOR UPDATE", [caseId,actor.orgId,leaseId]);
  if (found.rowCount !== 1) throw new Error("Signing context unavailable");
  if (versionId) {
    const version = await c.query("SELECT id FROM esign_versions WHERE id=$1 AND case_id=$2 FOR UPDATE", [versionId, caseId]);
    if (version.rowCount !== 1) throw new Error("Signing context unavailable");
  }
  if (target) await assertCurrentArchiveCaller(c,actor);
  await requireEsignOrganization(c, actor, true, enabled);
  if (await authorized(c,actor,caseId,versionId) !== leaseId) throw new Error("Signing context unavailable");
  return leaseId;
}

export async function lockSigningLeaseForCreate(c: Connection, actor: SigningActor, leaseId: string, enabled = esignEnabled()) {
  if (actor.kind !== "staff") throw new Error("Signing context unavailable");
  await requireEsignOrganization(c, actor, true, enabled);
  await authorized(c,actor);
  const target=await admitLeaseArchiveAncestry(c,actor.orgId,leaseId);
  await assertCurrentArchiveCaller(c,actor);
  const lease = await c.query<{property_id:string;unit_id:string;target_room_id:string|null}>("SELECT property_id::text,unit_id::text,target_room_id::text FROM leases WHERE id=$1 AND org_id=$2 FOR UPDATE",[leaseId,actor.orgId]);
  if (lease.rowCount !== 1) throw new Error("Signing context unavailable");
  if (JSON.stringify(lease.rows[0]) !== JSON.stringify(target)) throw new Error("Signing context unavailable");
  await assertCurrentArchiveCaller(c,actor);
  await requireEsignOrganization(c, actor, true, enabled);
  await authorized(c,actor);
}

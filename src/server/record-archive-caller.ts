import type { Client } from "pg";
import type { Session } from "./types";
import { FlowError } from "./errors";
import { isUuid } from "./repair-rules";

type Caller = Pick<Session, "sessionId" | "userId" | "orgId" | "liveOrgId" | "environment" | "kind" | "role" | "needsSandbox">;

/** Recheck the existing caller after a newly introduced archive lock can wait. */
export async function assertCurrentArchiveCaller(c: Pick<Client, "query">, s: Caller) {
  if (s.needsSandbox || ![s.sessionId, s.userId, s.orgId, s.liveOrgId].every(isUuid)) throw new FlowError("errors.notFound");
  const result = await c.query(`SELECT 1 FROM public.organizations o
    JOIN public.auth_sessions a ON a.id=$1::uuid AND a.user_id=$2::uuid
   WHERE o.id=$3::uuid AND o.environment::text=$5
     AND ((o.environment='live' AND o.id=$4::uuid AND o.live_org_id IS NULL)
       OR (o.environment='sandbox' AND o.live_org_id=$4::uuid))
     AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp()
     AND (($6='staff' AND $7::text IS NOT NULL AND EXISTS
       (SELECT 1 FROM public.org_members m WHERE m.org_id=$4::uuid AND m.user_id=$2::uuid AND m.status='active' AND m.role::text=$7))
       OR ($6 IN ('tenant','owner') AND $7::text IS NULL AND NOT EXISTS
       (SELECT 1 FROM public.org_members sm LEFT JOIN public.organizations so ON so.id=sm.org_id
         WHERE sm.user_id=$2::uuid AND sm.status='active' AND (so.id IS NULL OR so.environment='live')) AND EXISTS
       (SELECT 1 FROM public.contacts ct WHERE ct.org_id=o.id AND ct.user_id=$2::uuid AND ct.archived_at IS NULL
          AND (($6='tenant' AND ct.is_tenant) OR ($6='owner' AND ct.is_owner)))))`,
  [s.sessionId, s.userId, s.orgId, s.liveOrgId, s.environment, s.kind, s.role]);
  if (result.rowCount !== 1) throw new FlowError("errors.notFound");
}

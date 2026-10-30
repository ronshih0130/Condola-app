import { consentCoversCurrent } from "../consent";
import { svc } from "../db";
import { FlowError } from "../errors";
import type { Session } from "../types";
import type { Connection } from "./repo";
import type { SigningActor } from "./lock";

// Preserve typed denials across the database transaction wrapper.
export class EsignUnavailable extends FlowError {
  constructor(readonly reason: string) { super("errors.notFound"); }
}
export class EsignDenied extends FlowError {
  constructor(readonly reason: string) { super("errors.forbidden"); }
}

export function esignEnabled() {
  return process.env.ESIGN_ENABLED === "true";
}

export function requireEsign(session: Session, enabled = esignEnabled()) {
  if (!consentCoversCurrent(session.consent ?? null)) throw new EsignDenied("consent");
  if (!enabled) throw new EsignUnavailable("E-sign unavailable");
}

/** Writes pin the rollout row before any lease/case lock, fencing disable races. */
export async function requireEsignOrganization(c: Connection, actor: SigningActor, lock: boolean, enabled = esignEnabled()) {
  if (!enabled) throw new EsignUnavailable("E-sign unavailable");
  const row = await c.query(
    `SELECT id FROM organizations WHERE id=$1 AND environment::text=$2
       AND coalesce(live_org_id,id)=$3 AND feature_flags->'esign'='true'::jsonb
       AND (($2='live' AND id=$3) OR ($2='sandbox' AND live_org_id=$3))
       ${lock ? "FOR SHARE" : ""}`,
    [actor.orgId, actor.environment, actor.liveOrgId],
  );
  if (row.rowCount !== 1) throw new EsignUnavailable("E-sign unavailable");
}

export async function esignAvailableFor(session: Session) {
  if (!esignEnabled()) return false;
  try {
    await svc(session.userId, c => requireEsignOrganization(c, session, false));
    return true;
  } catch (error) {
    if (error instanceof EsignUnavailable) return false;
    throw error;
  }
}

// TODO decision: "which Condola roles = 管理團隊".
// M3 mapping: admin -> company_admin; manager -> company_staff.
export function management(session: Session) {
  return session.kind === "staff" && (session.role === "admin" || session.role === "manager");
}

export function requireManagement(session: Session, adminOnly = false) {
  if (!management(session) || (adminOnly && session.role !== "admin")) {
    throw new EsignDenied("Company permission required");
  }
}

import { consentCoversCurrent } from "../consent";
import type { Session } from "../types";

export class EsignUnavailable extends Error {}
export class EsignDenied extends Error {}

export function esignEnabled() {
  return process.env.ESIGN_ENABLED === "true";
}

export function requireEsign(session: Session, enabled = esignEnabled()) {
  if (!consentCoversCurrent(session.consent ?? null)) throw new EsignDenied("consent");
  if (!enabled) throw new EsignUnavailable("E-sign unavailable");
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

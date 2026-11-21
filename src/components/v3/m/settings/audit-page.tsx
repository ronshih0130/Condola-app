import React from "react";
import { auditV3Href, auditV3Read, parseAuditV3, type AuditV3Query } from "../../../../server/b073-audit";
import type { Session } from "../../../../server/types";
import { AuditError, AuditView } from "./audit";

/** R5-AUDIT body (brand_v3 only; the route renders AuditLoading while this reads). */
export async function AuditV3Section({ session, query }: { session: Session; query: AuditV3Query }) {
  const read = await auditV3Read(session, query);
  // The route already redirects a non-admin; a forbidden read here (authority changed mid-request) shows nothing.
  if (read.state === "forbidden") return null;
  if (read.state !== "ready") {
    const filters = parseAuditV3(query);
    return <AuditError locale={session.locale} retryHref={auditV3Href(filters, { cursor: filters.cursor, before: filters.before })} />;
  }
  return <AuditView locale={session.locale} page={read} />;
}

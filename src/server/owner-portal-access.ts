import type { Client } from "pg";
import { tx } from "./db";
import { isUuid } from "./repair-rules";
import type { Session } from "./types";

/**
 * B-023 slice 1: owner document center and read-only repair progress.
 * Every read is gated by the strict `owner_portal_extensions` flag (global row +
 * org allowlist + organizations.feature_flags === true). OFF ⇒ null before any
 * B-023 gateway is called, so pages 404 and nothing is written.
 * Authority is decided in the database (app.b023_*), from property_owners windows.
 */
export const OWNER_PORTAL_FLAG = "owner_portal_extensions";

export function ownerPortalFlagValue(global: unknown, orgFlags: unknown, orgId: string) {
  if (!global || typeof global !== "object" || Array.isArray(global)) return false;
  if (!orgFlags || typeof orgFlags !== "object" || Array.isArray(orgFlags)) return false;
  const g = global as Record<string, unknown>;
  const flags = orgFlags as Record<string, unknown>;
  return g.enabled === true && Array.isArray(g.allowed_org_ids) &&
    g.allowed_org_ids.includes(orgId.toLowerCase()) && flags[OWNER_PORTAL_FLAG] === true;
}

export async function ownerPortalExtensionsEnabled(client: Client, orgId: string) {
  const row = (await client.query<{ value: unknown; feature_flags: unknown }>(
    `SELECT (SELECT value FROM public.platform_settings WHERE key=$2) AS value, feature_flags
       FROM public.organizations WHERE id=$1`, [orgId, OWNER_PORTAL_FLAG],
  )).rows[0];
  return !!row && ownerPortalFlagValue(row.value, row.feature_flags, orgId);
}

export type OwnerDocumentRow = {
  document_id: string; lease_id: string; property_name: string; unit_label: string | null; room_label: string | null;
  lease_start: string; lease_end: string | null; lease_status: string; uploaded_at: string; size_bytes: number;
  is_current_version: boolean; access: "current" | "history";
};
export type OwnerRepairRow = {
  ticket_id: string; ticket_number: number; property_name: string; unit_label: string | null; room_label: string | null;
  category: string; priority: string; status: string; title: string; reported_at: string;
  last_status_at: string | null; access: "current" | "history";
};
export type OwnerRepairEvent = { from: string | null; to: string; at: string };
export type OwnerRepairDetail = OwnerRepairRow & { timeline: OwnerRepairEvent[] };
export type OwnerDocumentFile = { content: Uint8Array; file_name: string; size_bytes: number };

function ownerSession(s: Session) {
  return s.kind === "owner" && !s.needsSandbox && [s.userId, s.orgId].every(isUuid) && ["live", "sandbox"].includes(s.environment);
}
function scope(s: Session) { return { orgId: s.orgId, environment: s.environment }; }
async function currentSession(client: Client, s: Session) {
  if (!isUuid(s.sessionId)) return false;
  return (await client.query(`SELECT 1 FROM public.auth_sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()`,
    [s.sessionId, s.userId])).rowCount === 1;
}

/** Nav/page gate. Read-only; false on any error. */
export async function ownerPortalExtensionsOn(session: Session) {
  if (!ownerSession(session)) return false;
  try {
    return await tx(session.userId, client => ownerPortalExtensionsEnabled(client, session.orgId), scope(session), { readOnly: true });
  } catch { return false; }
}

export async function ownerDocuments(session: Session): Promise<OwnerDocumentRow[] | null> {
  if (!ownerSession(session)) return null;
  try {
    return await tx(session.userId, async client => {
      if (!await ownerPortalExtensionsEnabled(client, session.orgId)) return null;
      return (await client.query<OwnerDocumentRow>(
        `SELECT document_id::text, lease_id::text, property_name, unit_label, room_label, lease_start::text, lease_end::text,
                lease_status, uploaded_at::text, size_bytes, is_current_version, access
           FROM app.b023_owner_documents($1)`, [session.orgId])).rows;
    }, scope(session), { isolation: "repeatable read", readOnly: true });
  } catch { return null; }
}

/**
 * Authorized view/download. The DB gateway re-checks authority, appends one access
 * row and returns the bytes. Null ⇒ 404 (OFF, foreign id, no authority, revoked session).
 * A view or download never records consent, signature, acknowledgement or confirmation.
 */
export async function openOwnerDocument(session: Session, documentId: string, kind: "view" | "download", requestId: string): Promise<OwnerDocumentFile | null> {
  if (!ownerSession(session) || !isUuid(documentId) || !isUuid(requestId) || (kind !== "view" && kind !== "download")) return null;
  try {
    return await tx(session.userId, async client => {
      if (!await ownerPortalExtensionsEnabled(client, session.orgId) || !await currentSession(client, session)) return null;
      const row = (await client.query<{ content: Buffer; file_name: string; size_bytes: number }>(
        `SELECT content, file_name, size_bytes FROM app.b023_open_owner_document($1,$2,$3,$4)`,
        [session.orgId, documentId, requestId, kind])).rows[0];
      return row ? { content: Uint8Array.from(row.content), file_name: row.file_name, size_bytes: row.size_bytes } : null;
    }, scope(session));
  } catch { return null; }
}

export async function ownerRepairs(session: Session): Promise<OwnerRepairRow[] | null> {
  if (!ownerSession(session)) return null;
  try {
    return await tx(session.userId, async client => {
      if (!await ownerPortalExtensionsEnabled(client, session.orgId)) return null;
      return (await client.query<OwnerRepairRow>(
        `SELECT ticket_id::text, ticket_number, property_name, unit_label, room_label, category, priority, status, title,
                reported_at::text, last_status_at::text, access
           FROM app.b023_owner_repairs($1)`, [session.orgId])).rows;
    }, scope(session), { isolation: "repeatable read", readOnly: true });
  } catch { return null; }
}

export async function ownerRepairDetail(session: Session, ticketId: string): Promise<OwnerRepairDetail | null> {
  if (!ownerSession(session) || !isUuid(ticketId)) return null;
  try {
    return await tx(session.userId, async client => {
      if (!await ownerPortalExtensionsEnabled(client, session.orgId)) return null;
      return (await client.query<OwnerRepairDetail>(
        `SELECT ticket_id::text, ticket_number, property_name, unit_label, room_label, category, priority, status, title,
                reported_at::text, last_status_at::text, access, timeline
           FROM app.b023_owner_repair_detail($1,$2)`, [session.orgId, ticketId])).rows[0] ?? null;
    }, scope(session), { isolation: "repeatable read", readOnly: true });
  } catch { return null; }
}

import { query, svc } from "./db";
import type { SignedPdfDownloadAudit } from "./tenant-signed-pdf-download";

/** Auth and team events. The ledger trigger still audits row changes; this records who signed in. */
type Sql = { query: (sql: string, params?: unknown[]) => Promise<unknown> };

export async function writeAudit(
  orgId: string | null,
  userId: string | null,
  event: string,
  detail: Record<string, unknown> = {},
  client?: Sql,
) {
  const sql = `INSERT INTO audit_log (org_id, actor_user_id, actor_role, table_name, row_id, action, event_type, new_row, reason)
     VALUES ($1, $2, 'app', 'auth_events', $3, 'insert', $3, $4::jsonb, $3)`;
  const params = [orgId, userId, event, JSON.stringify({ event, ...detail })];
  if (client) await client.query(sql, params);
  else await query(sql, params);
}

/** A successful lease or statement PDF download. Written after the RLS read succeeds. */
export async function writePdfDownload(
  orgId: string,
  userId: string,
  actorRole: string,
  table: "leases" | "owner_statements",
  rowId: string,
  detail: Record<string, unknown> = {},
) {
  await query(
    `INSERT INTO audit_log (org_id, actor_user_id, actor_role, table_name, row_id, action, event_type, new_row, reason)
     VALUES ($1, $2, $3, $4, $5, 'insert', 'pdf_download', $6::jsonb, 'pdf_download')`,
    [orgId, userId, actorRole, table, rowId, JSON.stringify({ event: "pdf_download", ...detail })],
  );
}

/**
 * Call only after the tenant's RLS read and PDF response construction succeed.
 * authenticated cannot INSERT audit_log; this separate service_role transaction
 * bypasses RLS without granting tenants audit write privileges.
 */
export async function writeSignedPdfDownload(event: SignedPdfDownloadAudit) {
  await svc(event.userId, (client) => client.query(
    `INSERT INTO audit_log
       (org_id, actor_user_id, actor_role, table_name, row_id, action,
        event_type, new_row, reason, request_id)
     VALUES ($1, $2, 'tenant', 'lease_signed_pdfs', $3, 'insert',
             'signed_pdf_downloaded', $4::jsonb, 'signed_pdf_downloaded', $5)`,
    [
      event.orgId,
      event.userId,
      event.pdfId,
      JSON.stringify({
        event: "signed_pdf_downloaded",
        lease_id: event.leaseId,
      }),
      event.requestId,
    ],
  ));
}

/** Staff download. Reason is a fixed code. The PDF name and replacement text are not stored. */
export async function writeStaffSignedPdfDownload(event: SignedPdfDownloadAudit & { actorRole: "admin" | "manager" }) {
  await svc(event.userId, (client) => client.query(
    `INSERT INTO audit_log
       (org_id, actor_user_id, actor_role, table_name, row_id, action,
        event_type, new_row, reason, request_id)
     VALUES ($1, $2, $3, 'lease_signed_pdfs', $4, 'insert',
             'signed_pdf_downloaded', $5::jsonb, 'signed_pdf_downloaded', $6)`,
    [
      event.orgId,
      event.userId,
      event.actorRole,
      event.pdfId,
      JSON.stringify({
        event: "signed_pdf_downloaded",
        lease_id: event.leaseId,
      }),
      event.requestId,
    ],
  ));
}

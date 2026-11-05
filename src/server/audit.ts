import { svc } from "./db";
import { recordAudit, svcAuditScope, type Sql } from "./audit-write";
import type { SignedPdfDownloadAudit } from "./tenant-signed-pdf-download";

/** Auth and team events. The ledger trigger still audits row changes; this records who signed in. */
export async function writeAudit(
  orgId: string | null,
  userId: string | null,
  event: string,
  detail: Record<string, unknown> = {},
  client?: Sql,
) {
  await recordAudit(
    svcAuditScope({ orgId, actorUserId: userId, actorRole: "app" }),
    {
      table: "auth_events",
      rowId: event,
      action: "insert",
      eventType: event,
      newRow: { event, ...detail },
      reason: event,
    },
    client,
  );
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
  await recordAudit(
    svcAuditScope({ orgId, actorUserId: userId, actorRole }),
    {
      table,
      rowId,
      action: "insert",
      eventType: "pdf_download",
      newRow: { event: "pdf_download", ...detail },
      reason: "pdf_download",
    },
  );
}

/**
 * Call only after the tenant's RLS read and PDF response construction succeed.
 * authenticated cannot INSERT audit_log; this separate service_role transaction
 * bypasses RLS without granting tenants audit write privileges.
 */
export async function writeSignedPdfDownload(event: SignedPdfDownloadAudit) {
  await svc(event.userId, (client) => recordAudit(
    svcAuditScope({
      orgId: event.orgId,
      actorUserId: event.userId,
      actorRole: "tenant",
    }),
    {
      table: "lease_signed_pdfs",
      rowId: event.pdfId,
      action: "insert",
      eventType: "signed_pdf_downloaded",
      newRow: {
        event: "signed_pdf_downloaded",
        lease_id: event.leaseId,
      },
      reason: "signed_pdf_downloaded",
      requestId: event.requestId,
    },
    client,
  ));
}

/** Staff download. Reason is a fixed code. The PDF name and replacement text are not stored. */
export async function writeStaffSignedPdfDownload(event: SignedPdfDownloadAudit & { actorRole: "admin" | "manager" }) {
  await svc(event.userId, (client) => recordAudit(
    svcAuditScope({
      orgId: event.orgId,
      actorUserId: event.userId,
      actorRole: event.actorRole,
    }),
    {
      table: "lease_signed_pdfs",
      rowId: event.pdfId,
      action: "insert",
      eventType: "signed_pdf_downloaded",
      newRow: {
        event: "signed_pdf_downloaded",
        lease_id: event.leaseId,
      },
      reason: "signed_pdf_downloaded",
      requestId: event.requestId,
    },
    client,
  ));
}

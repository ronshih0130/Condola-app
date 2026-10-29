import { writeAudit } from "./audit";
import { many, tx } from "./db";
import { FlowError } from "./errors";
import {
  PAPER_LEASE_VERSIONS_ENABLED,
  PaperLeaseReasonError,
  paperLeaseVersionsOn,
  validatePaperLeaseReason,
} from "./paper-lease-versions-rules";
import type { Session } from "./types";

type Client = Parameters<typeof many>[0];
type PreparedVersion =
  | { enabled: false }
  | { enabled: true; supersedesId: string | null; reason: string | null };

export async function paperLeaseVersionsEnabled(
  client: Client,
  orgId: string,
  killSwitch: boolean = PAPER_LEASE_VERSIONS_ENABLED,
) {
  // No org query while globally disabled, including before the migration exists.
  if (killSwitch !== true) return false;
  const rows = await many<{ feature_flags: unknown }>(
    client,
    `SELECT feature_flags FROM organizations WHERE id = $1`,
    [orgId],
  );
  return paperLeaseVersionsOn(killSwitch, rows[0]?.feature_flags);
}

/**
 * Called before inserting files. Serialize enabled uploads on the parent lease
 * so concurrent replacements cannot both replace the same current version.
 * The explicit switch supports integration coverage while production callers
 * always use the global default.
 */
export async function preparePaperLeaseVersion(
  client: Client,
  session: Session,
  leaseId: string,
  reason: unknown,
  killSwitch: boolean = PAPER_LEASE_VERSIONS_ENABLED,
): Promise<PreparedVersion> {
  if (!(await paperLeaseVersionsEnabled(client, session.orgId, killSwitch))) return { enabled: false };
  if (session.kind !== "staff" || !["admin", "manager"].includes(session.role ?? "")) {
    throw new FlowError("errors.notFound");
  }
  const leases = await many<{ id: string }>(
    client,
    `SELECT id::text FROM leases WHERE org_id = $1 AND id = $2 FOR UPDATE`,
    [session.orgId, leaseId],
  );
  if (!leases.length) throw new FlowError("errors.notFound");
  const previous = await many<{ id: string }>(
    client,
    `SELECT p.id::text
       FROM lease_signed_pdfs p
       JOIN leases l ON l.org_id = p.org_id AND l.id = p.lease_id
      WHERE p.org_id = $1 AND p.lease_id = $2
      ORDER BY (p.file_id = l.document_file_id) DESC NULLS LAST,
               p.created_at DESC, p.id DESC
      LIMIT 1`,
    [session.orgId, leaseId],
  );
  const validated = validatePaperLeaseReason(previous.length > 0, reason);
  if (!validated.ok) throw new PaperLeaseReasonError();
  return { enabled: true, supersedesId: previous[0]?.id ?? null, reason: validated.value };
}

/** Uses the caller's transaction so the file, lease pointer and audit commit together. */
export async function insertPaperLeaseVersion(
  client: Client,
  session: Session,
  input: {
    leaseId: string;
    fileId: string;
    path: string;
    content: Uint8Array;
    version: Extract<PreparedVersion, { enabled: true }>;
  },
) {
  const rows = await many<{ id: string }>(
    client,
    `INSERT INTO lease_signed_pdfs
       (org_id, lease_id, file_id, bucket, object_path, content, uploaded_by, replace_reason, supersedes_id)
     VALUES ($1,$2,$3,'lease-documents-private',$4,$5,$6,$7,$8)
     RETURNING id::text`,
    [
      session.orgId, input.leaseId, input.fileId, input.path, Buffer.from(input.content),
      session.userId, input.version.reason, input.version.supersedesId,
    ],
  );
  const id = rows[0].id;
  if (input.version.supersedesId) {
    await writeAudit(session.orgId, session.userId, "paper_lease_replaced", {
      lease_id: input.leaseId,
      lease_signed_pdf_id: id,
      file_id: input.fileId,
      size_bytes: input.content.byteLength,
      supersedes_id: input.version.supersedesId,
      reason: input.version.reason,
    }, client);
  }
  return id;
}

export type PaperLeaseVersion = {
  id: string;
  file_id: string;
  file_name: string;
  size_bytes: string;
  created_at: string;
  uploaded_by: string | null;
  replace_reason: string | null;
  supersedes_id: string | null;
  current: boolean;
};

/** null means disabled; callers must render their existing HTML verbatim. */
export async function listPaperLeaseVersions(
  session: Session,
  leaseId: string,
): Promise<PaperLeaseVersion[] | null> {
  if (!PAPER_LEASE_VERSIONS_ENABLED || session.kind !== "staff") return null;
  return tx(session.userId, async (client) => {
    if (!(await paperLeaseVersionsEnabled(client, session.orgId))) return null;
    return many<PaperLeaseVersion>(
      client,
      `SELECT p.id::text, f.id::text AS file_id, f.file_name,
              f.size_bytes::text, p.created_at::text,
              coalesce(p.uploaded_by, f.uploaded_by)::text AS uploaded_by,
              p.replace_reason, p.supersedes_id::text,
              row_number() OVER (
                ORDER BY (p.file_id = l.document_file_id) DESC NULLS LAST,
                         p.created_at DESC, p.id DESC
              ) = 1 AS current
         FROM lease_signed_pdfs p
         JOIN files f ON f.org_id = p.org_id AND f.id = p.file_id
         JOIN leases l ON l.org_id = p.org_id AND l.id = p.lease_id
        WHERE p.org_id = $1 AND p.lease_id = $2
        ORDER BY current DESC, p.created_at DESC, p.id DESC`,
      [session.orgId, leaseId],
    );
  }, { orgId: session.orgId });
}

export async function paperLeaseVersionPdf(session: Session, leaseId: string, pdfId: string) {
  if (!PAPER_LEASE_VERSIONS_ENABLED || session.kind !== "staff") return null;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(leaseId) || !uuid.test(pdfId)) return null;
  return tx(session.userId, async (client) => {
    if (!(await paperLeaseVersionsEnabled(client, session.orgId))) return null;
    const rows = await many<{ content: Buffer; file_name: string }>(
      client,
      `SELECT p.content, f.file_name
         FROM lease_signed_pdfs p
         JOIN files f ON f.org_id = p.org_id AND f.id = p.file_id
        WHERE p.org_id = $1 AND p.lease_id = $2 AND p.id = $3`,
      [session.orgId, leaseId, pdfId],
    );
    return rows[0] ?? null;
  }, { orgId: session.orgId });
}

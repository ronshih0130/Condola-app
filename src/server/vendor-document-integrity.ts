import type { Client } from "pg";
import { recordAudit, svcAuditScope } from "./audit-write";
import { many, one } from "./db";
import { FlowError } from "./errors";
import { admitVendorDocumentsOrgOn } from "./vendor-document-admission";
import { validateSealImageHeader } from "./vendor-onboarding-rules";
import { sha256 } from "./vendor-receipt-pdf";
import { vendorProfileSealOn, type resolveVendorDocumentToken } from "./vendor-receipt";
import type { VendorDocument } from "./vendor-receipt-rules";

type Access = Awaited<ReturnType<typeof resolveVendorDocumentToken>>;
const uuid = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(s);

/** Called after live token admission; scope comes exclusively from the capability. */
async function pinScope(client: Client, access: Access) {
  await admitVendorDocumentsOrgOn(client, access.orgId);
  await one(client, `SELECT id FROM vendor_document_grants WHERE id=$1 AND org_id=$2 AND ticket_id=$3
    AND vendor_profile_id=$4 AND scope='vendor_document' AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`,
  [access.grantId, access.orgId, access.ticket.id, access.profile.id]);
}
async function audit(client: Client, access: Access, event: string, id: string, detail: Record<string, unknown>) {
  await recordAudit(svcAuditScope({ orgId: access.orgId, actorUserId: null, actorRole: "vendor" }), {
    table: event === "vendor_fixed_data_version" ? "vendor_profile_versions" : "b025_paper_scans",
    rowId: id, action: "insert", eventType: event,
    newRow: { ...detail, grantId: access.grantId }, reason: event,
  }, client);
}

export function decodeDocumentAttachment(base64: unknown, mime: unknown): Uint8Array {
  if (typeof base64 !== "string" || base64.length > 6990508 || base64.length % 4 !== 0) {
    throw new FlowError("errors.required");
  }
  const bytes = new Uint8Array(Buffer.from(base64, "base64"));
  if (Buffer.from(bytes).toString("base64") !== base64 || !bytes.length || bytes.length > 5242880) throw new FlowError("errors.required");
  if (mime === "application/pdf") {
    if (Buffer.from(bytes.subarray(0, 5)).toString() !== "%PDF-") throw new FlowError("errors.required");
  } else {
    const checked = validateSealImageHeader(bytes);
    if (!checked.ok || checked.mimeType !== mime) throw new FlowError("errors.required");
  }
  return bytes;
}

export type { FixedDataUpdate } from '@/lib/vendor-document-ui';
import type { FixedDataUpdate } from '@/lib/vendor-document-ui';

/** Append a version, never mutate an issued version or an old seal object. */
export async function updateVendorFixedDataOn(client: Client, access: Access, input: FixedDataUpdate) {
  await pinScope(client, access);
  if (!input || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion !== access.profile.current_version) {
    throw new FlowError("errors.required");
  }
  const allowed = ["expectedVersion", "display_name", "business_name", "representative_name", "phone_e164", "address", "seal"];
  if (Object.keys(input).some((key) => !allowed.includes(key)) || Object.keys(input).length < 2) throw new FlowError("errors.required");
  const next = { ...access.profile };
  for (const key of ["display_name", "business_name", "representative_name", "phone_e164", "address"] as const) {
    if (input[key] === undefined) continue;
    const value = input[key];
    // Only an individual's optional address supports explicit clearing.
    if (key === "address" && value === null && next.kind === "individual") { next.address = null; continue; }
    if (typeof value !== "string" || !value.trim() || value.length > (key === "address" ? 500 : 200)
      || /[\u0000-\u001f\u007f]/.test(value)) throw new FlowError("errors.required");
    next[key] = value.trim();
  }
  if (!/^\+[1-9][0-9]{6,14}$/.test(next.phone_e164)) throw new FlowError("errors.required");
  let seal: Awaited<ReturnType<typeof vendorProfileSealOn>>;
  if (input.seal !== undefined) {
    if (access.profile.kind !== "business" || !input.seal || !["image/png", "image/jpeg"].includes(input.seal.mimeType)) throw new FlowError("errors.required");
    seal = { bytes: decodeDocumentAttachment(input.seal.base64, input.seal.mimeType), mimeType: input.seal.mimeType };
  } else seal = await vendorProfileSealOn(client, access);
  const sealReference = seal ? await one<{ id: string; sha256: string }>(client,
    "SELECT * FROM app.b025_store_profile_seal($1,$2,$3,$4,$5)",
    [access.orgId, access.grantId, next.id, seal.mimeType, Buffer.from(seal.bytes)]) : undefined;
  const snapshot = { confirmation_method: "document_token", seal: sealReference };
  const updated = await client.query(`UPDATE vendor_profiles SET display_name=$3,business_name=$4,representative_name=$5,
    phone_e164=$6,address=$7,current_version=current_version+1,updated_at=clock_timestamp()
    WHERE id=$1 AND org_id=$2 AND current_version=$8`, [next.id, access.orgId, next.display_name, next.business_name, next.representative_name, next.phone_e164, next.address, input.expectedVersion]);
  if (updated.rowCount !== 1) throw new FlowError("errors.required");
  const version = await one<{ id: string; version: number }>(client, `INSERT INTO vendor_profile_versions
    (org_id,vendor_profile_id,version,kind,display_name,business_name,representative_name,tax_id,phone_e164,address,
      service_job_types,qualification_attested_at,seal_file_id,snapshot)
    SELECT org_id,id,current_version,kind,display_name,business_name,representative_name,tax_id,phone_e164,address,
      service_job_types,qualification_attested_at,seal_file_id,$3::jsonb FROM vendor_profiles WHERE id=$1 AND org_id=$2
    RETURNING id::text,version`, [next.id, access.orgId, JSON.stringify(snapshot)]);
  await audit(client, access, "vendor_fixed_data_version", version.id, { profileId: next.id, version: version.version });
  return version;
}

export async function attachVendorPaperScanOn(client: Client, access: Access, input: {
  documentId: string; requestId: string; mimeType: string; base64: string;
}) {
  await pinScope(client, access);
  if (!uuid(input.documentId) || !uuid(input.requestId)) throw new FlowError("errors.required");
  const bytes = decodeDocumentAttachment(input.base64, input.mimeType);
  const result = await one<{ id: string }>(client, "SELECT app.b025_attach_paper_scan($1,$2,$3,$4,$5,$6)::text AS id",
    [access.orgId, access.grantId, input.documentId, input.requestId, input.mimeType, Buffer.from(bytes)]);
  await audit(client, access, "vendor_paper_scan_attach", result.id, { documentId: input.documentId });
  return result;
}

export async function readVendorPaperScanOn(client: Client, access: Access, id: string) {
  if (!uuid(id)) throw new FlowError("errors.notFound");
  const row = await one<{ bytes: Buffer; mime_type: string; sha256: string }>(client,
    "SELECT * FROM app.b025_read_paper_scan($1,$2,$3)", [access.orgId, access.grantId, id]);
  if (await sha256(row.bytes) !== row.sha256) throw new Error("vendor_document_integrity_failure");
  return row;
}

export async function vendorDocumentHistoryOn(client: Client, access: Access) {
  const rows = await many<{
    id: string; status: "issued" | "voided"; snapshot: {
      document: VendorDocument; profileVersionId: string | null;
      issuer: { display_name: string; business_name: string | null; representative_name: string | null; phone_e164: string; address: string | null };
    }; version: number | null; sha256: string; seal_present: boolean;
  }>(client, `SELECT d.id::text,d.status,p.snapshot,v.version,d.pdf_sha256 AS sha256,
      CASE WHEN d.vendor_profile_version_id IS NULL THEN p.snapshot->>'sealFileId' IS NOT NULL
        ELSE (v.seal_file_id IS NOT NULL OR v.snapshot->'seal'->>'id' IS NOT NULL) END AS seal_present
    FROM vendor_documents d JOIN vendor_document_pdf_bytes p ON p.document_id=d.id AND p.org_id=d.org_id
    LEFT JOIN vendor_profile_versions v ON v.id=d.vendor_profile_version_id AND v.org_id=d.org_id AND v.vendor_profile_id=d.vendor_profile_id
    WHERE d.org_id=$1 AND d.ticket_id=$2 AND d.vendor_profile_id=$3
      AND (d.vendor_profile_version_id IS NULL OR v.id IS NOT NULL)
    ORDER BY d.issued_at,d.id`,
  [access.orgId, access.ticket.id, access.profile.id]);
  return Promise.all(rows.map(async (row) => ({
    id: row.id, status: row.status, docNo: row.snapshot.document.doc_no, kind: row.snapshot.document.kind,
    version: row.version, profileVersionId: row.snapshot.profileVersionId,
    issuerName: row.snapshot.issuer.business_name || row.snapshot.issuer.display_name,
    fixedData: { display_name: row.snapshot.issuer.display_name, business_name: row.snapshot.issuer.business_name,
      representative_name: row.snapshot.issuer.representative_name, phone_e164: row.snapshot.issuer.phone_e164,
      address: row.snapshot.issuer.address }, sealPresent: row.seal_present,
    items: row.snapshot.document.items, totalMinor: String(row.snapshot.document.total_minor), sha256: row.sha256,
    scans: row.snapshot.document.kind === "receipt" ? await many<{
      id: string; document_group_id: string; document_id: string; mime_type: string; sha256: string; created_at: string;
    }>(client, "SELECT * FROM app.b025_paper_scan_history($1,$2,$3)", [access.orgId, access.grantId, row.id]) : [],
  })));
}

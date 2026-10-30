import type { Client } from "pg";
import { writeAudit } from "./audit";
import { maybe, one, svc } from "./db";
import { FlowError } from "./errors";
import { deriveTicketDocumentItems, type JobTypeLineItem } from "./job-types-rules";
import { authorizeVendorStaff } from "./vendor-onboarding";
import { PHOTO_BUCKET } from "./repair-rules";
import { downloadRepairObject } from "./ticket-photos";
import type { Session } from "./types";
import { validateSealImageHeader } from "./vendor-onboarding-rules";
import {
  issueVendorDocument as applyIssueRules,
  reissueVendorDocument as applyReissueRules,
  voidVendorDocument as applyVoidRules,
  validateBuyer,
  type BuyerInput,
  type BuyerSnapshot,
  type IssueVendorDocumentInput,
  type VendorDocument,
} from "./vendor-receipt-rules";
import {
  loadVendorPdfFont,
  renderVendorReceiptPdf,
  sha256,
  type VendorPdfIssuer,
} from "./vendor-receipt-pdf";
import { lockTicketThenJobs } from "./vendor-repair";
import { hashVendorToken, newVendorToken } from "./vendor-repair-rules";

export type VendorDocumentActor = string | Session;
export type VendorBuyerSelection =
  | { kind: "company"; name: string; address: string; tax_id: string }
  | { kind: "owner"; contactId: string };

export interface VendorDocumentContext {
  actor: VendorDocumentActor;
  ticketId: string;
  vendorProfileId: string;
  /** Required for staff preview; token callers use the confirmed selection. */
  buyer?: VendorBuyerSelection;
  items: readonly JobTypeLineItem[];
  totalMinor: number;
  documentDate: string;
  /** Supply from the existing bundled font or a trusted asset binding. */
  fontBytes?: Uint8Array;
}

interface Grant {
  id: string;
  org_id: string;
  ticket_id: string;
  job_id: string;
  vendor_profile_id: string;
  buyer_selection: VendorBuyerSelection;
}

interface Ticket {
  id: string;
  ticket_number: string;
  org_id: string;
  property_id: string;
  assigned_vendor_contact_id: string | null;
  final_cost_minor: string | null;
  status: string;
  work_address: string | null;
  type_fields: Record<string, unknown>;
}

interface Profile extends VendorPdfIssuer {
  id: string;
  org_id: string;
  contact_id: string;
  vendor_code: string;
  kind: "business" | "individual";
  qualification_attested_at: string | null;
  seal_file_id: string | null;
  current_version: number;
}

interface Access {
  orgId: string;
  userId: string | null;
  grantId: string | null;
  ticket: Ticket;
  profile: Profile;
  buyerSelection?: VendorBuyerSelection;
}

export interface StoredVendorDocument {
  document: VendorDocument;
  issuedAt: string;
  documentDate: string;
  sha256: string;
  bytesReference: { table: "vendor_document_pdf_bytes"; documentId: string };
}

function notFound(): never {
  throw new FlowError("errors.notFound");
}

/** Execution requires a live vendor document capability, never a staff session. */
function requireVendorToken(actor: VendorDocumentActor): asserts actor is string {
  if (typeof actor !== "string") throw new FlowError("errors.forbidden");
}

function validKey(key: string) {
  if (typeof key !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(key)) {
    throw new Error("invalid_idempotency_key");
  }
}

async function ticketOn(client: Client, orgId: string, ticketId: string) {
  const ticket = await maybe<Ticket>(
    client,
    `SELECT t.id::text, t.ticket_number::text, t.org_id::text, t.property_id::text,
            t.assigned_vendor_contact_id::text, t.final_cost_minor::text,
            t.status::text, t.type_fields, p.address_display AS work_address
       FROM maintenance_tickets t
       JOIN properties p ON p.id = t.property_id AND p.org_id = t.org_id
      WHERE t.id = $1 AND t.org_id = $2`,
    [ticketId, orgId],
  );
  if (!ticket) notFound();
  return ticket;
}

async function grantOn(client: Client, token: string) {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) notFound();
  const grant = await maybe<Grant>(
    client,
    `SELECT id::text, org_id::text, ticket_id::text, job_id::text,
            vendor_profile_id::text, buyer_selection
       FROM vendor_document_grants
      WHERE token_hash = $1 AND scope = 'vendor_document'`,
    [hashVendorToken(token)],
  );
  if (!grant) notFound();
  return grant;
}

async function authorize(
  client: Client,
  actor: VendorDocumentActor,
  ticketId: string,
  profileId: string,
  purpose: "issuance" | "issued_document" = "issuance",
): Promise<Access> {
  const grant = typeof actor === "string" ? await grantOn(client, actor) : null;
  let orgId: string;
  let userId: string | null;
  if (typeof actor === "string") {
    if (!grant || grant.ticket_id !== ticketId || grant.vendor_profile_id !== profileId) {
      notFound();
    }
    orgId = grant.org_id;
    userId = null;
  } else {
    await authorizeVendorStaff(client, actor);
    orgId = actor.orgId;
    userId = actor.userId;
  }

  await lockTicketThenJobs(client, orgId, ticketId);
  const ticket = await ticketOn(client, orgId, ticketId);
  const profile = await maybe<Profile>(
    client,
    `SELECT id::text, org_id::text, contact_id::text, vendor_code, kind,
            display_name, business_name, representative_name, tax_id,
            phone_e164, address, qualification_attested_at::text,
            seal_file_id::text, current_version
       FROM vendor_profiles
      WHERE id = $1 AND org_id = $2
      FOR UPDATE`,
    [profileId, orgId],
  );
  if (
    !profile ||
    (purpose === "issuance" &&
      profile.contact_id !== ticket.assigned_vendor_contact_id)
  ) {
    notFound();
  }

  if (grant) {
    // Document grants have their own expiry and explicit revocation. Losing
    // collaboration access does not remove access to the issuer's documents.
    // Fresh issuance still requires both the current assignment and a live job.
    const live = await maybe<{ id: string }>(
      client,
      `SELECT g.id::text
         FROM vendor_document_grants g
         JOIN repair_vendor_jobs j
           ON j.id = g.job_id AND j.ticket_id = g.ticket_id AND j.org_id = g.org_id
        WHERE g.id = $1 AND g.scope = 'vendor_document'
          AND g.revoked_at IS NULL AND g.expires_at > clock_timestamp()
          AND ($2::boolean OR (j.active AND j.revoked_at IS NULL))
        FOR UPDATE OF g`,
      [grant.id, purpose === "issued_document"],
    );
    if (!live) notFound();
  }

  return {
    orgId,
    userId,
    grantId: grant?.id ?? null,
    ticket,
    profile,
    buyerSelection: grant?.buyer_selection,
  };
}

async function buyerOn(
  client: Client,
  access: Access,
  selection: VendorBuyerSelection | undefined,
): Promise<BuyerSnapshot> {
  if (!selection) throw new Error("missing_buyer_selection");
  if (selection.kind === "company") {
    return validateBuyer({
      kind: "company",
      name: selection.name,
      address: selection.address,
      tax_id: selection.tax_id,
    });
  }
  const owner = await maybe<{ receipt_title: string | null }>(
    client,
    `SELECT c.receipt_title
       FROM property_owners po
       JOIN contacts c ON c.id = po.owner_contact_id AND c.org_id = po.org_id
      WHERE po.org_id = $1 AND po.property_id = $2
        AND c.id = $3 AND c.is_owner AND c.archived_at IS NULL
        AND po.effective_from <= current_date
        AND (po.effective_to IS NULL OR po.effective_to >= current_date)
      ORDER BY po.effective_from DESC
      LIMIT 1`,
    [access.orgId, access.ticket.property_id, selection.contactId],
  );
  if (!owner) notFound();
  return validateBuyer({ kind: "owner", receipt_title: owner.receipt_title });
}

function checkDate(date: string, today: string) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(Date.parse(`${date}T00:00:00.000Z`)) ||
    new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date ||
    date > today
  ) {
    throw new Error("invalid_document_date");
  }
}

async function issueInput(
  client: Client,
  access: Access,
  ctx: VendorDocumentContext,
  id: string,
  seq: number,
): Promise<IssueVendorDocumentInput> {
  if (access.ticket.status !== "closed") throw new Error("ticket_not_closed");
  if (!access.ticket.work_address?.trim()) throw new Error("missing_work_address");
  const clock = await one<{ today: string }>(
    client,
    `SELECT (clock_timestamp() AT TIME ZONE 'Asia/Taipei')::date::text AS today`,
  );
  checkDate(ctx.documentDate, clock.today);
  const { profile } = access;
  if (
    profile.kind === "business" &&
    (!profile.qualification_attested_at ||
      !profile.business_name?.trim() ||
      !profile.representative_name?.trim() ||
      !profile.address?.trim() ||
      !profile.seal_file_id)
  ) {
    throw new Error("vendor_profile_incomplete");
  }

  const buyer = await buyerOn(client, access, access.buyerSelection ?? ctx.buyer);
  // Repair costs are cents; document rules require integer NT$.
  const cents = access.ticket.final_cost_minor;
  if (
    cents === null ||
    !/^\d+$/.test(cents) ||
    BigInt(cents) % BigInt(100) !== BigInt(0)
  ) {
    throw new Error("invalid_ticket_cost");
  }
  const actual = Number(BigInt(cents) / BigInt(100));
  if (!Number.isSafeInteger(actual)) throw new Error("invalid_ticket_cost");
  return {
    id,
    vendor_profile_id: profile.id,
    ticket_id: access.ticket.id,
    vendor_code: profile.vendor_code,
    vendor: {
      kind: profile.kind,
      tax_id: profile.tax_id,
      qualification_attested: profile.qualification_attested_at !== null,
    },
    seq,
    buyer: buyer as BuyerInput,
    items: deriveTicketDocumentItems(ctx.items, access.ticket.type_fields),
    total_minor: ctx.totalMinor,
    ticket_actual_cost_minor: actual,
    locale: "zh-TW",
  };
}

async function fontOn(ctx: VendorDocumentContext) {
  if (ctx.fontBytes) return ctx.fontBytes;
  const origin = process.env.APP_URL;
  if (!origin) throw new Error("vendor_pdf_font_origin_required");
  return loadVendorPdfFont(origin);
}

async function sealOn(client: Client, access: Access) {
  if (access.profile.kind !== "business") return undefined;
  const file = await maybe<{ storage_path: string }>(
    client,
    `SELECT storage_path FROM files
      WHERE id = $1 AND org_id = $2 AND storage_bucket = $3
        AND size_bytes BETWEEN 1 AND 5242880
      FOR SHARE`,
    [access.profile.seal_file_id, access.orgId, PHOTO_BUCKET],
  );
  if (!file) throw new Error("missing_seal_image");
  const bytes = await downloadRepairObject(file.storage_path);
  const checked = validateSealImageHeader(bytes);
  if (!checked.ok) throw new Error(checked.error);
  return { bytes, mimeType: checked.mimeType };
}

async function renderOn(
  client: Client,
  access: Access,
  ctx: VendorDocumentContext,
  document: VendorDocument,
  issuedAt: string,
  preview: boolean,
) {
  return renderVendorReceiptPdf(
    {
      document,
      issuer: {
        display_name: access.profile.display_name,
        business_name: access.profile.business_name,
        representative_name: access.profile.representative_name,
        tax_id: access.profile.tax_id,
        phone_e164: access.profile.phone_e164,
        address: access.profile.address,
      },
      documentDate: ctx.documentDate,
      issuedAt,
      workAddress: access.ticket.work_address!,
      ticketNumber: access.ticket.ticket_number,
      preview,
      seal: await sealOn(client, access),
    },
    await fontOn(ctx),
  );
}

interface Persisted {
  org_id: string;
  ticket_id: string;
  vendor_profile_id: string;
  status: "issued" | "voided";
  voided_at: string | null;
  void_reason: string | null;
  reissued_from: string | null;
  issued_at: string;
  pdf_sha256: string;
  snapshot: {
    document: VendorDocument;
    documentDate: string;
    issuedAt: string;
  };
}

async function persistedOn(client: Client, id: string) {
  const row = await maybe<Persisted>(
    client,
    `SELECT d.org_id::text, d.ticket_id::text, d.vendor_profile_id::text,
            d.status, d.voided_at::text, d.void_reason, d.reissued_from::text,
            d.issued_at::text, d.pdf_sha256, p.snapshot
       FROM vendor_documents d
       JOIN vendor_document_pdf_bytes p ON p.document_id = d.id AND p.org_id = d.org_id
      WHERE d.id = $1`,
    [id],
  );
  if (!row) notFound();
  return row;
}

/** Historical access is bound to the persisted document's org, ticket and issuer. */
async function authorizeDocument(
  client: Client,
  actor: VendorDocumentActor,
  document: Persisted,
) {
  const access = await authorize(
    client,
    actor,
    document.ticket_id,
    document.vendor_profile_id,
    "issued_document",
  );
  if (access.orgId !== document.org_id) notFound();
  return access;
}

function resultOf(row: Persisted): StoredVendorDocument {
  const document = {
    ...row.snapshot.document,
    status: row.status,
    voided_at: row.voided_at,
    void_reason: row.void_reason,
    reissued_from: row.reissued_from,
  };
  return {
    document,
    documentDate: row.snapshot.documentDate,
    issuedAt: row.snapshot.issuedAt,
    sha256: row.pdf_sha256,
    bytesReference: {
      table: "vendor_document_pdf_bytes",
      documentId: document.id,
    },
  };
}

/** Manager confirms the buyer; the returned token grants document scope only. */
export async function createVendorDocumentInvite(
  session: Session,
  ticketId: string,
  vendorProfileId: string,
  selection: VendorBuyerSelection,
) {
  return svc(session.userId, async (client) => {
    const access = await authorize(client, session, ticketId, vendorProfileId);
    if (access.ticket.status !== "closed") throw new Error("ticket_not_closed");
    await buyerOn(client, access, selection);
    const job = await maybe<{ id: string }>(
      client,
      `SELECT id::text FROM repair_vendor_jobs
        WHERE ticket_id = $1 AND org_id = $2
          AND active AND revoked_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      [ticketId, session.orgId],
    );
    if (!job) notFound();
    // Replacing this issuer's invitation must not revoke another issuer's
    // independent capability to read or correct its historical documents.
    await client.query(
      `UPDATE vendor_document_grants SET revoked_at = clock_timestamp()
        WHERE ticket_id = $1 AND org_id = $2 AND vendor_profile_id = $3
          AND revoked_at IS NULL`,
      [ticketId, session.orgId, vendorProfileId],
    );
    const token = newVendorToken();
    const grant = await one<{ id: string }>(
      client,
      `INSERT INTO vendor_document_grants
         (org_id,ticket_id,job_id,vendor_profile_id,token_hash,buyer_selection,
          expires_at,created_by)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,clock_timestamp() + interval '14 days',$7)
       RETURNING id::text`,
      [
        session.orgId,
        ticketId,
        job.id,
        vendorProfileId,
        hashVendorToken(token),
        JSON.stringify(selection),
        session.userId,
      ],
    );
    await writeAudit(
      session.orgId,
      session.userId,
      "vendor_document_invite",
      { grantId: grant.id, ticketId, profileId: vendorProfileId },
      client,
    );
    return { grantId: grant.id, url: `/v/documents/${token}` };
  });
}

export async function revokeVendorDocumentInvite(session: Session, grantId: string) {
  return svc(session.userId, async (client) => {
    await authorizeVendorStaff(client, session);
    const grant = await maybe<Grant>(
      client,
      `SELECT id::text,org_id::text,ticket_id::text,job_id::text,
              vendor_profile_id::text,buyer_selection
         FROM vendor_document_grants WHERE id = $1 AND org_id = $2`,
      [grantId, session.orgId],
    );
    if (!grant) notFound();
    await lockTicketThenJobs(client, grant.org_id, grant.ticket_id);
    await client.query(
      `UPDATE vendor_document_grants
          SET revoked_at = COALESCE(revoked_at,clock_timestamp())
        WHERE id = $1`,
      [grant.id],
    );
    await writeAudit(
      session.orgId,
      session.userId,
      "vendor_document_invite_revoke",
      { grantId },
      client,
    );
  });
}

/** Record the staff request without changing the vendor's document or bytes. */
export async function requestVendorDocumentCorrection(
  session: Session,
  id: string,
  reason: string,
) {
  if (typeof reason !== "string" || !reason.trim()) {
    throw new Error("missing_correction_reason");
  }
  return svc(session.userId, async (client) => {
    await authorizeVendorStaff(client, session);
    const initial = await persistedOn(client, id);
    if (initial.org_id !== session.orgId) notFound();
    const access = await authorizeDocument(client, session, initial);
    const current = resultOf(await persistedOn(client, id));
    if (current.document.status !== "issued") throw new Error("document_not_issued");
    await writeAudit(
      access.orgId,
      session.userId,
      "vendor_document_correction_request",
      {
        documentId: id,
        ticketId: initial.ticket_id,
        profileId: initial.vendor_profile_id,
        reason: reason.trim(),
      },
      client,
    );
    return { documentId: id, status: "requested" as const };
  });
}

export async function previewVendorDocument(ctx: VendorDocumentContext) {
  return svc(typeof ctx.actor === "string" ? null : ctx.actor.userId, async (client) => {
    const access = await authorize(client, ctx.actor, ctx.ticketId, ctx.vendorProfileId);
    const input = await issueInput(client, access, ctx, "preview", 1);
    const checked = applyIssueRules(input);
    const document = { ...checked, doc_no: "", seq: 0 };
    const time = await one<{ issued_at: string }>(
      client,
      `SELECT clock_timestamp()::text AS issued_at`,
    );
    const pdf = await renderOn(client, access, ctx, document, time.issued_at, true);
    return { document, bytes: pdf.bytes, sha256: pdf.sha256 };
  });
}

async function issueOn(
  client: Client,
  ctx: VendorDocumentContext,
  key: string,
  sourceId?: string,
): Promise<StoredVendorDocument> {
  requireVendorToken(ctx.actor);
  validKey(key);
  // Reissue corrects an existing issuer's document. Only fresh issuance
  // derives authority from the ticket's current assignment.
  const access = sourceId
    ? await authorizeDocument(client, ctx.actor, await persistedOn(client, sourceId))
    : await authorize(client, ctx.actor, ctx.ticketId, ctx.vendorProfileId);
  if (access.ticket.id !== ctx.ticketId || access.profile.id !== ctx.vendorProfileId) {
    notFound();
  }

  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [`vendor-document:${access.orgId}:${key}`],
  );
  const existing = await maybe<{
    id: string;
    ticket_id: string;
    vendor_profile_id: string;
    reissued_from: string | null;
  }>(
    client,
    `SELECT id::text,ticket_id::text,vendor_profile_id::text,reissued_from::text
       FROM vendor_documents WHERE org_id = $1 AND idempotency_key = $2`,
    [access.orgId, key],
  );
  if (existing) {
    if (
      existing.ticket_id !== ctx.ticketId ||
      existing.vendor_profile_id !== ctx.vendorProfileId ||
      existing.reissued_from !== (sourceId ?? null)
    ) {
      throw new Error("idempotency_key_conflict");
    }
    return resultOf(await persistedOn(client, existing.id));
  }

  const active = await maybe<{ id: string }>(
    client,
    `SELECT id::text FROM vendor_documents
      WHERE org_id = $1 AND ticket_id = $2 AND vendor_profile_id = $3
        AND status = 'issued'`,
    [access.orgId, ctx.ticketId, ctx.vendorProfileId],
  );
  if (active) throw new Error("document_already_issued");

  let source: VendorDocument | undefined;
  if (sourceId) {
    const prior = await persistedOn(client, sourceId);
    if (
      prior.org_id !== access.orgId ||
      prior.ticket_id !== ctx.ticketId ||
      prior.vendor_profile_id !== ctx.vendorProfileId
    ) {
      notFound();
    }
    source = resultOf(prior).document;
    if (source.status !== "voided") throw new Error("invalid_reissue_source");
    const replacement = await maybe<{ id: string }>(
      client,
      `SELECT id::text FROM vendor_documents WHERE reissued_from = $1`,
      [sourceId],
    );
    if (replacement) throw new Error("document_already_reissued");
  } else {
    const prior = await maybe<{ id: string }>(
      client,
      `SELECT id::text FROM vendor_documents
        WHERE org_id = $1 AND ticket_id = $2 AND vendor_profile_id = $3`,
      [access.orgId, ctx.ticketId, ctx.vendorProfileId],
    );
    if (prior) throw new Error("reissue_required");
  }

  const id = globalThis.crypto.randomUUID();
  const checked = applyIssueRules(await issueInput(client, access, ctx, id, 1));
  // Business receipts allocate from the private validated tax-ID issuer across
  // profiles and organizations. Individual numbering is per company and bound
  // to vendor_profiles.id: no cross-org identity or phone continuity across
  // profiles. Cross-org 統編 linkage for individuals is post-11/9 backlog.
  const allocation = await one<{ seq: string; issued_at: string }>(
    client,
    `SELECT app.next_vendor_document_seq($1, $2)::text AS seq,
            clock_timestamp()::text AS issued_at`,
    [access.profile.id, checked.kind],
  );
  const seq = Number(allocation.seq);
  const input = await issueInput(client, access, ctx, id, seq);
  const document = source ? applyReissueRules(source, input) : applyIssueRules(input);
  const pdf = await renderOn(client, access, ctx, document, allocation.issued_at, false);
  const version = await one<{ id: string }>(
    client,
    `SELECT id::text FROM vendor_profile_versions
      WHERE org_id = $1 AND vendor_profile_id = $2 AND version = $3`,
    [access.orgId, access.profile.id, access.profile.current_version],
  );
  await client.query(
    `INSERT INTO vendor_documents
       (id,org_id,vendor_profile_id,vendor_profile_version_id,ticket_id,
        kind,seq,doc_no,buyer,items,total_minor,issued_at,pdf_sha256,
        reissued_from,idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15)`,
    [
      id,
      access.orgId,
      access.profile.id,
      version.id,
      ctx.ticketId,
      document.kind,
      document.seq,
      document.doc_no,
      JSON.stringify(document.buyer),
      JSON.stringify(document.items),
      document.total_minor,
      allocation.issued_at,
      pdf.sha256,
      sourceId ?? null,
      key,
    ],
  );
  await client.query(
    `INSERT INTO vendor_document_pdf_bytes (document_id,org_id,bytes,snapshot)
     VALUES ($1,$2,$3,$4::jsonb)`,
    [
      id,
      access.orgId,
      Buffer.from(pdf.bytes),
      JSON.stringify({
        document,
        documentDate: ctx.documentDate,
        issuedAt: allocation.issued_at,
        issuer: {
          display_name: access.profile.display_name,
          business_name: access.profile.business_name,
          representative_name: access.profile.representative_name,
          tax_id: access.profile.tax_id,
          phone_e164: access.profile.phone_e164,
          address: access.profile.address,
        },
        sealFileId: access.profile.seal_file_id,
        profileVersionId: version.id,
        workAddress: access.ticket.work_address,
        ticketNumber: access.ticket.ticket_number,
      }),
    ],
  );
  await writeAudit(
    access.orgId,
    access.userId,
    sourceId ? "vendor_document_reissue" : "vendor_document_issue",
    {
      documentId: id,
      ticketId: ctx.ticketId,
      grantId: access.grantId,
      actorKind: "document_token",
      reissuedFrom: sourceId ?? null,
      sha256: pdf.sha256,
    },
    client,
  );
  return resultOf(await persistedOn(client, id));
}

export async function issueVendorDocument(
  ctx: VendorDocumentContext,
  options: { idempotencyKey: string },
) {
  requireVendorToken(ctx.actor);
  return svc(null, (client) => issueOn(client, ctx, options.idempotencyKey));
}

export async function voidVendorDocument(
  actor: VendorDocumentActor,
  id: string,
  reason: string,
) {
  requireVendorToken(actor);
  return svc(null, async (client) => {
    const initial = await persistedOn(client, id);
    const access = await authorizeDocument(client, actor, initial);
    const current = resultOf(await persistedOn(client, id));
    const clock = await one<{ now: string }>(
      client,
      `SELECT clock_timestamp()::text AS now`,
    );
    const document = applyVoidRules(current.document, reason, clock.now);
    await client.query(
      `UPDATE vendor_documents
          SET status = 'voided',voided_at = $2,void_reason = $3
        WHERE id = $1 AND org_id = $4 AND status = 'issued'`,
      [id, document.voided_at, document.void_reason, access.orgId],
    );
    await writeAudit(
      access.orgId,
      access.userId,
      "vendor_document_void",
      {
        documentId: id,
        grantId: access.grantId,
        actorKind: "document_token",
        reason: document.void_reason,
      },
      client,
    );
    return { ...current, document };
  });
}

export async function reissueVendorDocument(
  ctx: VendorDocumentContext,
  sourceId: string,
  options: { idempotencyKey: string },
) {
  requireVendorToken(ctx.actor);
  return svc(null, (client) => issueOn(client, ctx, options.idempotencyKey, sourceId));
}

export async function readVendorDocumentPdf(actor: VendorDocumentActor, id: string) {
  return svc(typeof actor === "string" ? null : actor.userId, async (client) => {
    const initial = await persistedOn(client, id);
    const access = await authorizeDocument(client, actor, initial);
    const row = await one<{ bytes: Buffer }>(
      client,
      `SELECT bytes FROM vendor_document_pdf_bytes
        WHERE document_id = $1 AND org_id = $2`,
      [id, access.orgId],
    );
    const stored = resultOf(await persistedOn(client, id));
    if ((await sha256(row.bytes)) !== stored.sha256) {
      throw new Error("vendor_document_integrity_failure");
    }
    return { ...stored, bytes: new Uint8Array(row.bytes) };
  });
}

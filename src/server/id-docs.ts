import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { makeT, isLocale } from "@/i18n";
import { idWatermarkText, taipeiViewStamp } from "@/lib/id-watermark";
import {
  DEFAULT_RETENTION_DAYS,
  PRIVATE_BUCKET,
  SAMPLE_JPEG_BASE64,
  SIGNED_URL_TTL_SECONDS,
  isIdDocType,
  isIdSlot,
  isValidIdNumber,
  maskIdNumber,
  requiredSlots,
  type IdCheckView,
  type IdDocType,
  type IdReviewStatus,
  type IdSlot,
} from "@/lib/idv";
import { acceptIdJpeg, acceptIdPng, sniffIdImage, stripJpegMetadata } from "@/lib/jpeg-size";
import { ID_NOTICE_PATH, ID_NOTICE_SHA256, fullNoticeSha256Subtle, resolveFirmContact, uploadPageSha256Subtle } from "@/lib/id-notice";
import { writeAudit } from "./audit";
import { maybe, svc, tx, withDeferredClient } from "./db";
import { FlowError, logServerError } from "./errors";
import { copySlotCiphertext, writeCiphertext, writeUploadSlot } from "./id-bytes";
import {
  ENCRYPTION_KEY_REF,
  acceptUploadBytes,
  decryptBytes,
  encryptBytes,
  hashIdNumber,
  hashIdNumberSubtle,
  readPhotoToken,
  sha256Hex,
  sha256HexBytes,
  signPhotoToken,
} from "./id-crypto";
import { allowIdUpload } from "./id-upload-guard";
import { assertStaff, type Session } from "./types";

const SAMPLE_JPEG = Buffer.from(SAMPLE_JPEG_BASE64, "base64");

export function canReviewId(session: Session) {
  return session.kind === "staff" && (session.role === "admin" || session.role === "manager");
}

/** Shown to the staff member after a view. The audit row stores ids, not this sentence. */
export function staffViewAuditReason(tenantName: string) {
  return `查看租客 ${tenantName} 的身分證件照片`;
}

type CheckRow = {
  lease_id: string;
  contact_id: string;
  tenant_name: string;
  firm_name: string;
  document_id: string | null;
  review_status: IdReviewStatus | null;
  doc_type: IdDocType | null;
  number_masked: string | null;
  uploaded_at: string | null;
  return_reason: string | null;
  is_sample: boolean | null;
  slots: string[] | null;
};

function asCheck(row: CheckRow): IdCheckView {
  const status = row.review_status ?? "missing";
  const slots = (row.slots ?? []).filter((slot): slot is IdSlot => slot === "front" || slot === "back" || slot === "selfie");
  return {
    documentId: row.document_id,
    status,
    docType: row.doc_type,
    numberMasked: row.number_masked,
    uploadedAt: row.uploaded_at,
    returnReason: row.return_reason,
    isSample: Boolean(row.is_sample),
    ready: status === "pending_review" || status === "checked",
    retentionDays: DEFAULT_RETENTION_DAYS,
    tenantName: row.tenant_name,
    firmName: row.firm_name,
    leaseId: row.lease_id,
    contactId: row.contact_id,
    slots,
  };
}

const CHECK_SQL = `SELECT l.id::text AS lease_id, c.id::text AS contact_id, c.display_name AS tenant_name,
            o.name AS firm_name,
            d.id::text AS document_id, d.review_status::text AS review_status, d.doc_type::text AS doc_type,
            d.number_masked, d.created_at::text AS uploaded_at, d.return_reason, d.is_sample,
            (SELECT coalesce(array_agg(p.slot ORDER BY p.slot), '{}')
               FROM identity_document_photos p WHERE p.document_id = d.id) AS slots
       FROM leases l
       JOIN organizations o ON o.id = l.org_id
       JOIN lease_parties lp ON lp.lease_id = l.id AND lp.role = 'primary'
       JOIN contacts c ON c.id = lp.contact_id
       LEFT JOIN identity_documents d
         ON d.contact_id = c.id AND d.deleted_at IS NULL AND (d.lease_id = l.id OR d.lease_id IS NULL)
      WHERE l.id = $1
      ORDER BY (d.lease_id IS NOT DISTINCT FROM l.id) DESC, d.created_at DESC NULLS LAST
      LIMIT 1`;

export async function loadFirmNoticeContact(session: Session) {
  // The tenant role cannot read the billing owner's profile. service_role
  // returns the same phone and email that submit hashes into the consent row.
  return svc(session.userId, (client) => firmNoticeContact(client, session.orgId));
}

async function firmNoticeContact(client: Client, orgId: string) {
  const row = await maybe<{
    name: string;
    contact_phone: string | null;
    contact_email: string | null;
    billing_phone: string | null;
    billing_email: string | null;
  }>(
    client,
    `SELECT o.name,
            o.contact_phone,
            o.contact_email::text AS contact_email,
            p.phone_e164 AS billing_phone,
            p.email::text AS billing_email
       FROM organizations o
       LEFT JOIN org_members m ON m.org_id = o.id AND m.is_billing_owner AND m.status = 'active'
       LEFT JOIN profiles p ON p.id = m.user_id
      WHERE o.id = $1`,
    [orgId],
  );
  return {
    name: row?.name ?? "",
    contact: resolveFirmContact({
      orgPhone: row?.contact_phone,
      orgEmail: row?.contact_email,
      billingPhone: row?.billing_phone,
      billingEmail: row?.billing_email,
    }),
  };
}

export async function loadLeaseIdCheck(session: Session, leaseId: string) {
  return tx(session.userId, async (client) => {
    const row = await maybe<CheckRow>(client, CHECK_SQL, [leaseId]);
    return row ? asCheck(row) : null;
  });
}

/**
 * A lease can be signed only after the ID photo and the selfie are stored.
 * A card also needs the back. A passport needs the photo page and the selfie.
 * TODO(LIFF): a check collected before the lease exists has a null lease_id and still counts.
 */
export async function leaseIdentityReady(client: Client, leaseId: string) {
  const row = await maybe<{ ok: boolean }>(
    client,
    `SELECT EXISTS (
       SELECT 1
         FROM identity_documents d
         JOIN lease_parties lp ON lp.contact_id = d.contact_id AND lp.lease_id = $1 AND lp.role = 'primary'
        WHERE d.deleted_at IS NULL
          AND d.review_status IN ('pending_review', 'checked')
          AND (d.lease_id = $1 OR d.lease_id IS NULL)
          AND EXISTS (SELECT 1 FROM identity_document_photos p WHERE p.document_id = d.id AND p.slot = 'front')
          AND EXISTS (SELECT 1 FROM identity_document_photos p WHERE p.document_id = d.id AND p.slot = 'selfie')
          AND (
            d.doc_type = 'passport'
            OR EXISTS (SELECT 1 FROM identity_document_photos p WHERE p.document_id = d.id AND p.slot = 'back')
          )
     ) AS ok`,
    [leaseId],
  );
  return Boolean(row?.ok);
}

export async function saveIdCheck(
  client: Client,
  input: {
    orgId: string;
    contactId: string;
    leaseId: string | null;
    createdBy: string;
    docType: IdDocType;
    number: string;
    photos: { slot: IdSlot; bytes: Buffer; mime: string }[];
    isSample?: boolean;
    noticeSha?: string | null;
    fullTextSha?: string | null;
    uploadTextSha?: string | null;
  },
) {
  try {
    return await insertIdCheck(client, input);
  } catch (error) {
    if (!(error instanceof FlowError)) logServerError("saveIdCheck", error);
    throw error;
  }
}

async function insertIdCheck(
  client: Client,
  input: {
    orgId: string;
    contactId: string;
    leaseId: string | null;
    createdBy: string;
    docType: IdDocType;
    number: string;
    photos: { slot: IdSlot; mime: string; bytes: Buffer }[];
    isSample?: boolean;
    noticeSha?: string | null;
    fullTextSha?: string | null;
    uploadTextSha?: string | null;
  },
) {
  const needed = requiredSlots(input.docType);
  const got = new Set(input.photos.map((photo) => photo.slot));
  if (needed.some((slot) => !got.has(slot)) || input.photos.some((photo) => !needed.includes(photo.slot))) {
    throw new FlowError("errors.idPhoto");
  }
  const masked = maskIdNumber(input.number);
  const digest = hashIdNumber(input.number, input.orgId);
  const existing = await maybe<{ id: string; review_status: IdReviewStatus }>(
    client,
    `SELECT id::text, review_status::text
       FROM identity_documents
      WHERE org_id = $1 AND contact_id = $2
        AND lease_id IS NOT DISTINCT FROM $3::uuid
        AND deleted_at IS NULL
      FOR UPDATE`,
    [input.orgId, input.contactId, input.leaseId],
  );
  if (existing && (existing.review_status === "pending_review" || existing.review_status === "checked")) {
    throw new FlowError("errors.idLocked");
  }
  const documentId = existing?.id ?? randomUUID();
  const frontPath = `${input.orgId}/${documentId}/front`;
  if (!existing) {
    await client.query(
      `INSERT INTO identity_documents (
         id, org_id, contact_id, lease_id, doc_type, number_masked, number_hash,
         storage_bucket, storage_path, encryption_key_ref, sha256_ciphertext,
         review_status, is_sample, consent_accepted_at, consent_notice_sha256,
         consent_full_text_sha256, consent_upload_text_sha256,
         consent_notice_sha, consented_at, created_by
       ) VALUES (
         $1,$2,$3,$4,$5::id_doc_type,$6,$7,$8,$9,$10,'pending','pending_review',$11,now(),$12,$13,$14,$12,
         CASE WHEN $12::text IS NULL THEN NULL ELSE now() END,$15
       )`,
      [
        documentId,
        input.orgId,
        input.contactId,
        input.leaseId,
        input.docType,
        masked,
        digest,
        PRIVATE_BUCKET,
        frontPath,
        ENCRYPTION_KEY_REF,
        Boolean(input.isSample),
        input.noticeSha ?? null,
        input.fullTextSha ?? null,
        input.uploadTextSha ?? null,
        input.createdBy,
      ],
    );
  } else {
    await client.query(`DELETE FROM identity_document_photos WHERE document_id = $1`, [documentId]);
    await client.query(
      `UPDATE identity_documents
          SET doc_type = $2::id_doc_type, number_masked = $3, number_hash = $4, storage_path = $5,
              review_status = 'pending_review', return_reason = NULL, reviewed_by = NULL, reviewed_at = NULL,
              is_sample = $6, consent_accepted_at = now(), consent_notice_sha256 = $7,
              consent_full_text_sha256 = $8, consent_upload_text_sha256 = $9,
              consent_notice_sha = $7,
              consented_at = CASE WHEN $7::text IS NULL THEN NULL ELSE now() END,
              created_by = $10
        WHERE id = $1`,
      [
        documentId,
        input.docType,
        masked,
        digest,
        frontPath,
        Boolean(input.isSample),
        input.noticeSha ?? null,
        input.fullTextSha ?? null,
        input.uploadTextSha ?? null,
        input.createdBy,
      ],
    );
  }
  let frontSha = "pending";
  for (const photo of input.photos) {
    let plain: Buffer;
    let mime: "image/jpeg" | "image/png";
    if (photo.mime === "image/jpeg") {
      if (sniffIdImage(photo.bytes) !== "jpeg") throw new FlowError("errors.idPhotoType");
      const stripped = stripJpegMetadata(photo.bytes);
      if (!stripped || !acceptIdJpeg(stripped)) throw new FlowError("errors.idPhoto");
      plain = Buffer.from(stripped);
      mime = "image/jpeg";
    } else if (photo.mime === "image/png") {
      if (sniffIdImage(photo.bytes) !== "png") throw new FlowError("errors.idPhotoType");
      if (!acceptIdPng(photo.bytes)) throw new FlowError("errors.idPhoto");
      plain = Buffer.from(photo.bytes);
      mime = "image/png";
    } else {
      throw new FlowError("errors.idPhotoType");
    }
    const path = `${input.orgId}/${documentId}/${photo.slot}`;
    const ciphertext = await encryptBytes(plain, { orgId: input.orgId, documentId, slot: photo.slot });
    const sha = sha256Hex(ciphertext);
    if (photo.slot === "front") frontSha = sha;
    await client.query(
      `INSERT INTO identity_document_photos (
         org_id, document_id, slot, storage_bucket, storage_path, mime_type, size_bytes, sha256
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [input.orgId, documentId, photo.slot, PRIVATE_BUCKET, path, mime, plain.length, sha],
    );
    await writeCiphertext(client, {
      bucket: PRIVATE_BUCKET,
      path,
      mime,
      sha256: sha,
      ciphertext,
    });
  }
  await client.query(`UPDATE identity_documents SET sha256_ciphertext = $2 WHERE id = $1`, [documentId, frontSha]);
  return documentId;
}

async function shownNotice(firm: { name: string; contact: string }) {
  const vars = { firmName: firm.name, firmContact: firm.contact, fullNoticeUrl: ID_NOTICE_PATH };
  return {
    noticeSha: ID_NOTICE_SHA256,
    fullTextSha: await fullNoticeSha256Subtle(vars),
    uploadTextSha: await uploadPageSha256Subtle(vars),
  };
}

export async function submitTenantId(
  session: Session,
  input: { leaseId: string; docType: string; number: string; consent: boolean; photos: Record<string, { mime: string; bytes: Buffer }> },
) {
  if (session.kind !== "tenant") throw new FlowError("errors.forbidden");
  if (!input.consent) throw new FlowError("errors.consentRequired");
  const docType = input.docType;
  if (!isIdDocType(docType) || !isValidIdNumber(docType, input.number)) throw new FlowError("errors.idNumber");
  const slots = requiredSlots(docType);
  if (Object.keys(input.photos).some((slot) => !isIdSlot(slot) || !slots.includes(slot))) {
    throw new FlowError("errors.idPhoto");
  }
  const photos = slots.map((slot) => {
    const photo = input.photos[slot];
    if (!photo) throw new FlowError("errors.idPhoto");
    return { slot, mime: photo.mime, bytes: photo.bytes };
  });
  await svc(session.userId, async (client) => {
    const party = await maybe<{ contact_id: string; org_id: string }>(
      client,
      `SELECT c.id::text AS contact_id, l.org_id::text
         FROM leases l
         JOIN lease_parties lp ON lp.lease_id = l.id AND lp.role = 'primary'
         JOIN contacts c ON c.id = lp.contact_id
        WHERE l.id = $1 AND c.user_id = $2`,
      [input.leaseId, session.userId],
    );
    if (!party) throw new FlowError("errors.notFound");
    const firm = await firmNoticeContact(client, party.org_id);
    const notice = await shownNotice(firm);
    const documentId = await saveIdCheck(client, {
      orgId: party.org_id,
      contactId: party.contact_id,
      leaseId: input.leaseId,
      createdBy: session.userId,
      docType,
      number: input.number,
      photos,
      isSample: false,
      ...notice,
    });
    await client.query(
      `INSERT INTO identity_document_access_log (org_id, document_id, accessed_by, purpose)
       VALUES ($1,$2,$3,'submit')`,
      [party.org_id, documentId, session.userId],
    );
    await client.query(
      `INSERT INTO audit_log (org_id, actor_user_id, actor_role, table_name, row_id, action, event_type, new_row)
       VALUES ($1,$2,'app','identity_documents',$3,'insert','id_document_submitted',$4::jsonb)`,
      [party.org_id, session.userId, documentId, JSON.stringify({ documentId, leaseId: input.leaseId, docType, ...notice })],
    );
  });
}

type LiveIdRow = { id: string; review_status: IdReviewStatus };

async function liveIdDocument(client: Client, orgId: string, contactId: string, leaseId: string) {
  return maybe<LiveIdRow>(
    client,
    `SELECT id::text, review_status::text
       FROM identity_documents
      WHERE org_id = $1 AND contact_id = $2
        AND lease_id IS NOT DISTINCT FROM $3::uuid
        AND deleted_at IS NULL
      FOR UPDATE`,
    [orgId, contactId, leaseId],
  );
}

function idLocked(status: IdReviewStatus | undefined) {
  return status === "pending_review" || status === "checked";
}

/**
 * Encrypt one photo and stage it. A locked document is left untouched so a retry
 * after a committed submit does not write a second row.
 */
export async function storeIdPhoto(
  session: Session,
  input: { leaseId: string; slot: string; mime: string; bytes: Uint8Array },
) {
  if (session.kind !== "tenant") throw new FlowError("errors.forbidden");
  if (!isIdSlot(input.slot)) throw new FlowError("errors.idPhoto");
  const prepared = acceptUploadBytes(input.bytes, input.mime);
  if (!prepared) {
    const declared = input.mime.split(";")[0]?.trim().toLowerCase() ?? "";
    const sniffed = sniffIdImage(input.bytes);
    const jpegLabel = declared === "image/jpeg" || declared === "image/jpg";
    const typeMismatch =
      (!jpegLabel && declared !== "image/png") ||
      !sniffed ||
      (sniffed === "jpeg" && !jpegLabel) ||
      (sniffed === "png" && declared !== "image/png");
    throw new FlowError(typeMismatch ? "errors.idPhotoType" : "errors.idPhoto");
  }
  await svc(session.userId, async (client) => {
    const party = await maybe<{ contact_id: string; org_id: string }>(
      client,
      `SELECT c.id::text AS contact_id, l.org_id::text
         FROM leases l
         JOIN lease_parties lp ON lp.lease_id = l.id AND lp.role = 'primary'
         JOIN contacts c ON c.id = lp.contact_id
        WHERE l.id = $1 AND c.user_id = $2`,
      [input.leaseId, session.userId],
    );
    if (!party) throw new FlowError("errors.notFound");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [`${session.userId}:${input.leaseId}`]);
    const existing = await liveIdDocument(client, party.org_id, party.contact_id, input.leaseId);
    if (idLocked(existing?.review_status)) return;
    let documentId = existing?.id;
    if (documentId) {
      await client.query(`DELETE FROM id_upload_slots WHERE user_id = $1::uuid AND lease_id = $2::uuid AND document_id <> $3::uuid`, [
        session.userId,
        input.leaseId,
        documentId,
      ]);
    } else {
      const staged = await maybe<{ document_id: string }>(
        client,
        `SELECT document_id::text FROM id_upload_slots WHERE user_id = $1::uuid AND lease_id = $2::uuid LIMIT 1`,
        [session.userId, input.leaseId],
      );
      documentId = staged?.document_id ?? randomUUID();
    }
    const ciphertext = await encryptBytes(prepared.bytes, { orgId: party.org_id, documentId, slot: input.slot });
    const sha = await sha256HexBytes(ciphertext);
    await writeUploadSlot(client, {
      userId: session.userId,
      leaseId: input.leaseId,
      documentId,
      slot: input.slot,
      mime: prepared.mime,
      plainSize: prepared.bytes.length,
      sha256: sha,
      ciphertext,
    });
  });
}

/**
 * Drop staged ciphertext for this lease. Objects that already belong to a photo
 * row stay; those are the committed document. A second call deletes nothing.
 */
export async function abandonIdUpload(session: Session, leaseId: string) {
  if (session.kind !== "tenant") throw new FlowError("errors.forbidden");
  if (!leaseId) return;
  await svc(session.userId, async (client) => {
    await client.query(
      `DELETE FROM id_document_objects AS o
        WHERE NOT EXISTS (
          SELECT 1 FROM identity_document_photos AS p
           WHERE p.storage_bucket = o.bucket AND p.storage_path = o.path
        )
          AND EXISTS (
            SELECT 1
              FROM id_upload_slots AS s
              JOIN leases AS l ON l.id = s.lease_id
             WHERE s.user_id = $1::uuid
               AND s.lease_id = $2::uuid
               AND o.path = l.org_id::text || '/' || s.document_id::text || '/' || s.slot
          )`,
      [session.userId, leaseId],
    );
    await client.query(`DELETE FROM id_upload_slots WHERE user_id = $1::uuid AND lease_id = $2::uuid`, [
      session.userId,
      leaseId,
    ]);
  });
}

/** Copy staged photos onto one document row. A second call after success does not insert another. */
export async function finalizeTenantId(
  session: Session,
  input: { leaseId: string; docType: string; number: string; consent: boolean },
) {
  try {
    await commitTenantId(session, input);
  } catch (error) {
    logServerError("finalizeTenantId", error);
    if (session.kind === "tenant" && input.leaseId) {
      try {
        await abandonIdUpload(session, input.leaseId);
      } catch (cleanup) {
        logServerError("abandonIdUpload", cleanup);
      }
    }
    throw error;
  }
}

async function commitTenantId(
  session: Session,
  input: { leaseId: string; docType: string; number: string; consent: boolean },
) {
  if (session.kind !== "tenant") throw new FlowError("errors.forbidden");
  if (!allowIdUpload(session.userId)) throw new FlowError("errors.forbidden");
  if (!input.consent) throw new FlowError("errors.consentRequired");
  const docType = input.docType;
  if (!isIdDocType(docType) || !isValidIdNumber(docType, input.number)) throw new FlowError("errors.idNumber");
  const slots = requiredSlots(docType);
  await svc(session.userId, async (client) => {
    const party = await maybe<{ contact_id: string; org_id: string }>(
      client,
      `SELECT c.id::text AS contact_id, l.org_id::text
         FROM leases l
         JOIN lease_parties lp ON lp.lease_id = l.id AND lp.role = 'primary'
         JOIN contacts c ON c.id = lp.contact_id
        WHERE l.id = $1 AND c.user_id = $2`,
      [input.leaseId, session.userId],
    );
    if (!party) throw new FlowError("errors.notFound");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [`${session.userId}:${input.leaseId}`]);
    const existing = await liveIdDocument(client, party.org_id, party.contact_id, input.leaseId);
    if (idLocked(existing?.review_status)) {
      await client.query(`DELETE FROM id_upload_slots WHERE user_id = $1::uuid AND lease_id = $2::uuid`, [session.userId, input.leaseId]);
      return;
    }
    const staged = await client.query<{ slot: string; document_id: string; sha256: string }>(
      `SELECT slot, document_id::text, sha256
         FROM id_upload_slots
        WHERE user_id = $1::uuid AND lease_id = $2::uuid AND slot = ANY($3::text[])`,
      [session.userId, input.leaseId, slots],
    );
    if (staged.rows.length !== slots.length) throw new FlowError("errors.idPhoto");
    const documentIds = new Set(staged.rows.map((row) => row.document_id));
    if (documentIds.size !== 1) throw new FlowError("errors.idPhoto");
    const documentId = staged.rows[0]?.document_id ?? "";
    if (existing && existing.id !== documentId) throw new FlowError("errors.idPhoto");
    const firm = await firmNoticeContact(client, party.org_id);
    const notice = await shownNotice(firm);
    const masked = maskIdNumber(input.number);
    const digest = await hashIdNumberSubtle(input.number, party.org_id);
    const frontPath = `${party.org_id}/${documentId}/front`;
    const frontSha = staged.rows.find((row) => row.slot === "front")?.sha256 ?? "pending";
    if (!existing) {
      await client.query(
        `INSERT INTO identity_documents (
           id, org_id, contact_id, lease_id, doc_type, number_masked, number_hash,
           storage_bucket, storage_path, encryption_key_ref, sha256_ciphertext,
           review_status, is_sample, consent_accepted_at, consent_notice_sha256,
           consent_full_text_sha256, consent_upload_text_sha256,
           consent_notice_sha, consented_at, created_by
         ) VALUES (
           $1,$2,$3,$4,$5::id_doc_type,$6,$7,$8,$9,$10,$11,'pending_review',false,now(),$12,$13,$14,$12,now(),$15
         )`,
        [
          documentId,
          party.org_id,
          party.contact_id,
          input.leaseId,
          docType,
          masked,
          digest,
          PRIVATE_BUCKET,
          frontPath,
          ENCRYPTION_KEY_REF,
          frontSha,
          notice.noticeSha,
          notice.fullTextSha,
          notice.uploadTextSha,
          session.userId,
        ],
      );
    } else {
      await client.query(`DELETE FROM identity_document_photos WHERE document_id = $1`, [documentId]);
      await client.query(
        `UPDATE identity_documents
            SET doc_type = $2::id_doc_type, number_masked = $3, number_hash = $4, storage_path = $5,
                encryption_key_ref = $6, sha256_ciphertext = $7,
                review_status = 'pending_review', return_reason = NULL, reviewed_by = NULL, reviewed_at = NULL,
                is_sample = false, consent_accepted_at = now(), consent_notice_sha256 = $8,
                consent_full_text_sha256 = $9, consent_upload_text_sha256 = $10,
                consent_notice_sha = $8, consented_at = now(), created_by = $11
          WHERE id = $1`,
        [
          documentId,
          docType,
          masked,
          digest,
          frontPath,
          ENCRYPTION_KEY_REF,
          frontSha,
          notice.noticeSha,
          notice.fullTextSha,
          notice.uploadTextSha,
          session.userId,
        ],
      );
    }
    await client.query(
      `INSERT INTO identity_document_photos (
         org_id, document_id, slot, storage_bucket, storage_path, mime_type, size_bytes, sha256
       )
       SELECT $1::uuid, $2::uuid, slot, $3, $1::text || '/' || $2::text || '/' || slot, mime_type, plain_size, sha256
         FROM id_upload_slots
        WHERE user_id = $4::uuid AND lease_id = $5::uuid AND document_id = $2::uuid AND slot = ANY($6::text[])`,
      [party.org_id, documentId, PRIVATE_BUCKET, session.userId, input.leaseId, slots],
    );
    for (const slot of slots) {
      await copySlotCiphertext(client, {
        bucket: PRIVATE_BUCKET,
        userId: session.userId,
        leaseId: input.leaseId,
        orgId: party.org_id,
        documentId,
        slot,
      });
    }
    await client.query(`DELETE FROM id_upload_slots WHERE user_id = $1::uuid AND lease_id = $2::uuid`, [session.userId, input.leaseId]);
    await client.query(
      `INSERT INTO identity_document_access_log (org_id, document_id, accessed_by, purpose)
       VALUES ($1,$2,$3,'submit')`,
      [party.org_id, documentId, session.userId],
    );
    await client.query(
      `INSERT INTO audit_log (org_id, actor_user_id, actor_role, table_name, row_id, action, event_type, new_row)
       VALUES ($1,$2,'app','identity_documents',$3,'insert','id_document_submitted',$4::jsonb)`,
      [party.org_id, session.userId, documentId, JSON.stringify({ documentId, leaseId: input.leaseId, docType, ...notice })],
    );
  });
}

async function notifyTenant(
  client: Client,
  input: { orgId: string; leaseId: string; documentId: string; actorId: string; event: string; body: string },
) {
  const contact = await maybe<{ id: string; user_id: string | null; locale: string }>(
    client,
    `SELECT c.id::text, c.user_id::text, c.locale
       FROM lease_parties lp
       JOIN contacts c ON c.id = lp.contact_id
      WHERE lp.lease_id = $1 AND lp.role = 'primary'
      LIMIT 1`,
    [input.leaseId],
  );
  if (!contact) return;
  const member = await maybe<{ id: string }>(
    client,
    `SELECT id::text FROM org_members WHERE org_id = $1 AND user_id = $2 AND status = 'active'`,
    [input.orgId, input.actorId],
  );
  const lease = await maybe<{ property_id: string; thread_id: string | null }>(
    client,
    `SELECT l.property_id::text,
            (SELECT t.id::text FROM message_threads t WHERE t.lease_id = l.id AND t.kind = 'lease' LIMIT 1) AS thread_id
       FROM leases l WHERE l.id = $1`,
    [input.leaseId],
  );
  let threadId = lease?.thread_id ?? null;
  if (!threadId && lease) {
    const thread = await maybe<{ id: string }>(
      client,
      `INSERT INTO message_threads (org_id, kind, lease_id, property_id) VALUES ($1,'lease',$2,$3) RETURNING id::text`,
      [input.orgId, input.leaseId, lease.property_id],
    );
    threadId = thread?.id ?? null;
    if (threadId) {
      await client.query(`INSERT INTO thread_participants (org_id, thread_id, contact_id) VALUES ($1,$2,$3)`, [
        input.orgId,
        threadId,
        contact.id,
      ]);
      if (member) {
        await client.query(`INSERT INTO thread_participants (org_id, thread_id, member_id) VALUES ($1,$2,$3)`, [
          input.orgId,
          threadId,
          member.id,
        ]);
      }
    }
  }
  if (threadId && member) {
    await client.query(
      `INSERT INTO messages (org_id, thread_id, sender_user_id, sender_member_id, body, inbound_channel)
       VALUES ($1,$2,$3,$4,$5,'in_app')`,
      [input.orgId, threadId, input.actorId, member.id, input.body],
    );
  }
  const locale = isLocale(contact.locale) ? contact.locale : "zh-TW";
  const dedupe = `${input.event}:${input.documentId}:${randomUUID()}`;
  const notice = await maybe<{ id: string }>(
    client,
    `INSERT INTO notifications (
       org_id, event_type, template_key, recipient_contact_id, recipient_user_id, lease_id, locale, payload, dedupe_key, status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,'queued')
     RETURNING id::text`,
    [
      input.orgId,
      input.event,
      `idv.${input.event}`,
      contact.id,
      contact.user_id,
      input.leaseId,
      locale,
      JSON.stringify({ documentId: input.documentId }),
      dedupe,
    ],
  );
  if (!notice) return;
  await client.query(
    `INSERT INTO deliveries (org_id, notification_id, channel, recipient_contact_id, recipient_user_id, status, provider, counts_toward_quota, error, sent_at)
     VALUES ($1,$2,'line',$3,$4,'skipped',NULL,false,'line_not_connected',NULL)`,
    [input.orgId, notice.id, contact.id, contact.user_id],
  );
}

export async function reviewIdCheck(session: Session, documentId: string, action: "checked" | "returned", reason?: string) {
  assertStaff(session, ["admin", "manager"]);
  const note = reason?.trim() ?? "";
  if (action === "returned" && !note) throw new FlowError("errors.required");
  const reviewed = await svc(session.userId, async (client) => {
    const doc = await maybe<{ id: string; org_id: string; contact_id: string; lease_id: string | null; locale: string }>(
      client,
      `SELECT d.id::text, d.org_id::text, d.contact_id::text, d.lease_id::text, c.locale
         FROM identity_documents d
         JOIN contacts c ON c.id = d.contact_id
        WHERE d.id = $1 AND d.org_id = $2 AND d.deleted_at IS NULL`,
      [documentId, session.orgId],
    );
    if (!doc?.lease_id) throw new FlowError("errors.notFound");
    if (action === "checked") {
      await client.query(
        `UPDATE identity_documents
            SET review_status = 'checked', reviewed_by = $2, reviewed_at = now(), return_reason = NULL
          WHERE id = $1`,
        [documentId, session.userId],
      );
    } else {
      await client.query(
        `UPDATE identity_documents
            SET review_status = 'returned', return_reason = $3, reviewed_by = $2, reviewed_at = now()
          WHERE id = $1`,
        [documentId, session.userId, note],
      );
    }
    const t = makeT(isLocale(doc.locale) ? doc.locale : "zh-TW");
    const body = action === "checked" ? t("idv_ten_ok") : t("idv_ten_returned", { r: note });
    await notifyTenant(client, {
      orgId: doc.org_id,
      leaseId: doc.lease_id,
      documentId,
      actorId: session.userId,
      event: action === "checked" ? "id_document_checked" : "id_document_returned",
      body,
    });
    return doc;
  });
  await writeAudit(session.orgId, session.userId, action === "checked" ? "id_document_checked" : "id_document_returned", {
    documentId,
    contactId: reviewed.contact_id,
  });
}

function assertPhotoViewer(session: Session) {
  if (session.kind === "owner" || session.role === "accountant" || session.role === "maintenance") {
    throw new FlowError("errors.forbidden");
  }
  if (session.kind === "staff" && !canReviewId(session)) throw new FlowError("errors.forbidden");
  if (session.kind !== "staff" && session.kind !== "tenant") throw new FlowError("errors.forbidden");
}

type PhotoCaller = {
  tokenHash: string | null;
  userId: string | null;
  preferredOrg: string | null;
  env: string | null;
};

type GateRow = {
  user_id: string;
  viewer_name: string;
  email: string;
  firm_name: string;
  tenant_name: string;
  contact_id: string;
  org_id: string;
  document_id: string;
  kind: string;
  encryption_key_ref: string;
  slots: string[] | null;
};

export type PhotoTiming = { db: number; decrypt: number; watermark: number; total: number };

export type ServedPhoto = { mime: string; bytes: Buffer; firmName: string; timing: PhotoTiming };

function photoBytes(value: Buffer | string) {
  if (Buffer.isBuffer(value)) return value;
  if (value.startsWith("\\x")) return Buffer.from(value.slice(2), "hex");
  return Buffer.from(value);
}

/**
 * One `id_photo_gate` call. The access log and audit row are one statement
 * after the response. The connecting role is the database owner; the function
 * is SECURITY DEFINER and is not granted to anon or authenticated.
 */
async function issuePhotoUrlsForCaller(caller: PhotoCaller, documentId: string) {
  const exp = Date.now() + SIGNED_URL_TTL_SECONDS * 1000;
  const row = await withDeferredClient(async (client, defer) => {
    const found = await maybe<GateRow>(
      client,
      `SELECT user_id::text, viewer_name, email, firm_name, tenant_name,
              contact_id::text, org_id::text, document_id::text, kind,
              encryption_key_ref, slots
         FROM id_photo_gate($1::text, $2::uuid, $3::uuid, $4::text, $5::text)`,
      [caller.tokenHash, caller.userId, documentId, caller.preferredOrg, caller.env],
    );
    if (!found || (found.kind !== "staff" && found.kind !== "tenant")) return null;
    const purpose = found.kind === "staff" ? "staff_view" : "self_view";
    defer(`SELECT id_photo_record($1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz, $6, $7::uuid)`, [
      found.org_id,
      found.document_id,
      found.user_id,
      purpose,
      new Date(exp).toISOString(),
      null,
      found.contact_id,
    ]);
    return found;
  });
  if (!row) throw new FlowError("errors.forbidden");
  const watermark = idWatermarkText(row.firm_name, row.viewer_name, taipeiViewStamp());
  const logged = row.kind === "staff" ? staffViewAuditReason(row.tenant_name) : "租客查看自己的身分證件照片";
  const shots = (row.slots ?? [])
    .filter((slot): slot is IdSlot => slot === "front" || slot === "back" || slot === "selfie")
    .map((slot) => ({
      slot,
      url: `/api/id-documents/photo?token=${encodeURIComponent(
        signPhotoToken({ documentId: row.document_id, slot, userId: row.user_id, exp }),
      )}`,
      watermark,
    }));
  return { shots, watermark, logged };
}

export async function issuePhotoUrls(session: Session, documentId: string) {
  assertPhotoViewer(session);
  return issuePhotoUrlsForCaller(
    {
      tokenHash: null,
      userId: session.userId,
      preferredOrg: session.liveOrgId,
      env: session.environment,
    },
    documentId,
  );
}

/** Cookie session, one gate query. Used by the view-photos action. */
export async function issuePhotoUrlsForToken(caller: PhotoCaller, documentId: string) {
  return issuePhotoUrlsForCaller(caller, documentId);
}

/**
 * One `id_photo_open` call returns the ciphertext. Decrypt and the watermark
 * string run after that. The download audit is deferred. `db` includes connect.
 * `total` runs until this function returns; on Workers the audit is outside it.
 */
export async function serveSignedPhoto(input: PhotoCaller & { documentId: string; slot: string }): Promise<ServedPhoto | null> {
  const started = performance.now();
  let db = 0;
  const opened = await withDeferredClient(async (client, defer) => {
    const result = await client.query<{
      user_id: string;
      viewer_name: string;
      firm_name: string;
      contact_id: string;
      org_id: string;
      mime_type: string;
      encryption_key_ref: string;
      total_bytes: number;
      seq: number;
      chunk: Buffer | string;
    }>(
      `SELECT user_id::text, viewer_name, firm_name, contact_id::text, org_id::text,
              mime_type, encryption_key_ref, total_bytes, seq, chunk
         FROM id_photo_open($1::text, $2::uuid, $3::uuid, $4::text, $5::text, $6::text)
        ORDER BY seq`,
      [input.tokenHash, input.userId, input.documentId, input.slot, input.preferredOrg, input.env],
    );
    db = performance.now() - started;
    const first = result.rows[0];
    if (!first) return null;
    const ciphertext = Buffer.concat(result.rows.map((row) => photoBytes(row.chunk)));
    if (ciphertext.length !== Number(first.total_bytes)) return null;
    const decryptStarted = performance.now();
    const bytes = await decryptBytes(
      ciphertext,
      { orgId: first.org_id, documentId: input.documentId, slot: input.slot },
      first.encryption_key_ref,
    );
    const decrypt = performance.now() - decryptStarted;
    const watermarkStarted = performance.now();
    idWatermarkText(first.firm_name, first.viewer_name, taipeiViewStamp());
    const watermark = performance.now() - watermarkStarted;
    defer(`SELECT id_photo_record($1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz, $6, $7::uuid)`, [
      first.org_id,
      input.documentId,
      first.user_id,
      "download",
      null,
      input.slot,
      first.contact_id,
    ]);
    return {
      mime: first.mime_type,
      bytes,
      firmName: first.firm_name,
      timing: { db, decrypt, watermark, total: 0 },
    };
  });
  if (!opened) return null;
  opened.timing.total = performance.now() - started;
  return opened;
}

export async function openSignedPhoto(session: Session, token: string) {
  const parsed = readPhotoToken(token);
  if (!parsed || parsed.u !== session.userId) throw new FlowError("errors.forbidden");
  assertPhotoViewer(session);
  const opened = await serveSignedPhoto({
    tokenHash: null,
    userId: session.userId,
    documentId: parsed.d,
    slot: parsed.s,
    preferredOrg: session.liveOrgId,
    env: session.environment,
  });
  if (!opened) throw new FlowError("errors.forbidden");
  return opened;
}

export async function attachSampleId(actorId: string, leaseId: string) {
  await svc(actorId, async (client) => {
    const party = await maybe<{ org_id: string; contact_id: string; user_id: string | null }>(
      client,
      `SELECT l.org_id::text, c.id::text AS contact_id, c.user_id::text
         FROM leases l
         JOIN lease_parties lp ON lp.lease_id = l.id AND lp.role = 'primary'
         JOIN contacts c ON c.id = lp.contact_id
         JOIN org_members m ON m.org_id = l.org_id AND m.user_id = $2 AND m.status = 'active'
        WHERE l.id = $1
          AND m.role IN ('admin', 'manager')`,
      [leaseId, actorId],
    );
    if (!party) throw new FlowError("errors.notFound");
    const ready = await leaseIdentityReady(client, leaseId);
    if (ready) return;
    const photo = { bytes: SAMPLE_JPEG, mime: "image/jpeg" };
    await saveIdCheck(client, {
      orgId: party.org_id,
      contactId: party.contact_id,
      leaseId,
      createdBy: party.user_id ?? actorId,
      docType: "tw_national_id",
      number: "A000000901",
      isSample: true,
      photos: [
        { slot: "front", ...photo },
        { slot: "back", ...photo },
        { slot: "selfie", ...photo },
      ],
    });
  });
}

export async function seedSampleCheck(
  client: Client,
  input: { orgId: string; contactId: string; leaseId: string; createdBy: string },
) {
  const photo = { bytes: SAMPLE_JPEG, mime: "image/jpeg" };
  return saveIdCheck(client, {
    orgId: input.orgId,
    contactId: input.contactId,
    leaseId: input.leaseId,
    createdBy: input.createdBy,
    docType: "tw_national_id",
    number: "A000000001",
    isSample: true,
    photos: [
      { slot: "front", ...photo },
      { slot: "back", ...photo },
      { slot: "selfie", ...photo },
    ],
  });
}

/**
 * Deletes live ID ciphertext once delete_after has passed (lease end + 90 days,
 * or upload date + 90 days when the lease never took effect) and upload slots
 * older than 24 hours. Supabase backups are outside this job; they must age
 * out within 14 days. See docs/STAGING.md.
 */
export async function purgeDueIdDocuments(limit = 500) {
  return svc(null, async (client) => {
    await client.query(`DELETE FROM id_upload_slots WHERE created_at < now() - interval '24 hours'`);
    const purged = await client.query<{ document_id: string; storage_bucket: string; storage_path: string }>(
      `SELECT document_id::text, storage_bucket, storage_path FROM purge_due_identity_documents($1)`,
      [limit],
    );
    const rows = purged.rows;
    if (rows.length > 0) {
      const ids = [...new Set(rows.map((row) => row.document_id))];
      await client.query(
        `DELETE FROM id_document_objects AS o
          WHERE (o.bucket, o.path) IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
        [rows.map((row) => row.storage_bucket), rows.map((row) => row.storage_path)],
      );
      await client.query(`DELETE FROM identity_document_photos WHERE document_id = ANY($1::uuid[])`, [ids]);
    }
    return new Set(rows.map((row) => row.document_id)).size;
  });
}

/** Keep calling the locked batch until a short batch comes back, or the cap is hit. */
export async function purgeDueIdDocumentsUntilDone(limit = 500, maxBatches = 40) {
  let removed = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const n = await purgeDueIdDocuments(limit);
    removed += n;
    if (n < limit) break;
  }
  return removed;
}

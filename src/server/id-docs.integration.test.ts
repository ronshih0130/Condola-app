import "./load-local-env";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { encode as encodeJpeg } from "jpeg-js";
import { SAMPLE_JPEG_BASE64 } from "../lib/idv";
import { fullNoticeSha256, ID_NOTICE_PATH, ID_NOTICE_SHA256, resolveFirmContact, uploadPageSha256 } from "../lib/id-notice";
import { embedIdWatermarkMark, MAX_PHOTO_BYTES } from "../lib/jpeg-size";
import { FlowError } from "./errors";
import { copySlotCiphertext, readCiphertext, writeUploadSlot } from "./id-bytes";
import { ENCRYPTION_KEY_REF, decryptBytes, hashIdNumber } from "./id-crypto";
import { attachSampleId, finalizeTenantId, issuePhotoUrls, openSignedPhoto, purgeDueIdDocuments, reviewIdCheck, saveIdCheck, staffViewAuditReason, storeIdPhoto, submitTenantId } from "./id-docs";
import { query, svc, tx, withClient } from "./db";
import { ORG_ID, USERS } from "./ids";
import { resetAndSeed } from "./seed";
import type { Session } from "./types";

const photo = () => ({ bytes: Buffer.from(SAMPLE_JPEG_BASE64, "base64"), mime: "image/jpeg" });

function markedPhoto() {
  const marked = embedIdWatermarkMark(Buffer.from(SAMPLE_JPEG_BASE64, "base64"));
  if (!marked) throw new Error("sample jpeg has no room for a watermark mark");
  return { mime: "image/jpeg", bytes: Buffer.from(marked) };
}

function session(userId: string, role: Session["role"], kind: Session["kind"] = "staff"): Session {
  return {
    userId,
    sessionId: "test",
    email: "test@songxin.demo",
    name: role === "manager" ? "黃志明" : "林雅婷",
    kind,
    role,
    orgId: ORG_ID,
    liveOrgId: ORG_ID,
    environment: "live",
    locale: "zh-TW",
    calendar: "gregorian",
    leaseId: null,
  };
}

test.before(async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const databaseUrl = process.env.DATABASE_URL ?? "postgres://condola:condola@127.0.0.1:5432/condola";
  for (const file of [
    "20261029130000_id_no_direct_mutate.sql",
    "20261029140000_id_consent_shown_version.sql",
    "20261029150000_id_watermark_copy.sql",
    "20261029160000_lease_close_end_date.sql",
  ]) {
    execFileSync("psql", [databaseUrl, "-v", "ON_ERROR_STOP=1", "-f", path.join(root, "supabase/migrations", file)], {
      stdio: "pipe",
    });
  }
  await resetAndSeed();
});

test("identity photos stay private, masked, audited, and are purged only after the clock", async () => {
  const zhang = await query<{ id: string; number_masked: string; number_hash: string; is_sample: boolean }>(
    `SELECT d.id::text, d.number_masked, d.number_hash, d.is_sample
       FROM identity_documents d
       JOIN contacts c ON c.id = d.contact_id
      WHERE c.user_id = $1 AND d.org_id = $2 AND d.deleted_at IS NULL`,
    [USERS.tenant, ORG_ID],
  );
  assert.equal(zhang.rows.length, 1);
  assert.equal(zhang.rows[0].number_masked, "A******001");
  assert.equal(zhang.rows[0].is_sample, true);
  assert.equal(zhang.rows[0].number_hash, hashIdNumber("A000000001", ORG_ID));
  assert.equal(zhang.rows[0].number_masked.includes("000000001"), false);

  const visible = async (userId: string) => {
    const rows = await tx(userId, (client) => client.query(`SELECT id FROM identity_documents`));
    return rows.rows.length;
  };
  assert.ok((await visible(USERS.admin)) >= 1);
  assert.ok((await visible(USERS.manager)) >= 1);
  assert.equal(await visible(USERS.accountant), 0);
  assert.equal(await visible(USERS.maintenance), 0);
  assert.equal(await visible(USERS.owner), 0);
  const tenantSeesOwn = await tx(USERS.tenant, (client) => client.query(`SELECT number_masked FROM identity_documents`));
  assert.equal(tenantSeesOwn.rows.length, 1);
  const photosHidden = await tx(USERS.accountant, (client) => client.query(`SELECT id FROM identity_document_photos`));
  assert.equal(photosHidden.rows.length, 0);
  await assert.rejects(
    () => tx(USERS.admin, (client) => client.query(`SELECT path FROM id_document_objects`)),
    (error: unknown) => error instanceof FlowError && error.key === "errors.forbidden",
  );
  const objectsStored = await svc(null, (client) => client.query<{ n: string }>(`SELECT count(*)::text AS n FROM id_document_objects`));
  assert.ok(Number(objectsStored.rows[0].n) >= 3);

  const party = await query<{ contact_id: string; lease_id: string; org_id: string }>(
    `SELECT c.id::text AS contact_id, l.id::text AS lease_id, l.org_id::text
       FROM contacts c
       JOIN lease_parties lp ON lp.contact_id = c.id AND lp.role = 'primary'
       JOIN leases l ON l.id = lp.lease_id
      WHERE c.user_id = $1 AND l.org_id = $2`,
    [USERS.tenant2, ORG_ID],
  );
  const wang = party.rows[0];
  assert.ok(wang);
  await assert.rejects(
    () =>
      tx(USERS.tenant2, (client) =>
        client.query(
          `INSERT INTO identity_documents (
             org_id, contact_id, lease_id, doc_type, number_masked, number_hash,
             storage_path, encryption_key_ref, review_status, reviewed_by, reviewed_at, is_sample, created_by
           ) VALUES ($1,$2,$3,'tw_national_id','A******789','hash',$4,'env:test','checked',$5,now(),false,$5)`,
          [wang.org_id, wang.contact_id, wang.lease_id, `${wang.org_id}/blocked/front`, USERS.tenant2],
        ),
      ),
    (error: unknown) => error instanceof FlowError && error.key === "errors.forbidden",
  );

  await assert.rejects(
    () =>
      query(
        `INSERT INTO identity_documents (
           org_id, contact_id, doc_type, number_masked, storage_path, encryption_key_ref, created_by
         ) VALUES ($1,$2,'tw_national_id','A123456789',$3,'env:test',$4)`,
        [ORG_ID, wang.contact_id, `${ORG_ID}/plain/front`, USERS.admin],
      ),
    (error: unknown) => error instanceof Error && /masked/i.test(error.message),
  );
  await assert.rejects(
    () =>
      query(
        `INSERT INTO identity_documents (
           org_id, contact_id, doc_type, number_masked, storage_path, encryption_key_ref, created_by
         ) VALUES ($1,$2,'passport','AB***CD7',$3,'env:test',$4)`,
        [ORG_ID, wang.contact_id, `${ORG_ID}/wide/front`, USERS.admin],
      ),
    (error: unknown) => error instanceof Error && /masked/i.test(error.message),
  );
  await assert.rejects(
    () =>
      query(
        `INSERT INTO identity_documents (
           org_id, contact_id, doc_type, number_masked, storage_path, encryption_key_ref, created_by
         ) VALUES ($1,$2,'passport','A**1234',$3,'env:test',$4)`,
        [ORG_ID, wang.contact_id, `${ORG_ID}/tail/front`, USERS.admin],
      ),
    (error: unknown) => error instanceof Error && /masked/i.test(error.message),
  );

  await assert.rejects(
    () =>
      query(
        `INSERT INTO export_jobs (org_id, requested_by, include_identity_documents) VALUES ($1,$2,true)`,
        [ORG_ID, USERS.admin],
      ),
    (error: unknown) => error instanceof Error && /include_identity_documents|identity/i.test(error.message),
  );

  const issued = await issuePhotoUrls(session(USERS.manager, "manager"), zhang.rows[0].id);
  const reason = staffViewAuditReason("張雅文");
  assert.equal(reason, "查看租客 張雅文 的身分證件照片");
  assert.equal(issued.logged, reason);
  assert.equal(issued.shots.length, 3);
  const audit = await query<{ reason: string; new_row: { contactId?: string; tenant?: string } }>(
    `SELECT reason, new_row FROM audit_log WHERE event_type = 'id_document_view' AND row_id = $1`,
    [zhang.rows[0].id],
  );
  assert.ok(audit.rows.length >= 1);
  assert.ok(audit.rows.every((row) => row.reason === "staff_view" && !row.new_row.tenant && !JSON.stringify(row.new_row).includes("張")));
  assert.ok(audit.rows.some((row) => Boolean(row.new_row.contactId)));
  await issuePhotoUrls(session(USERS.tenant, null, "tenant"), zhang.rows[0].id);
  await assert.rejects(
    () => issuePhotoUrls(session(USERS.tenant2, null, "tenant"), zhang.rows[0].id),
    (error: unknown) => error instanceof FlowError && error.key === "errors.forbidden",
  );
  const access = await query<{ purpose: string }>(
    `SELECT purpose FROM identity_document_access_log WHERE document_id = $1`,
    [zhang.rows[0].id],
  );
  assert.ok(access.rows.some((row) => row.purpose === "staff_view"));

  const documentId = await svc(USERS.admin, (client) =>
    saveIdCheck(client, {
      orgId: wang.org_id,
      contactId: wang.contact_id,
      leaseId: wang.lease_id,
      createdBy: USERS.tenant2,
      docType: "tw_national_id",
      number: "A123456789",
      photos: [
        { slot: "front", ...photo() },
        { slot: "back", ...photo() },
        { slot: "selfie", ...photo() },
      ],
    }),
  );
  const manager = session(USERS.manager, "manager");
  await reviewIdCheck(manager, documentId, "returned", "反光看不清");
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  await assert.rejects(
    () =>
      submitTenantId(
        { ...session(USERS.tenant2, "manager"), kind: "tenant", name: "王小美" },
        {
          leaseId: wang.lease_id,
          docType: "tw_national_id",
          number: "A123456789",
          consent: true,
          photos: {
            front: { mime: "image/jpeg", bytes: gif },
            back: { mime: "image/jpeg", bytes: gif },
            selfie: { mime: "image/jpeg", bytes: gif },
          },
        },
      ),
    (error: unknown) => error instanceof FlowError && error.key === "errors.idPhotoType",
  );
  const tenant = { ...session(USERS.tenant2, "manager"), kind: "tenant" as const, name: "王小美" };
  await assert.rejects(
    () =>
      finalizeTenantId(tenant, {
        leaseId: wang.lease_id,
        docType: "tw_national_id",
        number: "A123456789",
        consent: true,
      }),
    (error: unknown) => error instanceof FlowError && error.key === "errors.idPhoto",
  );
  const stillReturned = await query<{ review_status: string }>(
    `SELECT review_status::text FROM identity_documents WHERE id = $1`,
    [documentId],
  );
  assert.equal(stillReturned.rows[0]?.review_status, "returned");
  const marked = markedPhoto();
  for (const slot of ["front", "back", "selfie"] as const) {
    await storeIdPhoto(tenant, { leaseId: wang.lease_id, slot, ...marked });
  }
  await finalizeTenantId(tenant, {
    leaseId: wang.lease_id,
    docType: "tw_national_id",
    number: "A123456789",
    consent: true,
  });
  await finalizeTenantId(tenant, {
    leaseId: wang.lease_id,
    docType: "tw_national_id",
    number: "A123456789",
    consent: true,
  });
  const liveDocs = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM identity_documents WHERE lease_id = $1 AND deleted_at IS NULL`,
    [wang.lease_id],
  );
  assert.equal(liveDocs.rows[0]?.n, "1");
  const staged = await query<{ n: string }>(`SELECT count(*)::text AS n FROM id_upload_slots WHERE lease_id = $1`, [wang.lease_id]);
  assert.equal(staged.rows[0]?.n, "0");
  const storedObjects = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM id_document_objects WHERE path LIKE $1`,
    [`%/${documentId}/%`],
  );
  assert.equal(storedObjects.rows[0]?.n, "3");
  const submitted = await query<{ table_name: string; row_id: string }>(
    `SELECT table_name, row_id::text
       FROM audit_log
      WHERE event_type = 'id_document_submitted' AND row_id = $1`,
    [documentId],
  );
  assert.equal(submitted.rows[0]?.table_name, "identity_documents");
  assert.equal(submitted.rows[0]?.row_id, documentId);
  const submitLog = await query(
    `SELECT purpose FROM identity_document_access_log WHERE document_id = $1 AND purpose = 'submit'`,
    [documentId],
  );
  assert.equal(submitLog.rows.length, 1);
  const opened = await issuePhotoUrls(manager, documentId);
  const token = new URL(opened.shots[0].url, "http://127.0.0.1").searchParams.get("token");
  assert.ok(token);
  await openSignedPhoto(manager, token);
  const downloaded = await query<{ table_name: string }>(
    `SELECT table_name FROM audit_log WHERE event_type = 'id_document_download' AND row_id = $1`,
    [documentId],
  );
  assert.equal(downloaded.rows[0]?.table_name, "identity_documents");
  const downloadLog = await query(
    `SELECT purpose FROM identity_document_access_log WHERE document_id = $1 AND purpose = 'download'`,
    [documentId],
  );
  assert.equal(downloadLog.rows.length, 1);
  await reviewIdCheck(manager, documentId, "checked");

  const firm = await query<{
    name: string;
    contact_phone: string | null;
    contact_email: string | null;
    billing_phone: string | null;
    billing_email: string | null;
  }>(
    `SELECT o.name,
            o.contact_phone,
            o.contact_email::text AS contact_email,
            p.phone_e164 AS billing_phone,
            p.email::text AS billing_email
       FROM organizations o
       LEFT JOIN org_members m ON m.org_id = o.id AND m.is_billing_owner AND m.status = 'active'
       LEFT JOIN profiles p ON p.id = m.user_id
      WHERE o.id = $1`,
    [ORG_ID],
  );
  const noticeVars = {
    firmName: firm.rows[0].name,
    firmContact: resolveFirmContact({
      orgPhone: firm.rows[0].contact_phone,
      orgEmail: firm.rows[0].contact_email,
      billingPhone: firm.rows[0].billing_phone,
      billingEmail: firm.rows[0].billing_email,
    }),
    fullNoticeUrl: ID_NOTICE_PATH,
  };
  const stored = await query<{
    number_masked: string;
    review_status: string;
    consent_notice_sha256: string | null;
    consent_full_text_sha256: string | null;
    consent_upload_text_sha256: string | null;
    consent_notice_sha: string | null;
    consented_at: string | null;
  }>(
    `SELECT number_masked, review_status::text, consent_notice_sha256, consent_full_text_sha256,
            consent_upload_text_sha256, consent_notice_sha, consented_at::text
       FROM identity_documents WHERE id = $1`,
    [documentId],
  );
  assert.equal(stored.rows[0].number_masked, "A******789");
  assert.equal(stored.rows[0].review_status, "checked");
  assert.equal(stored.rows[0].consent_notice_sha256, ID_NOTICE_SHA256);
  assert.equal(stored.rows[0].consent_notice_sha, ID_NOTICE_SHA256);
  assert.match(stored.rows[0].consented_at ?? "", /^\d{4}-\d{2}-\d{2}/);
  assert.equal(stored.rows[0].consent_full_text_sha256, fullNoticeSha256(noticeVars));
  assert.equal(stored.rows[0].consent_upload_text_sha256, uploadPageSha256(noticeVars));
  const leaked = await query(
    `SELECT id FROM identity_documents WHERE number_masked = 'A123456789' OR number_hash = 'A123456789'`,
  );
  assert.equal(leaked.rows.length, 0);
  const notices = await query<{ event_type: string; payload: string; body: string | null; status: string; provider: string }>(
    `SELECT n.event_type, n.payload::text, m.body, d.status, d.provider
       FROM notifications n
       LEFT JOIN deliveries d ON d.notification_id = n.id
       LEFT JOIN messages m ON m.body IN (
         '管理公司已核對您的證件。',
         '管理公司請您重新上傳證件。原因：反光看不清'
       ) AND m.org_id = n.org_id
      WHERE n.lease_id = $1 AND n.event_type IN ('id_document_checked', 'id_document_returned')
      ORDER BY n.created_at`,
    [wang.lease_id],
  );
  const events = new Set(notices.rows.map((row) => row.event_type));
  assert.ok(events.has("id_document_returned"));
  assert.ok(events.has("id_document_checked"));
  assert.ok(notices.rows.every((row) => row.status === "skipped" && row.provider === null));
  const deliveryErrors = await query<{ error: string | null; sent_at: Date | null }>(
    `SELECT d.error, d.sent_at
       FROM deliveries d
       JOIN notifications n ON n.id = d.notification_id
      WHERE n.lease_id = $1 AND n.event_type IN ('id_document_checked', 'id_document_returned')`,
    [wang.lease_id],
  );
  assert.ok(deliveryErrors.rows.every((row) => row.error === "line_not_connected" && row.sent_at === null));
  assert.ok(notices.rows.every((row) => !row.payload.includes("A123456789")));
  const bodies = await query<{ body: string; inbound_channel: string }>(
    `SELECT body, inbound_channel::text FROM messages WHERE org_id = $1 AND body LIKE '管理公司%' ORDER BY created_at`,
    [ORG_ID],
  );
  assert.ok(bodies.rows.some((row) => row.body === "管理公司請您重新上傳證件。原因：反光看不清" && row.inbound_channel === "in_app"));
  assert.ok(bodies.rows.some((row) => row.body === "管理公司已核對您的證件。" && row.inbound_channel === "in_app"));

  const contactId = randomUUID();
  await query(
    `INSERT INTO contacts (id, org_id, is_tenant, display_name) VALUES ($1,$2,true,'無人租約')`,
    [contactId, ORG_ID],
  );
  const orphanId = await svc(USERS.admin, (client) =>
    saveIdCheck(client, {
      orgId: ORG_ID,
      contactId,
      leaseId: null,
      createdBy: USERS.admin,
      docType: "passport",
      number: "AB12CD7",
      photos: [
        { slot: "front", ...photo() },
        { slot: "selfie", ...photo() },
      ],
    }),
  );
  const seven = await query<{ number_masked: string; delete_after: string }>(
    `SELECT number_masked, delete_after::text FROM identity_documents WHERE id = $1`,
    [orphanId],
  );
  assert.equal(seven.rows[0].number_masked, "A****D7");
  const expectedOrphan = await query<{ due: string }>(
    `SELECT ((d.created_at AT TIME ZONE 'Asia/Taipei')::date + id_document_keep_days())::text AS due
       FROM identity_documents d
      WHERE d.id = $1`,
    [orphanId],
  );
  assert.equal(seven.rows[0].delete_after, expectedOrphan.rows[0].due);
  await query(`UPDATE identity_documents SET created_at = now() - interval '400 days' WHERE id = $1`, [orphanId]);
  await query(
    `UPDATE leases
        SET deposit_settled_at = now() - interval '400 days',
            start_date = current_date - 20,
            end_date = current_date - 10,
            terminated_on = NULL
      WHERE id = $1`,
    [wang.lease_id],
  );
  const recent = await query<{ delete_after: string }>(
    `SELECT delete_after::text FROM identity_documents WHERE id = $1`,
    [documentId],
  );
  const expectedRecent = await query<{ due: string }>(
    `SELECT (current_date - 10 + id_document_keep_days())::text AS due`,
  );
  assert.equal(recent.rows[0].delete_after, expectedRecent.rows[0].due);
  assert.equal(await purgeDueIdDocuments(), 0);
  const stillThere = await query<{ deleted_at: Date | null }>(
    `SELECT deleted_at FROM identity_documents WHERE id = $1 OR id = $2`,
    [documentId, orphanId],
  );
  assert.ok(stillThere.rows.every((row) => row.deleted_at === null));

  await query(
    `UPDATE leases
        SET status = 'ended',
            start_date = current_date - 800,
            end_date = current_date - 400,
            terminated_on = current_date - 400,
            deposit_settled_at = NULL
      WHERE id = $1`,
    [wang.lease_id],
  );
  const due = await query<{ delete_after: string }>(
    `SELECT delete_after::text FROM identity_documents WHERE id = $1`,
    [documentId],
  );
  const expectedDue = await query<{ due: string }>(
    `SELECT (current_date - 400 + id_document_keep_days())::text AS due`,
  );
  assert.equal(due.rows[0].delete_after, expectedDue.rows[0].due);
  const removed = await purgeDueIdDocuments();
  assert.ok(removed >= 1);
  const purged = await query<{ deleted_at: Date | null; storage_path: string }>(
    `SELECT deleted_at, storage_path FROM identity_documents WHERE id = $1`,
    [documentId],
  );
  assert.ok(purged.rows[0].deleted_at);
  assert.match(purged.rows[0].storage_path, /^purged\//);
  const shredded = await query(`SELECT path FROM id_document_objects WHERE path LIKE $1`, [`%/${documentId}/%`]);
  assert.equal(shredded.rows.length, 0);
  const orphan = await query<{ deleted_at: Date | null }>(
    `SELECT deleted_at FROM identity_documents WHERE id = $1`,
    [orphanId],
  );
  assert.equal(orphan.rows[0].deleted_at, null);

  const linked = await query<{ id: string }>(
    `INSERT INTO leases (
       org_id, property_id, unit_id, target_unit_id, target_room_id, status,
       start_date, end_date, currency, rent_amount_minor, deposit_amount_minor, created_by
     )
     SELECT org_id, property_id, unit_id, target_unit_id, target_room_id, 'ended',
            current_date - 40, current_date - 10, currency, rent_amount_minor, 0, $2
       FROM leases WHERE id = $1
     RETURNING id::text`,
    [wang.lease_id, USERS.admin],
  );
  await query(
    `INSERT INTO lease_parties (org_id, lease_id, contact_id, role) VALUES ($1,$2,$3,'primary')`,
    [ORG_ID, linked.rows[0].id, contactId],
  );
  const linkedDoc = await query<{ lease_id: string; delete_after: string }>(
    `SELECT lease_id::text, delete_after::text FROM identity_documents WHERE id = $1`,
    [orphanId],
  );
  const expectedLinked = await query<{ due: string }>(
    `SELECT (current_date - 10 + id_document_keep_days())::text AS due`,
  );
  assert.equal(linkedDoc.rows[0].lease_id, linked.rows[0].id);
  assert.equal(linkedDoc.rows[0].delete_after, expectedLinked.rows[0].due);
  assert.equal(await purgeDueIdDocuments(), 0);
  const stillKept = await query<{ deleted_at: Date | null }>(
    `SELECT deleted_at FROM identity_documents WHERE id = $1`,
    [orphanId],
  );
  assert.equal(stillKept.rows[0].deleted_at, null);
});

test("ciphertext is removed with the photo, the document, and the lease", async () => {
  const contactId = randomUUID();
  await query(`INSERT INTO contacts (id, org_id, is_tenant, display_name) VALUES ($1,$2,true,'級聯')`, [contactId, ORG_ID]);
  const documentId = await svc(USERS.admin, (client) =>
    saveIdCheck(client, {
      orgId: ORG_ID,
      contactId,
      leaseId: null,
      createdBy: USERS.admin,
      docType: "passport",
      number: "AB12CD78",
      photos: [
        { slot: "front", ...photo() },
        { slot: "selfie", ...photo() },
      ],
    }),
  );
  const paths = await query<{ path: string }>(
    `SELECT storage_path AS path FROM identity_document_photos WHERE document_id = $1 ORDER BY slot`,
    [documentId],
  );
  assert.equal(paths.rows.length, 2);
  await query(`DELETE FROM identity_document_photos WHERE document_id = $1 AND slot = 'selfie'`, [documentId]);
  const afterPhoto = await query(`SELECT path FROM id_document_objects WHERE path = $1`, [paths.rows.find((row) => row.path.endsWith("/selfie"))?.path]);
  assert.equal(afterPhoto.rows.length, 0);
  const frontLeft = await query(`SELECT path FROM id_document_objects WHERE path = $1`, [paths.rows.find((row) => row.path.endsWith("/front"))?.path]);
  assert.equal(frontLeft.rows.length, 1);
  await query(
    `INSERT INTO identity_document_access_log (org_id, document_id, accessed_by, purpose)
     VALUES ($1, $2, $3, 'download')`,
    [ORG_ID, documentId, USERS.manager],
  );
  await assert.rejects(
    () => query(`DELETE FROM identity_document_access_log WHERE document_id = $1`, [documentId]),
    /append-only/,
  );
  await query(`DELETE FROM identity_documents WHERE id = $1`, [documentId]);
  const logsAfterDoc = await query(`SELECT id FROM identity_document_access_log WHERE document_id = $1`, [documentId]);
  assert.equal(logsAfterDoc.rows.length, 0);
  const afterDoc = await query(`SELECT path FROM id_document_objects WHERE path LIKE $1`, [`%/${documentId}/%`]);
  assert.equal(afterDoc.rows.length, 0);

  const lease = await query<{ id: string }>(
    `INSERT INTO leases (
       org_id, property_id, unit_id, target_unit_id, target_room_id, status,
       start_date, end_date, currency, rent_amount_minor, deposit_amount_minor, created_by
     )
     SELECT org_id, property_id, unit_id, target_unit_id, target_room_id, 'ended',
            current_date - 2000, current_date - 1900, currency, rent_amount_minor, 0, $2
       FROM leases WHERE org_id = $1
      LIMIT 1
     RETURNING id::text`,
    [ORG_ID, USERS.admin],
  );
  const leasedContact = randomUUID();
  await query(`INSERT INTO contacts (id, org_id, is_tenant, display_name) VALUES ($1,$2,true,'級聯租約')`, [leasedContact, ORG_ID]);
  await query(`INSERT INTO lease_parties (org_id, lease_id, contact_id, role) VALUES ($1,$2,$3,'primary')`, [
    ORG_ID,
    lease.rows[0].id,
    leasedContact,
  ]);
  const leasedDoc = await svc(USERS.admin, (client) =>
    saveIdCheck(client, {
      orgId: ORG_ID,
      contactId: leasedContact,
      leaseId: lease.rows[0].id,
      createdBy: USERS.admin,
      docType: "passport",
      number: "CD12EF78",
      photos: [
        { slot: "front", ...photo() },
        { slot: "selfie", ...photo() },
      ],
    }),
  );
  await query(
    `INSERT INTO identity_document_access_log (org_id, document_id, accessed_by, purpose)
     VALUES ($1, $2, $3, 'download')`,
    [ORG_ID, leasedDoc, USERS.manager],
  );
  await query(`DELETE FROM leases WHERE id = $1`, [lease.rows[0].id]);
  const afterLease = await query(`SELECT id FROM identity_documents WHERE id = $1`, [leasedDoc]);
  assert.equal(afterLease.rows.length, 0);
  const logsAfterLease = await query(`SELECT id FROM identity_document_access_log WHERE document_id = $1`, [leasedDoc]);
  assert.equal(logsAfterLease.rows.length, 0);
  const leasedObjects = await query(`SELECT path FROM id_document_objects WHERE path LIKE $1`, [`%/${leasedDoc}/%`]);
  assert.equal(leasedObjects.rows.length, 0);
});

test("one statement can erase several identity documents, and a live access log stays append-only", async () => {
  const liveContact = randomUUID();
  await query(`INSERT INTO contacts (id, org_id, is_tenant, display_name) VALUES ($1,$2,true,'仍在日誌')`, [liveContact, ORG_ID]);
  const liveId = await svc(USERS.admin, (client) =>
    saveIdCheck(client, {
      orgId: ORG_ID,
      contactId: liveContact,
      leaseId: null,
      createdBy: USERS.admin,
      docType: "passport",
      number: "UV12WX78",
      photos: [
        { slot: "front", ...photo() },
        { slot: "selfie", ...photo() },
      ],
    }),
  );
  await query(
    `INSERT INTO identity_document_access_log (org_id, document_id, accessed_by, purpose) VALUES ($1,$2,$3,'download')`,
    [ORG_ID, liveId, USERS.manager],
  );
  await assert.rejects(
    () => query(`DELETE FROM identity_document_access_log WHERE document_id = $1`, [liveId]),
    /append-only/,
  );
  await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      await client.query("SAVEPOINT spoof_guc");
      await client.query(`SELECT set_config('app.allow_id_access_log_delete', $1, true)`, [liveId]);
      await assert.rejects(
        () => client.query(`DELETE FROM identity_document_access_log WHERE document_id = $1`, [liveId]),
        /append-only/,
      );
      await client.query("ROLLBACK TO SAVEPOINT spoof_guc");
      await client.query("SAVEPOINT spoof_role");
      await client.query("SET LOCAL ROLE service_role");
      await client.query(`SELECT set_config('app.allow_id_access_log_delete', $1, true)`, [liveId]);
      await assert.rejects(
        () => client.query(`DELETE FROM identity_document_access_log WHERE document_id = $1`, [liveId]),
        /append-only/,
      );
      await client.query("ROLLBACK TO SAVEPOINT spoof_role");
      const still = await client.query(`SELECT id FROM identity_document_access_log WHERE document_id = $1`, [liveId]);
      assert.equal(still.rows.length, 1);
    } finally {
      await client.query("ROLLBACK");
    }
  });
  const liveLog = await query(`SELECT id FROM identity_document_access_log WHERE document_id = $1`, [liveId]);
  assert.equal(liveLog.rows.length, 1);

  const make = async (number: string) => {
    const contactId = randomUUID();
    await query(`INSERT INTO contacts (id, org_id, is_tenant, display_name) VALUES ($1,$2,true,'批次')`, [contactId, ORG_ID]);
    const documentId = await svc(USERS.admin, (client) =>
      saveIdCheck(client, {
        orgId: ORG_ID,
        contactId,
        leaseId: null,
        createdBy: USERS.admin,
        docType: "passport",
        number,
        photos: [
          { slot: "front", ...photo() },
          { slot: "selfie", ...photo() },
        ],
      }),
    );
    await query(
      `INSERT INTO identity_document_access_log (org_id, document_id, accessed_by, purpose) VALUES ($1,$2,$3,'download')`,
      [ORG_ID, documentId, USERS.manager],
    );
    return documentId;
  };
  const batchA = await make("AA11BB22");
  const batchB = await make("CC33DD44");
  await query(`DELETE FROM identity_documents WHERE id IN ($1, $2)`, [batchA, batchB]);
  const batchLeft = await query(`SELECT id FROM identity_documents WHERE id IN ($1, $2)`, [batchA, batchB]);
  assert.equal(batchLeft.rows.length, 0);
  const batchLogs = await query(`SELECT id FROM identity_document_access_log WHERE document_id IN ($1, $2)`, [batchA, batchB]);
  assert.equal(batchLogs.rows.length, 0);

  const lease = await query<{ id: string }>(
    `INSERT INTO leases (
       org_id, property_id, unit_id, target_unit_id, target_room_id, status,
       start_date, end_date, currency, rent_amount_minor, deposit_amount_minor, created_by
     )
     SELECT org_id, property_id, unit_id, target_unit_id, target_room_id, 'ended',
            current_date - 3000, current_date - 2900, currency, rent_amount_minor, 0, $2
       FROM leases WHERE org_id = $1
      LIMIT 1
     RETURNING id::text`,
    [ORG_ID, USERS.admin],
  );
  const first = randomUUID();
  const second = randomUUID();
  await query(
    `INSERT INTO contacts (id, org_id, is_tenant, display_name) VALUES ($1,$3,true,'租約甲'), ($2,$3,true,'租約乙')`,
    [first, second, ORG_ID],
  );
  await query(
    `INSERT INTO lease_parties (org_id, lease_id, contact_id, role) VALUES ($1,$2,$3,'primary'), ($1,$2,$4,'co_tenant')`,
    [ORG_ID, lease.rows[0].id, first, second],
  );
  const saveOnLease = (contactId: string, number: string) =>
    svc(USERS.admin, (client) =>
      saveIdCheck(client, {
        orgId: ORG_ID,
        contactId,
        leaseId: lease.rows[0].id,
        createdBy: USERS.admin,
        docType: "passport",
        number,
        photos: [
          { slot: "front", ...photo() },
          { slot: "selfie", ...photo() },
        ],
      }),
    );
  const docA = await saveOnLease(first, "MN12OP78");
  const docB = await saveOnLease(second, "QR12ST78");
  await query(
    `INSERT INTO identity_document_access_log (org_id, document_id, accessed_by, purpose)
     VALUES ($1,$2,$4,'download'), ($1,$3,$4,'submit')`,
    [ORG_ID, docA, docB, USERS.manager],
  );
  await query(`DELETE FROM leases WHERE id = $1`, [lease.rows[0].id]);
  const docs = await query(`SELECT id FROM identity_documents WHERE id IN ($1, $2)`, [docA, docB]);
  assert.equal(docs.rows.length, 0);
  const logs = await query(`SELECT id FROM identity_document_access_log WHERE document_id IN ($1, $2)`, [docA, docB]);
  assert.equal(logs.rows.length, 0);
  const objects = await query(`SELECT path FROM id_document_objects WHERE path LIKE $1 OR path LIKE $2`, [`%/${docA}/%`, `%/${docB}/%`]);
  assert.equal(objects.rows.length, 0);
  const liveStill = await query(`SELECT id FROM identity_document_access_log WHERE document_id = $1`, [liveId]);
  assert.equal(liveStill.rows.length, 1);
});

test("a document with no move-out date becomes due from the upload date", async () => {
  const contactId = randomUUID();
  await query(`INSERT INTO contacts (id, org_id, is_tenant, display_name) VALUES ($1,$2,true,'無到期')`, [contactId, ORG_ID]);
  const documentId = await svc(USERS.admin, (client) =>
    saveIdCheck(client, {
      orgId: ORG_ID,
      contactId,
      leaseId: null,
      createdBy: USERS.admin,
      docType: "passport",
      number: "ZZ98YY76",
      photos: [
        { slot: "front", ...photo() },
        { slot: "selfie", ...photo() },
      ],
    }),
  );
  await query(`UPDATE identity_documents SET created_at = now() - interval '400 days' WHERE id = $1`, [documentId]);
  await query(`UPDATE identity_documents SET lease_id = NULL WHERE id = $1`, [documentId]);
  const due = await query<{ delete_after: string; expected: string }>(
    `SELECT d.delete_after::text,
            ((d.created_at AT TIME ZONE 'Asia/Taipei')::date + id_document_keep_days())::text AS expected
       FROM identity_documents d
      WHERE d.id = $1`,
    [documentId],
  );
  assert.equal(due.rows[0].delete_after, due.rows[0].expected);
  assert.ok(due.rows[0].delete_after < new Date().toISOString().slice(0, 10));
  const removed = await purgeDueIdDocuments();
  assert.ok(removed >= 1);
  const gone = await query<{ deleted_at: Date | null }>(`SELECT deleted_at FROM identity_documents WHERE id = $1`, [documentId]);
  assert.ok(gone.rows[0].deleted_at);
  const objects = await query(`SELECT path FROM id_document_objects WHERE path LIKE $1`, [`%/${documentId}/%`]);
  assert.equal(objects.rows.length, 0);
  const purgeLog = await query<{ accessed_by: string | null }>(
    `SELECT accessed_by::text FROM identity_document_access_log
      WHERE document_id = $1 AND purpose = 'retention_purge'`,
    [documentId],
  );
  assert.equal(purgeLog.rows.length, 1);
  assert.equal(purgeLog.rows[0].accessed_by, null);
  const purgeAudit = await query<{ actor_user_id: string | null; actor_role: string; event_type: string }>(
    `SELECT actor_user_id::text, actor_role, event_type
       FROM audit_log
      WHERE row_id = $1 AND event_type = 'id_document_purged'`,
    [documentId],
  );
  assert.equal(purgeAudit.rows.length, 1);
  assert.equal(purgeAudit.rows[0].actor_user_id, null);
  assert.equal(purgeAudit.rows[0].actor_role, "system");
  assert.equal(purgeAudit.rows[0].event_type, "id_document_purged");
});

test("clearing a formed lease end date waits, a later end date is kept, and duplicate live rows collapse to the newest", async () => {
  const base = await query<{ id: string }>(
    `INSERT INTO leases (
       org_id, property_id, unit_id, target_unit_id, target_room_id, status,
       start_date, end_date, currency, rent_amount_minor, deposit_amount_minor, created_by
     )
     SELECT org_id, property_id, unit_id, target_unit_id, target_room_id, 'active',
            current_date + 5000, current_date + 5030, currency, rent_amount_minor, 0, $2
       FROM leases WHERE org_id = $1
      LIMIT 1
     RETURNING id::text`,
    [ORG_ID, USERS.admin],
  );
  const contactId = randomUUID();
  await query(`INSERT INTO contacts (id, org_id, is_tenant, display_name) VALUES ($1,$2,true,'改期')`, [contactId, ORG_ID]);
  await query(`INSERT INTO lease_parties (org_id, lease_id, contact_id, role) VALUES ($1,$2,$3,'primary')`, [
    ORG_ID,
    base.rows[0].id,
    contactId,
  ]);
  const documentId = await svc(USERS.admin, (client) =>
    saveIdCheck(client, {
      orgId: ORG_ID,
      contactId,
      leaseId: base.rows[0].id,
      createdBy: USERS.admin,
      docType: "passport",
      number: "LM12NO78",
      photos: [
        { slot: "front", ...photo() },
        { slot: "selfie", ...photo() },
      ],
    }),
  );
  const scheduled = await query<{ delete_after: string }>(
    `SELECT delete_after::text FROM identity_documents WHERE id = $1`,
    [documentId],
  );
  const plusYear = await query<{ due: string }>(`SELECT (current_date + 5030 + id_document_keep_days())::text AS due`);
  assert.equal(scheduled.rows[0].delete_after, plusYear.rows[0].due);
  await query(`UPDATE leases SET end_date = NULL, terminated_on = NULL WHERE id = $1`, [base.rows[0].id]);
  const stillOpen = await query<{ delete_after: string }>(
    `SELECT delete_after::text FROM identity_documents WHERE id = $1`,
    [documentId],
  );
  assert.equal(stillOpen.rows[0].delete_after, "9999-12-31");
  await query(`UPDATE leases SET end_date = current_date + 5020 WHERE id = $1`, [base.rows[0].id]);
  const moved = await query<{ delete_after: string; expected: string }>(
    `SELECT d.delete_after::text,
            (current_date + 5020 + id_document_keep_days())::text AS expected
       FROM identity_documents d
      WHERE d.id = $1`,
    [documentId],
  );
  assert.equal(moved.rows[0].delete_after, moved.rows[0].expected);

  const masked = await query<{ long: string; short: string }>(
    `SELECT id_number_stored_mask('A123456789') AS long, id_number_stored_mask('AB12CD7') AS short`,
  );
  assert.equal(masked.rows[0].long, "A******789");
  assert.equal(masked.rows[0].short, "A****D7");

  await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      await client.query("DROP INDEX identity_documents_current_idx");
      const older = randomUUID();
      const newer = randomUUID();
      await client.query(
        `INSERT INTO identity_documents (
           id, org_id, contact_id, doc_type, number_masked, storage_path, encryption_key_ref, created_by, created_at
         ) VALUES
           ($1,$2,$3,'passport','A***CD7',$4,'env:ID_DOC_ENCRYPTION_KEY',$5, now() - interval '2 days'),
           ($6,$2,$3,'passport','A***CD7',$7,'env:ID_DOC_ENCRYPTION_KEY',$5, now())`,
        [older, ORG_ID, contactId, `${ORG_ID}/${older}/front`, USERS.admin, newer, `${ORG_ID}/${newer}/front`],
      );
      const removed = await client.query<{ n: number }>(`SELECT dedupe_live_identity_documents() AS n`);
      assert.ok(Number(removed.rows[0].n) >= 1);
      const live = await client.query<{ id: string }>(
        `SELECT id::text FROM identity_documents
          WHERE contact_id = $1 AND lease_id IS NULL AND deleted_at IS NULL`,
        [contactId],
      );
      assert.deepEqual(live.rows.map((row) => row.id), [newer]);
    } finally {
      await client.query("ROLLBACK");
    }
  });
});

function noisyJpeg(width: number, height: number) {
  const data = new Uint8Array(width * height * 4);
  let state = 0x12345678;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  for (let index = 0; index < data.length; index += 4) {
    const sample = next();
    data[index] = sample & 255;
    data[index + 1] = (sample >>> 8) & 255;
    data[index + 2] = (sample >>> 16) & 255;
    data[index + 3] = 255;
  }
  return Buffer.from(encodeJpeg({ data, width, height }, 90).data);
}

test("photos larger than a 64KiB Bind round-trip through the chunked bytea path", async () => {
  const medium = noisyJpeg(480, 360);
  const large = noisyJpeg(720, 540);
  assert.ok(medium.length > 64 * 1024);
  assert.ok(large.length > 64 * 1024);
  assert.ok(large.length <= MAX_PHOTO_BYTES);
  const contactId = randomUUID();
  await query(`INSERT INTO contacts (id, org_id, is_tenant, display_name) VALUES ($1,$2,true,'大圖')`, [contactId, ORG_ID]);
  const documentId = await svc(USERS.admin, (client) =>
    saveIdCheck(client, {
      orgId: ORG_ID,
      contactId,
      leaseId: null,
      createdBy: USERS.admin,
      docType: "passport",
      number: "PQ12RS78",
      photos: [
        { slot: "front", mime: "image/jpeg", bytes: large },
        { slot: "selfie", mime: "image/jpeg", bytes: medium },
      ],
    }),
  );
  const stored = await query<{ slot: string; plain: number; cipher: number }>(
    `SELECT p.slot, p.size_bytes::int AS plain, octet_length(o.ciphertext)::int AS cipher
       FROM identity_document_photos p
       JOIN id_document_objects o ON o.bucket = p.storage_bucket AND o.path = p.storage_path
      WHERE p.document_id = $1`,
    [documentId],
  );
  const front = stored.rows.find((row) => row.slot === "front");
  const selfie = stored.rows.find((row) => row.slot === "selfie");
  assert.ok(front && selfie);
  assert.ok(front.cipher > 64 * 1024);
  assert.ok(selfie.cipher > 64 * 1024);
  assert.equal(front.plain, large.length);
  const issued = await issuePhotoUrls(session(USERS.manager, "manager"), documentId);
  for (const [slot, plain] of [
    ["front", large],
    ["selfie", medium],
  ] as const) {
    const shot = issued.shots.find((item) => item.slot === slot);
    assert.ok(shot);
    const token = new URL(shot.url, "http://127.0.0.1").searchParams.get("token");
    assert.ok(token);
    const opened = await openSignedPhoto(session(USERS.manager, "manager"), token);
    assert.equal(opened.bytes[0], 0xff);
    assert.equal(opened.bytes[1], 0xd8);
    assert.equal(opened.mime, "image/jpeg");
    assert.equal(opened.bytes.equals(plain), false);
    const path = `${ORG_ID}/${documentId}/${slot}`;
    const original = await svc(USERS.admin, (client) => readCiphertext(client, "id-documents-private", path));
    assert.ok(original);
    const unmarked = await decryptBytes(original, { orgId: ORG_ID, documentId, slot }, ENCRYPTION_KEY_REF);
    assert.equal(unmarked.equals(plain), true);
    const watermark = await svc(USERS.admin, (client) => readCiphertext(client, "id-documents-private", `${path}.wm`, "watermark"));
    assert.ok(watermark);
    const burned = await decryptBytes(watermark, { orgId: ORG_ID, documentId, slot: `${slot}#wm` }, ENCRYPTION_KEY_REF);
    assert.equal(burned.equals(opened.bytes), true);
    assert.equal(burned.equals(plain), false);
    assert.ok(opened.timing.total >= opened.timing.db);
    assert.ok(opened.timing.decrypt >= 0);
    assert.ok(opened.timing.watermark >= 0);
    console.log("photo-timing", slot, opened.timing);
  }
});

test("a soft-deleted document is purged while a future live document stays", async () => {
  const liveContact = randomUUID();
  const deadContact = randomUUID();
  await query(`INSERT INTO contacts (id, org_id, is_tenant, display_name) VALUES ($1,$2,true,'仍在'), ($3,$2,true,'已取代')`, [
    liveContact,
    ORG_ID,
    deadContact,
  ]);
  const save = (contactId: string, number: string) =>
    svc(USERS.admin, (client) =>
      saveIdCheck(client, {
        orgId: ORG_ID,
        contactId,
        leaseId: null,
        createdBy: USERS.admin,
        docType: "passport",
        number,
        photos: [
          { slot: "front", ...photo() },
          { slot: "selfie", ...photo() },
        ],
      }),
    );
  const liveId = await save(liveContact, "EE44FF22");
  const deadId = await save(deadContact, "GG55HH33");
  const before = await query<{ n: string; due: string }>(
    `SELECT (SELECT count(*) FROM identity_document_photos p WHERE p.document_id = d.id)::text AS n,
            d.delete_after::text AS due
       FROM identity_documents d WHERE d.id = $1`,
    [deadId],
  );
  assert.equal(before.rows[0].n, "2");
  assert.ok(before.rows[0].due > new Date().toISOString().slice(0, 10));
  await query(`UPDATE identity_documents SET deleted_at = now() WHERE id = $1`, [deadId]);
  const removed = await purgeDueIdDocuments();
  assert.ok(removed >= 1);
  const dead = await query<{ storage_path: string; photos: string; objects: string }>(
    `SELECT d.storage_path,
            (SELECT count(*) FROM identity_document_photos p WHERE p.document_id = d.id)::text AS photos,
            (SELECT count(*) FROM id_document_objects o WHERE o.path LIKE $2)::text AS objects
       FROM identity_documents d WHERE d.id = $1`,
    [deadId, `%/${deadId}/%`],
  );
  assert.match(dead.rows[0].storage_path, /^purged\//);
  assert.equal(dead.rows[0].photos, "0");
  assert.equal(dead.rows[0].objects, "0");
  const live = await query<{ deleted_at: Date | null; photos: string }>(
    `SELECT d.deleted_at, (SELECT count(*) FROM identity_document_photos p WHERE p.document_id = d.id)::text AS photos
       FROM identity_documents d WHERE d.id = $1`,
    [liveId],
  );
  assert.equal(live.rows[0].deleted_at, null);
  assert.equal(live.rows[0].photos, "2");
});

test("deleting one document does not open another document's access log", async () => {
  const make = async (number: string) => {
    const contactId = randomUUID();
    await query(`INSERT INTO contacts (id, org_id, is_tenant, display_name) VALUES ($1,$2,true,'日誌')`, [contactId, ORG_ID]);
    const documentId = await svc(USERS.admin, (client) =>
      saveIdCheck(client, {
        orgId: ORG_ID,
        contactId,
        leaseId: null,
        createdBy: USERS.admin,
        docType: "passport",
        number,
        photos: [
          { slot: "front", ...photo() },
          { slot: "selfie", ...photo() },
        ],
      }),
    );
    await query(
      `INSERT INTO identity_document_access_log (org_id, document_id, accessed_by, purpose) VALUES ($1,$2,$3,'download')`,
      [ORG_ID, documentId, USERS.manager],
    );
    return documentId;
  };
  const docA = await make("JJ66KK44");
  const docB = await make("LL77MM55");
  await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      await client.query(`DELETE FROM identity_documents WHERE id = $1`, [docA]);
      const gone = await client.query(`SELECT id FROM identity_document_access_log WHERE document_id = $1`, [docA]);
      assert.equal(gone.rows.length, 0);
      await client.query("SAVEPOINT log_delete");
      await assert.rejects(
        () => client.query(`DELETE FROM identity_document_access_log WHERE document_id = $1`, [docB]),
        /append-only/,
      );
      await client.query("ROLLBACK TO SAVEPOINT log_delete");
      const kept = await client.query(`SELECT id FROM identity_document_access_log WHERE document_id = $1`, [docB]);
      assert.equal(kept.rows.length, 1);
    } finally {
      await client.query("ROLLBACK");
    }
  });
});

test("an activated or signed lease keeps 90 days after move-out, and a draft or cancelled lease uses the upload window", async () => {
  const makeLease = async (status: string, esign: string, start: number, end: number, signed: boolean) => {
    const row = await query<{ id: string }>(
      `INSERT INTO leases (
         org_id, property_id, unit_id, target_unit_id, target_room_id, status, esign_status,
         start_date, end_date, currency, rent_amount_minor, deposit_amount_minor, created_by, signed_at
       )
       SELECT org_id, property_id, unit_id, target_unit_id, target_room_id,
              $3::lease_status, $4::esign_status,
              current_date + $5::int, current_date + $6::int, currency, rent_amount_minor, 0, $2,
              CASE WHEN $7::bool THEN now() ELSE NULL END
         FROM leases
        WHERE org_id = $1
          AND target_room_id IS NOT NULL
          AND target_room_id NOT IN (
            SELECT open_lease.target_room_id
              FROM leases open_lease
             WHERE open_lease.status IN ('pending_signature', 'active')
               AND open_lease.end_date IS NULL
               AND open_lease.target_room_id IS NOT NULL
          )
        LIMIT 1
       RETURNING id::text`,
      [ORG_ID, USERS.admin, status, esign, start, end, signed],
    );
    return row.rows[0].id;
  };
  const save = async (leaseId: string, number: string) => {
    const contactId = randomUUID();
    await query(`INSERT INTO contacts (id, org_id, is_tenant, display_name) VALUES ($1,$2,true,'期限')`, [contactId, ORG_ID]);
    await query(`INSERT INTO lease_parties (org_id, lease_id, contact_id, role) VALUES ($1,$2,$3,'primary')`, [
      ORG_ID,
      leaseId,
      contactId,
    ]);
    return svc(USERS.admin, (client) =>
      saveIdCheck(client, {
        orgId: ORG_ID,
        contactId,
        leaseId,
        createdBy: USERS.admin,
        docType: "passport",
        number,
        photos: [
          { slot: "front", ...photo() },
          { slot: "selfie", ...photo() },
        ],
      }),
    );
  };
  const dueOn = async (documentId: string) => {
    const row = await query<{ delete_after: string }>(
      `SELECT delete_after::text FROM identity_documents WHERE id = $1`,
      [documentId],
    );
    return row.rows[0].delete_after;
  };
  const moveOut = async (offset: number) => {
    const row = await query<{ due: string }>(
      `SELECT (current_date + $1::int + id_document_keep_days())::text AS due`,
      [offset],
    );
    return row.rows[0].due;
  };
  const assertUploadWindow = async (documentId: string, plannedEnd: number) => {
    const row = await query<{ delete_after: string; expected: string }>(
      `SELECT d.delete_after::text,
              ((d.created_at AT TIME ZONE 'Asia/Taipei')::date + id_document_keep_days())::text AS expected
         FROM identity_documents d
        WHERE d.id = $1`,
      [documentId],
    );
    assert.equal(row.rows[0].delete_after, row.rows[0].expected);
    assert.notEqual(row.rows[0].delete_after, await moveOut(plannedEnd));
  };

  const activeId = await makeLease("active", "fully_signed", 400, 430, true);
  const activeDoc = await save(activeId, "AC12TI78");
  assert.equal(await dueOn(activeDoc), await moveOut(430));
  await query(`UPDATE leases SET status = 'terminated', terminated_on = current_date + 410 WHERE id = $1`, [activeId]);
  assert.equal(await dueOn(activeDoc), await moveOut(410));

  const signedId = await makeLease("pending_signature", "fully_signed", 500, 530, true);
  const signedDoc = await save(signedId, "SI12GN78");
  assert.equal(await dueOn(signedDoc), await moveOut(530));

  const draftId = await makeLease("draft", "not_sent", 600, 630, false);
  const draftDoc = await save(draftId, "DR12AF78");
  await assertUploadWindow(draftDoc, 630);

  const cancelledId = await makeLease("cancelled", "voided", 700, 730, true);
  const cancelledDoc = await save(cancelledId, "CA12NC78");
  await assertUploadWindow(cancelledDoc, 730);

  const voidedId = await makeLease("pending_signature", "voided", 800, 830, false);
  const voidedDoc = await save(voidedId, "VO12ID78");
  await assertUploadWindow(voidedDoc, 830);

  const waitingId = await makeLease("pending_signature", "not_sent", 900, 930, false);
  const waitingDoc = await save(waitingId, "PE12ND78");
  await assertUploadWindow(waitingDoc, 930);

  await query(
    `UPDATE leases SET status = 'active', esign_status = 'fully_signed', signed_at = now() WHERE id = $1`,
    [draftId],
  );
  assert.equal(await dueOn(draftDoc), await moveOut(630));
  await query(`UPDATE leases SET status = 'cancelled', esign_status = 'voided' WHERE id = $1`, [draftId]);
  await assertUploadWindow(draftDoc, 630);
});

test("a sample id cannot be attached to another firm's lease", async () => {
  const lease = await query<{ id: string }>(`SELECT id::text FROM leases WHERE org_id = $1 LIMIT 1`, [ORG_ID]);
  await assert.rejects(
    () => attachSampleId(USERS.coastAdmin, lease.rows[0].id),
    (error: unknown) => error instanceof FlowError && error.key === "errors.notFound",
  );
});

test("a failed finalize deletes staged ciphertext and leaves the saved document", async () => {
  const leaseId = randomUUID();
  const documentId = randomUUID();
  const ciphertext = Buffer.alloc(70 * 1024, 7);
  const before = await query<{ n: string }>(`SELECT count(*)::text AS n FROM id_document_objects`);
  const beforeDocs = await query<{ n: string }>(`SELECT count(*)::text AS n FROM identity_documents`);
  await svc(USERS.tenant2, async (client) => {
    for (const slot of ["front", "back", "selfie"] as const) {
      await writeUploadSlot(client, {
        userId: USERS.tenant2,
        leaseId,
        documentId,
        slot,
        mime: "image/jpeg",
        plainSize: ciphertext.length,
        sha256: "ab".repeat(32),
        ciphertext,
      });
    }
  });
  const tenant = { ...session(USERS.tenant2, "manager"), kind: "tenant" as const, name: "王小美" };
  await assert.rejects(
    () =>
      finalizeTenantId(tenant, {
        leaseId,
        docType: "tw_national_id",
        number: "A123456789",
        consent: true,
      }),
    (error: unknown) => error instanceof FlowError && error.key === "errors.notFound",
  );
  const slots = await query<{ n: string }>(`SELECT count(*)::text AS n FROM id_upload_slots WHERE lease_id = $1`, [leaseId]);
  assert.equal(slots.rows[0]?.n, "0");
  const orphans = await query<{ n: string }>(`SELECT count(*)::text AS n FROM id_document_objects WHERE path LIKE $1`, [
    `%/${documentId}/%`,
  ]);
  assert.equal(orphans.rows[0]?.n, "0");
  const after = await query<{ n: string }>(`SELECT count(*)::text AS n FROM id_document_objects`);
  const afterDocs = await query<{ n: string }>(`SELECT count(*)::text AS n FROM identity_documents`);
  assert.equal(after.rows[0]?.n, before.rows[0]?.n);
  assert.equal(afterDocs.rows[0]?.n, beforeDocs.rows[0]?.n);
});

test("ciphertext over 64KiB is copied in slices and a later submit stores one document", async () => {
  const contactId = randomUUID();
  await query(`INSERT INTO contacts (id, org_id, is_tenant, display_name) VALUES ($1,$2,true,'切片')`, [contactId, ORG_ID]);
  const seeded = await svc(USERS.admin, (client) =>
    saveIdCheck(client, {
      orgId: ORG_ID,
      contactId,
      leaseId: null,
      createdBy: USERS.admin,
      docType: "passport",
      number: "SL12CE78",
      photos: [
        { slot: "front", ...photo() },
        { slot: "selfie", ...photo() },
      ],
    }),
  );
  const blob = Buffer.alloc(70 * 1024, 9);
  const scratchLease = randomUUID();
  const path = `${ORG_ID}/${seeded}/front`;
  await svc(USERS.admin, async (client) => {
    await client.query(`DELETE FROM id_document_objects WHERE path = $1`, [path]);
    await writeUploadSlot(client, {
      userId: USERS.tenant2,
      leaseId: scratchLease,
      documentId: seeded,
      slot: "front",
      mime: "image/jpeg",
      plainSize: blob.length,
      sha256: "cd".repeat(32),
      ciphertext: blob,
    });
    await copySlotCiphertext(client, {
      bucket: "id-documents-private",
      userId: USERS.tenant2,
      leaseId: scratchLease,
      orgId: ORG_ID,
      documentId: seeded,
      slot: "front",
    });
    const stored = await readCiphertext(client, "id-documents-private", path);
    assert.ok(stored);
    assert.equal(stored.length > 64 * 1024, true);
    assert.equal(stored.equals(blob), true);
    await client.query(`DELETE FROM id_upload_slots WHERE lease_id = $1`, [scratchLease]);
  });

  const source = await query<{ id: string }>(`SELECT id::text FROM leases WHERE org_id = $1 LIMIT 1`, [ORG_ID]);
  const contact = await query<{ id: string }>(`SELECT id::text FROM contacts WHERE user_id = $1`, [USERS.tenant2]);
  const created = await query<{ id: string }>(
    `INSERT INTO leases (
       org_id, property_id, unit_id, target_unit_id, target_room_id, status,
       start_date, end_date, currency, rent_amount_minor, deposit_amount_minor, created_by
     )
     SELECT org_id, property_id, unit_id, target_unit_id, target_room_id, 'draft',
            current_date + 9000, current_date + 9300, currency, rent_amount_minor, 0, $2
       FROM leases WHERE id = $1
     RETURNING id::text`,
    [source.rows[0].id, USERS.admin],
  );
  const leaseId = created.rows[0].id;
  await query(`INSERT INTO lease_parties (org_id, lease_id, contact_id, role) VALUES ($1,$2,$3,'primary')`, [
    ORG_ID,
    leaseId,
    contact.rows[0].id,
  ]);
  const tenant = { ...session(USERS.tenant2, "manager"), kind: "tenant" as const, name: "王小美" };
  const failedId = randomUUID();
  await svc(USERS.tenant2, async (client) => {
    for (const slot of ["front", "back", "selfie"] as const) {
      await writeUploadSlot(client, {
        userId: USERS.tenant2,
        leaseId,
        documentId: failedId,
        slot,
        mime: "image/jpeg",
        plainSize: blob.length,
        sha256: "ef".repeat(32),
        ciphertext: blob,
      });
    }
  });
  await assert.rejects(
    () =>
      finalizeTenantId(tenant, {
        leaseId,
        docType: "tw_national_id",
        number: "not-an-id",
        consent: true,
      }),
    (error: unknown) => error instanceof FlowError && error.key === "errors.idNumber",
  );
  const cleaned = await query<{ n: string }>(`SELECT count(*)::text AS n FROM id_upload_slots WHERE lease_id = $1`, [leaseId]);
  assert.equal(cleaned.rows[0]?.n, "0");
  const failedObjects = await query<{ n: string }>(`SELECT count(*)::text AS n FROM id_document_objects WHERE path LIKE $1`, [
    `%/${failedId}/%`,
  ]);
  assert.equal(failedObjects.rows[0]?.n, "0");
  const marked = markedPhoto();
  for (const slot of ["front", "back", "selfie"] as const) {
    await storeIdPhoto(tenant, { leaseId, slot, ...marked });
  }
  await finalizeTenantId(tenant, {
    leaseId,
    docType: "tw_national_id",
    number: "A123456789",
    consent: true,
  });
  for (const slot of ["front", "back", "selfie"] as const) {
    await storeIdPhoto(tenant, { leaseId, slot, ...marked });
  }
  await finalizeTenantId(tenant, {
    leaseId,
    docType: "tw_national_id",
    number: "A123456789",
    consent: true,
  });
  const docs = await query<{ id: string }>(
    `SELECT id::text FROM identity_documents WHERE lease_id = $1 AND deleted_at IS NULL`,
    [leaseId],
  );
  assert.equal(docs.rows.length, 1);
  const objects = await query<{ n: string }>(`SELECT count(*)::text AS n FROM id_document_objects WHERE path LIKE $1`, [
    `%/${docs.rows[0].id}/%`,
  ]);
  assert.equal(objects.rows[0]?.n, "3");
  const slots = await query<{ n: string }>(`SELECT count(*)::text AS n FROM id_upload_slots WHERE lease_id = $1`, [leaseId]);
  assert.equal(slots.rows[0]?.n, "0");
});

test("a manager cannot update or delete identity rows as authenticated", async () => {
  const doc = await query<{ id: string }>(
    `SELECT id::text FROM identity_documents WHERE org_id = $1 AND deleted_at IS NULL LIMIT 1`,
    [ORG_ID],
  );
  assert.ok(doc.rows[0]);
  const denied = (error: unknown) => error instanceof FlowError && error.key === "errors.forbidden";
  await assert.rejects(
    () =>
      tx(
        USERS.manager,
        (client) => client.query(`UPDATE identity_documents SET return_reason = 'no' WHERE id = $1`, [doc.rows[0].id]),
        { orgId: ORG_ID, environment: "live" },
      ),
    denied,
  );
  await assert.rejects(
    () =>
      tx(
        USERS.manager,
        (client) => client.query(`DELETE FROM identity_documents WHERE id = $1`, [doc.rows[0].id]),
        { orgId: ORG_ID, environment: "live" },
      ),
    denied,
  );
});

test("a missing display name watermarks the email local part", async () => {
  const doc = await query<{ id: string; firm: string }>(
    `SELECT d.id::text, o.name AS firm
       FROM identity_documents d
       JOIN organizations o ON o.id = d.org_id
      WHERE d.org_id = $1 AND d.deleted_at IS NULL
      LIMIT 1`,
    [ORG_ID],
  );
  const profile = await query<{ display_name: string | null; email: string }>(
    `SELECT p.display_name, coalesce(p.email::text, u.email::text) AS email
       FROM auth.users u
       LEFT JOIN profiles p ON p.id = u.id
      WHERE u.id = $1`,
    [USERS.manager],
  );
  const email = profile.rows[0]?.email ?? "";
  const local = email.split("@")[0] ?? "";
  assert.ok(local);
  const cleared = await query(`UPDATE profiles SET display_name = NULL WHERE id = $1`, [USERS.manager]);
  assert.equal(cleared.rowCount, 1);
  try {
    const issued = await issuePhotoUrls(session(USERS.manager, "manager"), doc.rows[0].id);
    assert.match(issued.watermark, new RegExp(`^僅供${doc.rows[0].firm}核對租約身分使用・${local}・\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}$`));
    assert.equal(issued.watermark.includes("黃志明"), false);
    assert.equal(issued.watermark.includes("驗證"), false);
    assert.equal(issued.watermark.includes("已認證"), false);
  } finally {
    await query(`UPDATE profiles SET display_name = $2 WHERE id = $1`, [USERS.manager, profile.rows[0]?.display_name]);
  }
});

test("terminating or cancelling a lease fills a null end date and leaves one that is already set", async () => {
  const room = await query<{ property_id: string; unit_id: string; target_unit_id: string; target_room_id: string }>(
    `SELECT property_id::text, unit_id::text, target_unit_id::text, target_room_id::text
       FROM leases
      WHERE org_id = $1
        AND target_room_id IS NOT NULL
        AND target_room_id NOT IN (
          SELECT open_lease.target_room_id
            FROM leases open_lease
           WHERE open_lease.status IN ('pending_signature', 'active')
             AND open_lease.end_date IS NULL
             AND open_lease.target_room_id IS NOT NULL
        )
      LIMIT 1`,
    [ORG_ID],
  );
  const base = room.rows[0];
  assert.ok(base);
  const taipei = async () => {
    const row = await query<{ day: string }>(`SELECT (timezone('Asia/Taipei', now()))::date::text AS day`);
    return row.rows[0].day;
  };
  const insertLease = async (status: string, esign: string, start: string, end: string | null) => {
    const row = await query<{ id: string; end_date: string | null }>(
      `INSERT INTO leases (
         org_id, property_id, unit_id, target_unit_id, target_room_id, status, esign_status,
         start_date, end_date, currency, rent_amount_minor, deposit_amount_minor, created_by
       ) VALUES (
         $1, $2, $3, $4, $5, $6::lease_status, $7::esign_status, $8::date, $9::date, 'TWD', 1, 0, $10
       )
       RETURNING id::text, end_date::text`,
      [ORG_ID, base.property_id, base.unit_id, base.target_unit_id, base.target_room_id, status, esign, start, end, USERS.admin],
    );
    return row.rows[0];
  };
  const save = async (leaseId: string, number: string) => {
    const contactId = randomUUID();
    await query(`INSERT INTO contacts (id, org_id, is_tenant, display_name) VALUES ($1,$2,true,'終止日')`, [contactId, ORG_ID]);
    await query(`INSERT INTO lease_parties (org_id, lease_id, contact_id, role) VALUES ($1,$2,$3,'primary')`, [ORG_ID, leaseId, contactId]);
    const documentId = await svc(USERS.admin, (client) =>
      saveIdCheck(client, {
        orgId: ORG_ID,
        contactId,
        leaseId,
        createdBy: USERS.admin,
        docType: "passport",
        number,
        photos: [
          { slot: "front", ...photo() },
          { slot: "selfie", ...photo() },
        ],
      }),
    );
    return documentId;
  };
  const due = async (documentId: string) => {
    const row = await query<{ delete_after: string; upload: string }>(
      `SELECT d.delete_after::text,
              ((d.created_at AT TIME ZONE 'Asia/Taipei')::date + id_document_keep_days())::text AS upload
         FROM identity_documents d WHERE d.id = $1`,
      [documentId],
    );
    return row.rows[0];
  };
  const today = await taipei();
  const openDraft = await insertLease("draft", "not_sent", "2020-01-01", null);
  assert.equal(openDraft.end_date, null);
  const openDoc = await save(openDraft.id, "EN12DD78");
  const openDue = await due(openDoc);
  assert.equal(openDue.delete_after, openDue.upload);
  await query(`UPDATE leases SET status = 'terminated' WHERE id = $1`, [openDraft.id]);
  const closed = await query<{ end_date: string; terminated_on: string | null; delete_after: string }>(
    `SELECT l.end_date::text, l.terminated_on::text,
            (l.end_date + id_document_keep_days())::text AS delete_after
       FROM leases l
       JOIN identity_documents d ON d.lease_id = l.id
      WHERE l.id = $1`,
    [openDraft.id],
  );
  assert.equal(closed.rows[0].end_date, today);
  assert.equal(closed.rows[0].terminated_on, null);
  const afterClose = await due(openDoc);
  assert.equal(afterClose.delete_after, closed.rows[0].delete_after);
  assert.notEqual(afterClose.delete_after, "9999-12-31");

  const keptEnd = "2027-04-01";
  const preset = await insertLease("draft", "not_sent", "2026-01-01", keptEnd);
  assert.equal(preset.end_date, keptEnd);
  const presetDoc = await save(preset.id, "PR12ES78");
  await query(`UPDATE leases SET status = 'terminated' WHERE id = $1`, [preset.id]);
  const presetRow = await query<{ end_date: string; terminated_on: string | null }>(
    `SELECT end_date::text, terminated_on::text FROM leases WHERE id = $1`,
    [preset.id],
  );
  assert.equal(presetRow.rows[0].end_date, keptEnd);
  assert.equal(presetRow.rows[0].terminated_on, null);
  const presetDue = await due(presetDoc);
  const expectedPreset = await query<{ due: string }>(
    `SELECT ($1::date + id_document_keep_days())::text AS due`,
    [keptEnd],
  );
  assert.equal(presetDue.delete_after, expectedPreset.rows[0].due);

  const cancelled = await insertLease("draft", "not_sent", "2020-06-01", null);
  const cancelledDoc = await save(cancelled.id, "CA12EL78");
  await query(`UPDATE leases SET status = 'cancelled', esign_status = 'voided' WHERE id = $1`, [cancelled.id]);
  const cancelledRow = await query<{ end_date: string }>(`SELECT end_date::text FROM leases WHERE id = $1`, [cancelled.id]);
  assert.equal(cancelledRow.rows[0].end_date, today);
  const cancelledDue = await due(cancelledDoc);
  assert.equal(cancelledDue.delete_after, cancelledDue.upload);

  const dated = await insertLease("draft", "not_sent", "2020-03-01", null);
  await query(`UPDATE leases SET status = 'terminated', terminated_on = current_date - 4 WHERE id = $1`, [dated.id]);
  const datedRow = await query<{ end_date: string; terminated_on: string }>(
    `SELECT end_date::text, terminated_on::text FROM leases WHERE id = $1`,
    [dated.id],
  );
  assert.equal(datedRow.rows[0].terminated_on, datedRow.rows[0].end_date);
  const expectedTerm = await query<{ day: string }>(`SELECT (current_date - 4)::text AS day`);
  assert.equal(datedRow.rows[0].end_date, expectedTerm.rows[0].day);

  const futureStart = await query<{ day: string }>(`SELECT (current_date + 40)::text AS day`);
  const future = await insertLease("cancelled", "voided", futureStart.rows[0].day, null);
  assert.equal(future.end_date, futureStart.rows[0].day);

  const stillOpen = await insertLease("draft", "not_sent", "2021-01-01", null);
  assert.equal(stillOpen.end_date, null);
  const freshRoom = await query<{ id: string }>(
    `INSERT INTO rooms (org_id, unit_id, label)
     SELECT $1, unit_id, 'end-date-' || substr(gen_random_uuid()::text, 1, 8)
       FROM leases
      WHERE org_id = $1 AND target_room_id IS NOT NULL
      LIMIT 1
     RETURNING id::text`,
    [ORG_ID],
  );
  const activeStart = await query<{ day: string }>(`SELECT (current_date + 2000)::text AS day`);
  const active = await query<{ end_date: string | null }>(
    `INSERT INTO leases (
       org_id, property_id, unit_id, target_unit_id, target_room_id, status, esign_status,
       start_date, end_date, currency, rent_amount_minor, deposit_amount_minor, created_by
     )
     SELECT org_id, property_id, unit_id, NULL, $2, 'active', 'fully_signed', $3::date, NULL, currency, rent_amount_minor, 0, $4
       FROM leases
      WHERE org_id = $1 AND target_room_id IS NOT NULL
      LIMIT 1
     RETURNING end_date::text`,
    [ORG_ID, freshRoom.rows[0].id, activeStart.rows[0].day, USERS.admin],
  );
  assert.equal(active.rows[0].end_date, null);
});

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { writeAudit } from "./audit";
import { svc } from "./db";
import { FlowError } from "./errors";
import { produceNotificationEvent } from "./notification-event-producers";
import { deleteHandoverObject, handoverBytes, handoverMeta, readHandoverObject, sealHandoverObject } from "./handover-storage";
import type { Session } from "./types";

type Phase = "move_in" | "move_out";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validId(id: string) { if (!UUID.test(id)) throw new FlowError("errors.notFound"); }
function phaseValue(phase: string): asserts phase is Phase { if (phase !== "move_in" && phase !== "move_out") throw new FlowError("errors.required"); }
function noteValue(value: string, max: number) { const note = value.trim(); if (note.length > max) throw new FlowError("errors.required"); return note; }

/** Checks the authenticated session and current relationships inside each transaction.
 * Write lock order: rollout setting, org, session, relationship, lease, record/version.
 * The caller must provide the Session produced by getSession/readSessionOn, never form data.
 */
async function authorize(client: Client, session: Session, leaseId: string, write: boolean) {
  validId(leaseId);
  if (session.needsSandbox || !["staff", "tenant"].includes(session.kind)) throw new FlowError("errors.notFound");
  if (session.kind === "tenant" && session.leaseId !== leaseId) throw new FlowError("errors.notFound");
  if (write) await client.query("LOCK TABLE public.platform_settings IN SHARE MODE");
  const org = await client.query(`SELECT o.id FROM public.organizations o
    WHERE o.id=$1 AND o.environment::text=$2 AND coalesce(o.live_org_id,o.id)=$3
      AND o.feature_flags->'handover_records'='true'::jsonb
      AND EXISTS (SELECT 1 FROM public.platform_settings p WHERE p.key='handover_records'
        AND p.value->'enabled'='true'::jsonb AND jsonb_typeof(p.value->'allowed_org_ids')='array'
        AND p.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) ${write ? "FOR SHARE" : ""}`,
    [session.orgId, session.environment, session.liveOrgId]);
  if (!org.rowCount) throw new FlowError("errors.notFound");
  const auth = await client.query(`SELECT id FROM public.auth_sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp() ${write ? "FOR SHARE" : ""}`, [session.sessionId, session.userId]);
  if (!auth.rowCount) throw new FlowError("errors.notFound");
  if (session.kind === "staff") {
    const member = await client.query(`SELECT id FROM public.org_members WHERE org_id=$1 AND user_id=$2 AND status='active' AND role IN ('admin','manager') ${write ? "FOR SHARE" : ""}`, [session.liveOrgId, session.userId]);
    if (!member.rowCount) throw new FlowError("errors.notFound");
  } else {
    const party = await client.query(`SELECT c.id FROM public.lease_parties lp JOIN public.contacts c ON c.org_id=lp.org_id AND c.id=lp.contact_id
      WHERE lp.org_id=$1 AND lp.lease_id=$2 AND lp.role IN ('primary','co_tenant') AND c.user_id=$3 AND c.is_tenant AND c.archived_at IS NULL ${write ? "FOR SHARE OF lp,c" : ""}`, [session.orgId, leaseId, session.userId]);
    if (!party.rowCount) throw new FlowError("errors.notFound");
  }
  const lease = await client.query(`SELECT id FROM public.leases WHERE id=$1 AND org_id=$2 AND ($3::boolean OR status <> 'draft') ${write ? "FOR SHARE" : ""}`, [leaseId, session.orgId, session.kind === "staff"]);
  if (!lease.rowCount) throw new FlowError("errors.notFound");
}
async function recheckSessionDeadline(client: Client, session: Session) {
  const valid = await client.query(`SELECT 1 FROM public.auth_sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()`, [session.sessionId, session.userId]);
  if (!valid.rowCount) throw new FlowError("errors.notFound");
}
async function recheckDeadline(client: Client, session: Session, intentId: string) {
  const valid = await client.query(`SELECT 1 FROM public.auth_sessions s JOIN app.handover_upload_intents i ON i.session_id=s.id AND i.actor_id=s.user_id
    WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
      AND i.id=$3 AND i.status='pending' AND i.expires_at>clock_timestamp()`, [session.sessionId, session.userId, intentId]);
  if (!valid.rowCount) throw new FlowError("errors.notFound");
}
async function lockRecord(client: Client, org: string, lease: string, phase: Phase, create: boolean) {
  if (create) await client.query(`INSERT INTO app.handover_records(org_id,lease_id,phase) VALUES($1,$2,$3) ON CONFLICT (org_id,lease_id,phase) DO NOTHING`, [org, lease, phase]);
  const row = await client.query<{ id: string }>(`SELECT id FROM app.handover_records WHERE org_id=$1 AND lease_id=$2 AND phase=$3 FOR UPDATE`, [org, lease, phase]);
  if (!row.rows[0]) throw new FlowError("errors.notFound");
  return row.rows[0].id;
}
async function latest(client: Client, recordId: string) {
  return (await client.query<{ id: string; revision: number; note: string }>(`SELECT id,revision,note FROM app.handover_versions WHERE record_id=$1 ORDER BY revision DESC LIMIT 1`, [recordId])).rows[0] ?? null;
}
async function createVersion(client: Client, session: Session, leaseId: string, recordId: string, previous: Awaited<ReturnType<typeof latest>>, note: string) {
  const v = (await client.query<{ id: string; revision: number }>(`INSERT INTO app.handover_versions(org_id,lease_id,record_id,revision,note,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,revision`, [session.orgId, leaseId, recordId, (previous?.revision ?? 0) + 1, note, session.userId])).rows[0];
  if (previous) await client.query(`INSERT INTO app.handover_version_attachments(org_id,lease_id,version_id,attachment_id) SELECT org_id,lease_id,$1,attachment_id FROM app.handover_version_attachments WHERE version_id=$2`, [v.id, previous.id]);
  return v;
}
export async function publishHandover(session: Session, leaseId: string, phase: string, note: string, expectedVersion: string | null) {
  phaseValue(phase); note = noteValue(note, 4000); if (session.kind !== "staff") throw new FlowError("errors.forbidden");
  return svc(session.userId, async client => {
    await authorize(client, session, leaseId, true);
    const recordId = await lockRecord(client, session.orgId, leaseId, phase, true);
    await recheckSessionDeadline(client, session);
    const previous = await latest(client, recordId);
    if ((previous?.id ?? null) !== expectedVersion) throw new FlowError("errors.generic");
    const version = await createVersion(client, session, leaseId, recordId, previous, note);
    await writeAudit(session.orgId, session.userId, "handover_version_published", { lease_id: leaseId, record_id: recordId, version_id: version.id, phase }, client);
    await produceNotificationEvent(client, session.orgId, "handover_version", version.id);
    await recheckSessionDeadline(client, session);
    return version;
  });
}
export async function replyHandover(session: Session, leaseId: string, versionId: string, response: string, note: string, requestId: string) {
  validId(versionId); validId(requestId); note = noteValue(note, 2000);
  if (response !== "confirm" && response !== "disagree") throw new FlowError("errors.required");
  return svc(session.userId, async client => {
    await authorize(client, session, leaseId, true);
    const target = (await client.query<{ record_id: string; phase: Phase }>(`SELECT v.record_id,r.phase FROM app.handover_versions v JOIN app.handover_records r ON r.id=v.record_id WHERE v.id=$1 AND v.org_id=$2 AND v.lease_id=$3`, [versionId, session.orgId, leaseId])).rows[0];
    if (!target) throw new FlowError("errors.notFound");
    await lockRecord(client, session.orgId, leaseId, target.phase, false);
    await recheckSessionDeadline(client, session);
    if ((await latest(client, target.record_id))?.id !== versionId) throw new FlowError("errors.generic");
    const prior = (await client.query<{ id: string; version_id: string; response: string; note: string }>(`SELECT id,version_id,response,note FROM app.handover_replies WHERE actor_id=$1 AND request_id=$2`, [session.userId, requestId])).rows[0];
    if (prior) {
      if (prior.version_id !== versionId || prior.response !== response || prior.note !== note) throw new FlowError("errors.generic");
      return prior.id;
    }
    const row = (await client.query<{ id: string }>(`INSERT INTO app.handover_replies(org_id,lease_id,version_id,actor_id,actor_kind,response,note,request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [session.orgId, leaseId, versionId, session.userId, session.kind, response, note, requestId])).rows[0];
    await writeAudit(session.orgId, session.userId, "handover_replied", { lease_id: leaseId, version_id: versionId, reply_id: row.id, response }, client);
    await recheckSessionDeadline(client, session);
    return row.id;
  });
}
export async function readHandover(session: Session, leaseId: string) {
  return svc(session.userId, async client => {
    await authorize(client, session, leaseId, true);
    const records = await client.query(`SELECT r.id,r.phase,v.id AS version_id,v.revision,v.note,v.created_at,nullif(btrim(p.display_name),'') AS author_name
      FROM app.handover_records r JOIN app.handover_versions v ON v.record_id=r.id LEFT JOIN public.profiles p ON p.id=v.created_by
      WHERE r.org_id=$1 AND r.lease_id=$2 ORDER BY r.phase,v.revision DESC`, [session.orgId, leaseId]);
    const attachments = await client.query(`SELECT va.version_id,a.id,a.file_name,a.mime,a.size_bytes,a.created_at,nullif(btrim(p.display_name),'') AS uploader_name FROM app.handover_version_attachments va JOIN app.handover_attachments a ON a.id=va.attachment_id LEFT JOIN public.profiles p ON p.id=a.created_by WHERE va.org_id=$1 AND va.lease_id=$2`, [session.orgId, leaseId]);
    const replies = await client.query(`SELECT r.version_id,r.actor_kind,r.response,r.note,r.created_at,nullif(btrim(p.display_name),'') AS actor_name FROM app.handover_replies r LEFT JOIN public.profiles p ON p.id=r.actor_id WHERE r.org_id=$1 AND r.lease_id=$2 ORDER BY r.created_at,r.id`, [session.orgId, leaseId]);
    const intents = await client.query(`SELECT id,version_id,file_name,mime,size_bytes,status,expires_at,(session_id=$4 AND status='pending' AND expires_at>clock_timestamp()) AS can_resume FROM app.handover_upload_intents WHERE org_id=$1 AND lease_id=$2 AND actor_id=$3 AND status IN ('pending','discarded','attached') ORDER BY created_at DESC`, [session.orgId, leaseId, session.userId, session.sessionId]);
    await recheckSessionDeadline(client, session);
    return { versions: records.rows, attachments: attachments.rows, replies: replies.rows, intents: intents.rows };
  });
}

export async function prepareHandoverUpload(session: Session, leaseId: string, versionId: string, input: { fileName: string; mime: string; size: number }) {
  validId(versionId); const meta = handoverMeta(input.fileName, input.mime, input.size);
  const intent = await svc(session.userId, async client => {
    await authorize(client, session, leaseId, true);
    const row = (await client.query<{ record_id: string; phase: Phase }>(`SELECT v.record_id,r.phase FROM app.handover_versions v JOIN app.handover_records r ON r.id=v.record_id WHERE v.id=$1 AND v.org_id=$2 AND v.lease_id=$3`, [versionId, session.orgId, leaseId])).rows[0];
    if (!row) throw new FlowError("errors.notFound");
    await lockRecord(client, session.orgId, leaseId, row.phase, false);
    await recheckSessionDeadline(client, session);
    if ((await latest(client, row.record_id))?.id !== versionId) throw new FlowError("errors.generic");
    const counts = (await client.query<{attached: number; pending: number}>(`SELECT
      (SELECT count(*)::int FROM app.handover_version_attachments WHERE version_id=$1) AS attached,
      (SELECT count(*)::int FROM app.handover_upload_intents WHERE version_id=$1 AND status='pending' AND expires_at>clock_timestamp()) AS pending`, [versionId])).rows[0];
    if (counts.attached + counts.pending >= 8) throw new FlowError("errors.photoLimit");
    const id = randomUUID();
    const path = `org/${session.orgId}/handover/${leaseId}/${id}`;
    await client.query(`INSERT INTO app.handover_upload_intents(id,org_id,lease_id,version_id,actor_id,session_id,file_name,mime,size_bytes,storage_path) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, session.orgId, leaseId, versionId, session.userId, session.sessionId, meta.fileName, meta.mime, meta.size, path]);
    await writeAudit(session.orgId, session.userId, "handover_upload_started", { lease_id: leaseId, version_id: versionId, intent_id: id }, client);
    await recheckSessionDeadline(client, session);
    return { id, path };
  });
  return { intentId: intent.id, mime: meta.mime };
}
/** The app, not the browser, writes the temporary object. The intent lock
 * prevents an upload from recreating an object after discard. */
export async function uploadHandoverBytes(session: Session, leaseId: string, intentId: string, bytes: Uint8Array) {
  validId(intentId);
  return svc(session.userId, async client => {
    await authorize(client, session, leaseId, true);
    const prelim = (await client.query<{ phase: Phase }>(`SELECT r.phase FROM app.handover_upload_intents i JOIN app.handover_versions v ON v.id=i.version_id JOIN app.handover_records r ON r.id=v.record_id WHERE i.id=$1 AND i.org_id=$2 AND i.lease_id=$3 AND i.actor_id=$4 AND i.session_id=$5`, [intentId, session.orgId, leaseId, session.userId, session.sessionId])).rows[0];
    if (!prelim) throw new FlowError("errors.notFound");
    const recordId = await lockRecord(client, session.orgId, leaseId, prelim.phase, false);
    await recheckSessionDeadline(client, session);
    const intent = (await client.query<{ version_id: string; mime: string; size_bytes: number; storage_path: string; status: string; usable: boolean }>(`SELECT *,expires_at>clock_timestamp() AS usable FROM app.handover_upload_intents WHERE id=$1 FOR UPDATE`, [intentId])).rows[0];
    await recheckSessionDeadline(client, session);
    if (!intent || intent.status !== "pending" || !intent.usable) throw new FlowError("errors.notFound");
    if ((await latest(client, recordId))?.id !== intent.version_id) throw new FlowError("errors.generic");
    const sha = handoverBytes(bytes, intent.mime, intent.size_bytes);
    await sealHandoverObject(intent.storage_path, bytes, intent.mime, sha);
    await recheckDeadline(client, session, intentId);
    await writeAudit(session.orgId, session.userId, "handover_upload_stored", { lease_id: leaseId, intent_id: intentId, sha256: sha }, client);
    await recheckSessionDeadline(client, session);
  });
}
export async function finalizeHandoverUpload(session: Session, leaseId: string, intentId: string) {
  validId(intentId);
  return svc(session.userId, async client => {
    await authorize(client, session, leaseId, true);
    const prelim = (await client.query<{ phase: Phase }>(`SELECT r.phase FROM app.handover_upload_intents i JOIN app.handover_versions v ON v.id=i.version_id JOIN app.handover_records r ON r.id=v.record_id WHERE i.id=$1 AND i.org_id=$2 AND i.lease_id=$3 AND i.actor_id=$4 AND i.session_id=$5`, [intentId, session.orgId, leaseId, session.userId, session.sessionId])).rows[0];
    if (!prelim) throw new FlowError("errors.notFound");
    const recordId = await lockRecord(client, session.orgId, leaseId, prelim.phase, false);
    await recheckSessionDeadline(client, session);
    const intent = (await client.query<{ id: string; version_id: string; file_name: string; mime: string; size_bytes: number; storage_path: string; status: string; usable: boolean }>(`SELECT *,expires_at>clock_timestamp() AS usable FROM app.handover_upload_intents WHERE id=$1 FOR UPDATE`, [intentId])).rows[0];
    await recheckSessionDeadline(client, session);
    if (!intent) throw new FlowError("errors.notFound");
    if (intent.status === "attached") {
      const result = (await client.query<{ id: string }>(`SELECT id FROM app.handover_attachments WHERE intent_id=$1`, [intentId])).rows[0];
      await recheckSessionDeadline(client, session);
      if (!result) throw new FlowError("errors.generic");
      return result;
    }
    if (intent.status !== "pending" || !intent.usable) throw new FlowError("errors.notFound");
    const previous = await latest(client, recordId);
    if (!previous || previous.id !== intent.version_id) throw new FlowError("errors.generic");
    const bytes = await readHandoverObject(intent.storage_path);
    const sha = handoverBytes(bytes, intent.mime, intent.size_bytes);
    const sealedPath = `${intent.storage_path}/sealed`;
    await sealHandoverObject(sealedPath, bytes, intent.mime, sha);
    await recheckDeadline(client, session, intentId);
    const version = await createVersion(client, session, leaseId, recordId, previous, previous.note);
    const attachment = (await client.query<{ id: string }>(`INSERT INTO app.handover_attachments(org_id,lease_id,intent_id,file_name,mime,size_bytes,sha256,storage_path,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [session.orgId, leaseId, intent.id, intent.file_name, intent.mime, intent.size_bytes, sha, sealedPath, session.userId])).rows[0];
    await client.query(`INSERT INTO app.handover_version_attachments(org_id,lease_id,version_id,attachment_id) VALUES($1,$2,$3,$4)`, [session.orgId, leaseId, version.id, attachment.id]);
    await client.query(`UPDATE app.handover_upload_intents SET status='attached' WHERE id=$1`, [intent.id]);
    await writeAudit(session.orgId, session.userId, "handover_attachment_published", { lease_id: leaseId, version_id: version.id, attachment_id: attachment.id, sha256: sha }, client);
    await recheckSessionDeadline(client, session);
    return attachment;
  });
}
export async function discardHandoverUpload(session: Session, leaseId: string, intentId: string) {
  validId(intentId);
  return svc(session.userId, async client => {
    await authorize(client, session, leaseId, true);
    const prelim = (await client.query<{ phase: Phase }>(`SELECT r.phase FROM app.handover_upload_intents i JOIN app.handover_versions v ON v.id=i.version_id JOIN app.handover_records r ON r.id=v.record_id WHERE i.id=$1 AND i.org_id=$2 AND i.lease_id=$3 AND i.actor_id=$4`, [intentId, session.orgId, leaseId, session.userId])).rows[0];
    if (!prelim) throw new FlowError("errors.notFound");
    await lockRecord(client, session.orgId, leaseId, prelim.phase, false);
    await recheckSessionDeadline(client, session);
    const intent = (await client.query<{ status: string; storage_path: string }>(`SELECT status,storage_path FROM app.handover_upload_intents WHERE id=$1 FOR UPDATE`, [intentId])).rows[0];
    await recheckSessionDeadline(client, session);
    if (!intent) throw new FlowError("errors.notFound");
    // A failed upstream request may finish after its caller timed out. Keep the
    // tombstone and repeat cleanup on every retry; one delete is not a proof
    // that no in-flight object write can subsequently appear.
    if (intent.status !== "attached") await deleteHandoverObject(`${intent.storage_path}/sealed`);
    await deleteHandoverObject(intent.storage_path);
    await recheckSessionDeadline(client, session);
    if (intent.status !== "attached") await client.query(`UPDATE app.handover_upload_intents SET status='discarded' WHERE id=$1`, [intentId]);
    await writeAudit(session.orgId, session.userId, "handover_upload_discarded", { lease_id: leaseId, intent_id: intentId }, client);
    await recheckSessionDeadline(client, session);
  });
}
export async function downloadHandoverAttachment(session: Session, leaseId: string, attachmentId: string) {
  validId(attachmentId);
  return svc(session.userId, async client => {
    await authorize(client, session, leaseId, true);
    const row = (await client.query<{ storage_path: string; mime: string; size_bytes: number; sha256: string; file_name: string }>(`SELECT storage_path,mime,size_bytes,sha256,file_name FROM app.handover_attachments WHERE id=$1 AND org_id=$2 AND lease_id=$3`, [attachmentId, session.orgId, leaseId])).rows[0];
    if (!row) throw new FlowError("errors.notFound");
    const bytes = await readHandoverObject(row.storage_path);
    if (handoverBytes(bytes, row.mime, row.size_bytes) !== row.sha256) throw new FlowError("errors.photoStorage");
    const sessionStillValid = await client.query(`SELECT 1 FROM public.auth_sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()`, [session.sessionId, session.userId]);
    if (!sessionStillValid.rowCount) throw new FlowError("errors.notFound");
    await writeAudit(session.orgId, session.userId, "handover_attachment_read", { lease_id: leaseId, attachment_id: attachmentId }, client);
    await recheckSessionDeadline(client, session);
    return { bytes, mime: row.mime, fileName: row.file_name };
  });
}

import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { writeAudit } from "./audit";
import { svc } from "./db";
import { FlowError } from "./errors";
import { deleteHandoverObject, handoverBytes, handoverMeta, readHandoverObject, sealHandoverObject } from "./handover-storage";
import { settlementAccess, settlementDeadline, settlementUuid } from "./settlement-access";
import type { Session } from "./types";

/** Lock order: current context and lease, then immutable version's record. */
async function context(client:Client,session:Session,leaseId:string,versionId:string) {
  settlementUuid(leaseId); settlementUuid(versionId);
  await settlementAccess(client,session,leaseId,"read");
  const initial=(await client.query<{record_id:string;published:boolean}>(`SELECT record_id,published FROM app.settlement_versions WHERE id=$1 AND org_id=$2 AND lease_id=$3`,[versionId,session.orgId,leaseId])).rows[0];
  if(!initial || (!initial.published && session.kind!=="staff")) throw new FlowError("errors.notFound");
  if(!(await client.query(`SELECT id FROM app.settlement_records WHERE id=$1 AND org_id=$2 AND lease_id=$3 FOR UPDATE`,[initial.record_id,session.orgId,leaseId])).rowCount) throw new FlowError("errors.notFound");
  const check=await client.query(`SELECT 1 FROM app.settlement_versions WHERE id=$1 AND org_id=$2 AND lease_id=$3 AND record_id=$4 AND (published OR $5::boolean)`,[versionId,session.orgId,leaseId,initial.record_id,session.kind==="staff"]);
  if(!check.rowCount) throw new FlowError("errors.notFound");
  await settlementDeadline(client,session,leaseId);
}
async function activeIntent(client:Client,session:Session,leaseId:string,versionId:string,intentId:string,requireOriginalSession:boolean) {
  const row=(await client.query<{id:string;actor_id:string;session_id:string;file_name:string;mime:string;size_bytes:number;storage_path:string;expected_sha256:string;status:string;usable:boolean}>(`SELECT *,expires_at>clock_timestamp() AS usable FROM app.settlement_upload_intents WHERE id=$1 AND org_id=$2 AND lease_id=$3 AND version_id=$4 AND actor_id=$5 FOR UPDATE`,[intentId,session.orgId,leaseId,versionId,session.userId])).rows[0];
  await settlementDeadline(client,session,leaseId);
  if(!row || (requireOriginalSession && row.session_id!==session.sessionId)) throw new FlowError("errors.notFound");
  return row;
}
export async function shareHandoverEvidence(session:Session,leaseId:string,versionId:string,attachmentId:string) {
  settlementUuid(attachmentId);
  return svc(session.userId,async client=>{
    const access=await settlementAccess(client,session,leaseId,"prepare");
    // Handover management is admin/manager; settlement preparation is
    // admin/accountant. Only the intersection can explicitly share it.
    if(access.role!=="admin") throw new FlowError("errors.notFound");
    const enabled=await client.query(`SELECT 1 FROM public.organizations o JOIN public.platform_settings p ON p.key='handover_records' WHERE o.id=$1 AND o.feature_flags->'handover_records'='true'::jsonb AND p.value->'enabled'='true'::jsonb AND jsonb_typeof(p.value->'allowed_org_ids')='array' AND p.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)`,[session.orgId]);
    if(!enabled.rowCount) throw new FlowError("errors.notFound");
    await context(client,session,leaseId,versionId);
    const file=(await client.query<{file_name:string;mime:string;size_bytes:number;sha256:string;storage_path:string;created_by:string;created_at:Date;session_id:string}>(`SELECT f.file_name,f.mime,f.size_bytes,f.sha256,f.storage_path,f.created_by,f.created_at,i.session_id FROM app.handover_attachments f JOIN app.handover_upload_intents i ON i.id=f.intent_id WHERE f.id=$1 AND f.org_id=$2 AND f.lease_id=$3`,[attachmentId,session.orgId,leaseId])).rows[0];
    if(!file) throw new FlowError("errors.notFound");
    await client.query(`INSERT INTO app.settlement_evidence(org_id,lease_id,handover_attachment_id,file_name,mime,size_bytes,sha256,storage_path,uploaded_by,upload_session,uploaded_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING`,[session.orgId,leaseId,attachmentId,file.file_name,file.mime,file.size_bytes,file.sha256,file.storage_path,file.created_by,file.session_id,file.created_at,session.userId]);
    const evidence=(await client.query<{id:string}>(`SELECT id FROM app.settlement_evidence WHERE org_id=$1 AND lease_id=$2 AND handover_attachment_id=$3`,[session.orgId,leaseId,attachmentId])).rows[0];
    if(!evidence) throw new FlowError("errors.generic");
    const linked=await client.query(`INSERT INTO app.settlement_evidence_links(org_id,lease_id,version_id,evidence_id,linked_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING evidence_id`,[session.orgId,leaseId,versionId,evidence.id,session.userId]);
    if(linked.rowCount) await writeAudit(session.orgId,session.userId,"settlement_evidence_shared",{lease_id:leaseId,version_id:versionId,evidence_id:evidence.id},client);
    await settlementDeadline(client,session,leaseId); return evidence.id;
  });
}
export async function prepareSettlementUpload(session:Session,leaseId:string,versionId:string,input:{requestId:string;fileName:string;mime:string;size:number;sha256:string}) {
  settlementUuid(input.requestId); const meta=handoverMeta(input.fileName,input.mime,input.size); if(!/^[0-9a-f]{64}$/.test(input.sha256)) throw new FlowError("errors.required");
  return svc(session.userId,async client=>{
    await context(client,session,leaseId,versionId);
    const prior=(await client.query<{id:string;org_id:string;lease_id:string;version_id:string;session_id:string;file_name:string;mime:string;size_bytes:number;expected_sha256:string}>(`SELECT id,org_id,lease_id,version_id,session_id,file_name,mime,size_bytes,expected_sha256 FROM app.settlement_upload_intents WHERE actor_id=$1 AND request_id=$2`,[session.userId,input.requestId])).rows[0];
    if(prior) { await settlementDeadline(client,session,leaseId); if(prior.org_id!==session.orgId || prior.lease_id!==leaseId || prior.version_id!==versionId || prior.session_id!==session.sessionId || prior.file_name!==meta.fileName || prior.mime!==meta.mime || prior.size_bytes!==meta.size || prior.expected_sha256!==input.sha256) throw new FlowError("errors.generic"); return prior.id; }
    const count=(await client.query<{n:number}>(`SELECT ((SELECT count(*) FROM app.settlement_evidence_links WHERE org_id=$1 AND lease_id=$2 AND version_id=$3) + (SELECT count(*) FROM app.settlement_upload_intents WHERE org_id=$1 AND lease_id=$2 AND version_id=$3 AND status='pending' AND expires_at>clock_timestamp()))::int AS n`,[session.orgId,leaseId,versionId])).rows[0].n;
    if(count>=32) throw new FlowError("errors.photoLimit");
    const id=randomUUID(), path=`org/${session.orgId}/settlement/${leaseId}/${id}`;
    await client.query(`INSERT INTO app.settlement_upload_intents(id,org_id,lease_id,version_id,actor_id,session_id,request_id,file_name,mime,size_bytes,expected_sha256,storage_path) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[id,session.orgId,leaseId,versionId,session.userId,session.sessionId,input.requestId,meta.fileName,meta.mime,meta.size,input.sha256,path]);
    await writeAudit(session.orgId,session.userId,"settlement_upload_started",{lease_id:leaseId,version_id:versionId,intent_id:id},client);
    await settlementDeadline(client,session,leaseId); return id;
  });
}
export async function uploadSettlementBytes(session:Session,leaseId:string,versionId:string,intentId:string,bytes:Uint8Array) {
  settlementUuid(intentId);
  return svc(session.userId,async client=>{
    await context(client,session,leaseId,versionId);
    const intent=await activeIntent(client,session,leaseId,versionId,intentId,true);
    if(intent.status!=="pending" || !intent.usable) throw new FlowError("errors.notFound");
    const sha=handoverBytes(bytes,intent.mime,intent.size_bytes);
    if(sha!==intent.expected_sha256) throw new FlowError("errors.photoType");
    await sealHandoverObject(intent.storage_path,bytes,intent.mime,sha);
    await settlementDeadline(client,session,leaseId);
    const still=(await client.query(`SELECT 1 FROM app.settlement_upload_intents WHERE id=$1 AND status='pending' AND expires_at>clock_timestamp()`,[intentId])).rowCount;
    if(!still) throw new FlowError("errors.notFound");
    await writeAudit(session.orgId,session.userId,"settlement_upload_stored",{lease_id:leaseId,version_id:versionId,intent_id:intentId,sha256:sha},client);
    await settlementDeadline(client,session,leaseId);
  });
}
export async function finalizeSettlementUpload(session:Session,leaseId:string,versionId:string,intentId:string) {
  settlementUuid(intentId);
  return svc(session.userId,async client=>{
    await context(client,session,leaseId,versionId);
    const intent=await activeIntent(client,session,leaseId,versionId,intentId,true);
    if(intent.status==="attached") {
      const prior=(await client.query<{id:string}>(`SELECT e.id FROM app.settlement_evidence e JOIN app.settlement_evidence_links l ON l.evidence_id=e.id AND l.org_id=e.org_id AND l.lease_id=e.lease_id WHERE e.intent_id=$1 AND l.version_id=$2`,[intentId,versionId])).rows[0];
      await settlementDeadline(client,session,leaseId); if(!prior) throw new FlowError("errors.generic"); return prior.id;
    }
    if(intent.status!=="pending" || !intent.usable) throw new FlowError("errors.notFound");
    const bytes=await readHandoverObject(intent.storage_path), sha=handoverBytes(bytes,intent.mime,intent.size_bytes);
    if(sha!==intent.expected_sha256) throw new FlowError("errors.photoType");
    const sealed=`${intent.storage_path}/sealed`; await sealHandoverObject(sealed,bytes,intent.mime,sha);
    await settlementDeadline(client,session,leaseId);
    if(!(await client.query(`SELECT 1 FROM app.settlement_upload_intents WHERE id=$1 AND status='pending' AND expires_at>clock_timestamp()`,[intentId])).rowCount) throw new FlowError("errors.notFound");
    const evidence=(await client.query<{id:string}>(`INSERT INTO app.settlement_evidence(org_id,lease_id,intent_id,file_name,mime,size_bytes,sha256,storage_path,uploaded_by,upload_session,uploaded_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp(),$9) RETURNING id`,[session.orgId,leaseId,intentId,intent.file_name,intent.mime,intent.size_bytes,sha,sealed,session.userId,session.sessionId])).rows[0];
    await client.query(`INSERT INTO app.settlement_evidence_links(org_id,lease_id,version_id,evidence_id,linked_by) VALUES($1,$2,$3,$4,$5)`,[session.orgId,leaseId,versionId,evidence.id,session.userId]);
    await client.query(`UPDATE app.settlement_upload_intents SET status='attached' WHERE id=$1`,[intentId]);
    await writeAudit(session.orgId,session.userId,"settlement_evidence_uploaded",{lease_id:leaseId,version_id:versionId,evidence_id:evidence.id,sha256:sha},client);
    await settlementDeadline(client,session,leaseId); return evidence.id;
  });
}
export async function discardSettlementUpload(session:Session,leaseId:string,versionId:string,intentId:string) {
  settlementUuid(intentId);
  return svc(session.userId,async client=>{
    await context(client,session,leaseId,versionId);
    const intent=await activeIntent(client,session,leaseId,versionId,intentId,false);
    if(intent.status!=="attached") await deleteHandoverObject(`${intent.storage_path}/sealed`);
    await deleteHandoverObject(intent.storage_path);
    await settlementDeadline(client,session,leaseId);
    if(intent.status!=="attached") await client.query(`UPDATE app.settlement_upload_intents SET status='discarded' WHERE id=$1`,[intentId]);
    await writeAudit(session.orgId,session.userId,"settlement_upload_cleanup_attempted",{lease_id:leaseId,version_id:versionId,intent_id:intentId},client);
    await settlementDeadline(client,session,leaseId);
  });
}
export async function readSettlementAttachment(session:Session,leaseId:string,versionId:string,evidenceId:string) {
  settlementUuid(evidenceId);
  return svc(session.userId,async client=>{
    await context(client,session,leaseId,versionId);
    const file=(await client.query<{storage_path:string;mime:string;size_bytes:number;sha256:string}>(`SELECT e.storage_path,e.mime,e.size_bytes,e.sha256 FROM app.settlement_evidence e JOIN app.settlement_evidence_links l ON l.org_id=e.org_id AND l.lease_id=e.lease_id AND l.evidence_id=e.id WHERE e.id=$1 AND e.org_id=$2 AND e.lease_id=$3 AND l.version_id=$4`,[evidenceId,session.orgId,leaseId,versionId])).rows[0];
    if(!file) throw new FlowError("errors.notFound");
    const bytes=await readHandoverObject(file.storage_path);
    if(handoverBytes(bytes,file.mime,file.size_bytes)!==file.sha256) throw new FlowError("errors.photoStorage");
    await settlementDeadline(client,session,leaseId);
    await writeAudit(session.orgId,session.userId,"settlement_evidence_read",{lease_id:leaseId,version_id:versionId,evidence_id:evidenceId},client);
    await settlementDeadline(client,session,leaseId); return {bytes,mime:file.mime};
  });
}
/** Current participant sees version-linked evidence and their own recoverable
 * intents. Private storage paths and service credentials are never returned. */
export async function listSettlementEvidence(session:Session,leaseId:string,versionId:string) {
  return svc(session.userId,async client=>{
    await context(client,session,leaseId,versionId);
    const files=(await client.query(`SELECT e.id,e.file_name,e.mime,e.size_bytes,e.uploaded_at,nullif(btrim(p.display_name),'') AS uploader_name FROM app.settlement_evidence_links l JOIN app.settlement_evidence e ON e.id=l.evidence_id AND e.org_id=l.org_id AND e.lease_id=l.lease_id LEFT JOIN public.profiles p ON p.id=e.uploaded_by WHERE l.org_id=$1 AND l.lease_id=$2 AND l.version_id=$3 ORDER BY e.uploaded_at,e.id`,[session.orgId,leaseId,versionId])).rows;
    const intents=(await client.query(`SELECT id,file_name,mime,size_bytes,status,(session_id=$5 AND status='pending' AND expires_at>clock_timestamp()) AS can_resume FROM app.settlement_upload_intents WHERE org_id=$1 AND lease_id=$2 AND version_id=$3 AND actor_id=$4 ORDER BY created_at,id`,[session.orgId,leaseId,versionId,session.userId,session.sessionId])).rows;
    await settlementDeadline(client,session,leaseId);return {files,intents};
  });
}

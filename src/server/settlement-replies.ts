import { writeAudit } from "./audit";
import { svc } from "./db";
import { FlowError } from "./errors";
import { settlementAccess, settlementDeadline, settlementRequestLock, settlementUuid } from "./settlement-access";
import { settlementPreviewOn, type SettlementPreviewInput } from "./settlement-preview";
import type { Session } from "./types";

/** A reply is only the signed-in participant's response to one version. */
export async function replySettlement(session:Session,input:{leaseId:string;versionId:string;response:"confirm"|"disagree";note:string;requestId:string}) {
  for(const id of [input.leaseId,input.versionId,input.requestId]) settlementUuid(id);
  const note=input.note.trim(); if(!["confirm","disagree"].includes(input.response) || note.length>2000) throw new FlowError("errors.required");
  return svc(session.userId,async client=>{
    await settlementAccess(client,session,input.leaseId,"read");
    await settlementRequestLock(client,session,input.leaseId,"reply",input.requestId);
    const prior=(await client.query<{id:string;version_id:string;actor_kind:string;response:string;note:string}>(`SELECT id,version_id,actor_kind,response,note FROM app.settlement_replies WHERE actor_id=$1 AND request_id=$2 AND org_id=$3 AND lease_id=$4`,[session.userId,input.requestId,session.orgId,input.leaseId])).rows[0];
    if(prior) {if(prior.version_id!==input.versionId || prior.actor_kind!==session.kind || prior.response!==input.response || prior.note!==note) throw new FlowError("errors.generic");await settlementDeadline(client,session,input.leaseId);return prior.id;}
    const version=(await client.query<{record_id:string;source_fingerprint:string;snapshot:{input:SettlementPreviewInput}}>(`SELECT record_id,source_fingerprint,snapshot FROM app.settlement_versions WHERE id=$1 AND org_id=$2 AND lease_id=$3 AND published`,[input.versionId,session.orgId,input.leaseId])).rows[0];
    if(!version) throw new FlowError("errors.notFound");
    const preview=await settlementPreviewOn(client,session,version.snapshot.input,{partyRead:true,lockParent:true,excludeOutcomeVersion:input.versionId});
    const current=(await client.query<{id:string}>(`SELECT id FROM app.settlement_versions WHERE record_id=$1 AND published ORDER BY revision DESC LIMIT 1`,[version.record_id])).rows[0];
    if(current?.id!==input.versionId || preview.fingerprint!==version.source_fingerprint || !preview.calculation.authoritative) throw new FlowError("errors.generic");
    const reply=(await client.query<{id:string}>(`INSERT INTO app.settlement_replies(org_id,lease_id,version_id,actor_id,actor_kind,response,note,request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,[session.orgId,input.leaseId,input.versionId,session.userId,session.kind,input.response,note,input.requestId])).rows[0];
    await writeAudit(session.orgId,session.userId,"settlement_replied",{lease_id:input.leaseId,version_id:input.versionId,reply_id:reply.id,response:input.response},client);
    await settlementDeadline(client,session,input.leaseId);return reply.id;
  });
}

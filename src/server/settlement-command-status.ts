import { svc } from "./db";
import { settlementAccess, settlementDeadline, settlementUuid } from "./settlement-access";
import type { Session } from "./types";
export type SettlementCommandKind="statement"|"attribution"|"reply"|"outcome"|"outcome_reply"|"upload"|"observation"|"cycle"|"line_binding";
/** Only the signed-in actor may recover their own operation result. */
export async function settlementCommandStatus(session:Session,leaseId:string,versionId:string|null,kind:SettlementCommandKind,requestId:string) {
  settlementUuid(leaseId);settlementUuid(requestId);if(versionId)settlementUuid(versionId);
  return svc(session.userId,async client=>{
    await settlementAccess(client,session,leaseId,kind==="cycle"?"publish":["attribution","observation","line_binding"].includes(kind)?"prepare":"read");
    let sql:string;
    switch(kind) {
      case "statement": sql=`SELECT id FROM app.settlement_versions WHERE org_id=$1 AND lease_id=$2 AND created_by=$3 AND request_id=$4 AND NOT (snapshot ? 'schema') AND (published OR $5::boolean)`;break;
      case "cycle": sql=`SELECT id FROM app.settlement_rent_cycles WHERE org_id=$1 AND lease_id=$2 AND asserted_by=$3 AND request_id=$4`;break;
      case "line_binding": sql=`SELECT id FROM app.settlement_line_bindings WHERE org_id=$1 AND lease_id=$2 AND created_by=$3 AND request_id=$4`;break;
      case "attribution": sql=`SELECT id FROM app.settlement_attributions WHERE org_id=$1 AND lease_id=$2 AND created_by=$3 AND request_id=$4`;break;
      case "reply": sql=`SELECT id FROM app.settlement_replies WHERE org_id=$1 AND lease_id=$2 AND actor_id=$3 AND request_id=$4 AND version_id=$5`;break;
      case "outcome": sql=`SELECT id FROM app.settlement_outcomes WHERE org_id=$1 AND lease_id=$2 AND reporter_id=$3 AND request_id=$4 AND version_id=$5`;break;
      case "observation": sql=`SELECT id FROM app.settlement_external_observations WHERE org_id=$1 AND lease_id=$2 AND reporter_id=$3 AND request_id=$4 AND version_id=$5`;break;
      case "upload": sql=`SELECT id,status AS upload_state FROM app.settlement_upload_intents WHERE org_id=$1 AND lease_id=$2 AND actor_id=$3 AND request_id=$4 AND version_id=$5`;break;
      case "outcome_reply": sql=`SELECT e.id FROM app.settlement_outcome_events e JOIN app.settlement_outcomes o ON o.id=e.outcome_id AND o.org_id=e.org_id AND o.lease_id=e.lease_id WHERE e.org_id=$1 AND e.lease_id=$2 AND e.actor_id=$3 AND e.request_id=$4 AND o.version_id=$5`;break;
      default: throw new Error("Invalid operation");
    }
    if(!["statement","attribution","cycle","line_binding"].includes(kind) && !versionId) throw new Error("Missing version");
    const params=[session.orgId,leaseId,session.userId,requestId,...(kind==="statement"?[session.kind==="staff"]:["attribution","cycle","line_binding"].includes(kind)?[]:[versionId])];
    const row=(await client.query<{id:string;upload_state?:string}>(sql,params)).rows[0];await settlementDeadline(client,session,leaseId);
    if(!row) return {status:"unknown" as const};
    if(kind==="upload" && row.upload_state==="pending") return {status:"pending" as const,id:row.id};
    return {status:"recorded" as const,id:row.id};
  });
}
/** Exact recovery for the empty-draft command; never treat another statement
 * using the same request ID as this draft. */
export async function recoverEmptySettlementDraft(session:Session,leaseId:string,expectedVersion:string|null,requestId:string) {
  settlementUuid(leaseId);settlementUuid(requestId);if(expectedVersion)settlementUuid(expectedVersion);
  return svc(session.userId,async client=>{
    await settlementAccess(client,session,leaseId,"prepare");
    const row=(await client.query<{id:string;published:boolean;snapshot:{schema?:unknown;input:{leaseId:string;attributionIds:string[];items:unknown[]};requestExpectedVersion:string|null}}>(`SELECT id,published,snapshot FROM app.settlement_versions WHERE org_id=$1 AND lease_id=$2 AND created_by=$3 AND request_id=$4`,[session.orgId,leaseId,session.userId,requestId])).rows[0];
    if(!row) {await settlementDeadline(client,session,leaseId);return null;}
    const input=row.snapshot?.input;
    if(row.published || row.snapshot.schema!==undefined || row.snapshot.requestExpectedVersion!==expectedVersion || !input || input.leaseId!==leaseId || !Array.isArray(input.attributionIds) || input.attributionIds.length || !Array.isArray(input.items) || input.items.length) throw new Error("Request does not match");
    await settlementDeadline(client,session,leaseId);return row.id;
  });
}

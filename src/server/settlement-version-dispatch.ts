import { svc } from "./db";
import { FlowError } from "./errors";
import { settlementAccess,settlementDeadline,settlementUuid } from "./settlement-access";
import { settlementV2HistoricalContext } from "./settlement-v2-context";
import { loadV2Unknown } from "./settlement-v2-staff";
import { readSettlement } from "./settlement-statement";
import type { Session } from "./types";

/** Unwired version-aware reader. Legacy continues through its original
 * evaluator; v2 UNKNOWN drafts use the staff-only stored-projection loader. */
export async function readSettlementVersion(session:Session,leaseId:string,versionId:string) {
 settlementUuid(leaseId);settlementUuid(versionId);
 const tag=await svc(session.userId,async client=>{
  if(session.kind==="staff")await settlementV2HistoricalContext(client,session,leaseId);else await settlementAccess(client,session,leaseId,"read");
  const row=(await client.query<{schema:string|null;has_schema:boolean;published:boolean}>(`SELECT snapshot->>'schema' AS schema,snapshot ? 'schema' AS has_schema,published FROM app.settlement_versions WHERE org_id=$1 AND lease_id=$2 AND id=$3`,[session.orgId,leaseId,versionId])).rows[0];
  if(!row||(!row.published&&session.kind!=="staff"))throw new FlowError("errors.notFound");await settlementDeadline(client,session,leaseId);return {schema:row.schema,hasSchema:row.has_schema};
 });
 if(!tag.hasSchema)return {schema:"legacy" as const,view:await readSettlement(session,leaseId,versionId)};
 if(tag.schema==="settlement-v2"&&session.kind==="staff")return {schema:"settlement-v2" as const,view:await loadV2Unknown(session,leaseId,versionId)};
 throw new FlowError("errors.notFound");
}

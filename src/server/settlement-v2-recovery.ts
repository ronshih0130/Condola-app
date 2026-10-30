import { svc } from "./db";
import { FlowError } from "./errors";
import { settlementDeadline,settlementRequestLock,settlementUuid } from "./settlement-access";
import { settlementV2HistoricalContext } from "./settlement-v2-context";
import { normalizeSettlementInput,type SettlementPreviewInput } from "./settlement-preview";
import { requireOpenStatementRequest } from "./settlement-terminal";
import { validateV2UnknownSnapshot,assertV2Scope } from "./settlement-v2-schema";
import type { Session } from "./types";

/** Recovers only an already-committed own v2 UNKNOWN draft, even if rollout is
 * now off. This path cannot issue commands or assert source freshness. */
export async function recoverV2UnknownDraft(session:Session,input:SettlementPreviewInput,expectedFingerprint:string,expectedVersion:string|null,requestId:string) {
  const normalized=normalizeSettlementInput(input);settlementUuid(requestId);if(expectedVersion!==null)settlementUuid(expectedVersion);if(!/^[a-f0-9]{64}$/.test(expectedFingerprint))throw new FlowError("errors.required");
  return svc(session.userId,async client=>{
    await settlementV2HistoricalContext(client,session,input.leaseId);await settlementRequestLock(client,session,input.leaseId,"statement",requestId);await requireOpenStatementRequest(client,session,input.leaseId,requestId);
    const row=(await client.query<{id:string;published:boolean;source_fingerprint:string;snapshot:{schema?:string;input?:SettlementPreviewInput;requestExpectedVersion?:string|null;calculation?:{authoritative?:boolean}}}>(`SELECT id,published,source_fingerprint,snapshot FROM app.settlement_versions WHERE org_id=$1 AND lease_id=$2 AND created_by=$3 AND request_id=$4`,[session.orgId,input.leaseId,session.userId,requestId])).rows[0];
    if(!row){await settlementDeadline(client,session,input.leaseId);return null;}
    if(row.published)throw new FlowError("errors.generic");const validated=validateV2UnknownSnapshot(row.snapshot);assertV2Scope(validated.scope,session,input.leaseId,session.userId,requestId);if(validated.requestExpectedVersion!==expectedVersion||row.source_fingerprint!==expectedFingerprint||JSON.stringify(validated.input)!==JSON.stringify(normalized))throw new FlowError("errors.generic");
    await settlementDeadline(client,session,input.leaseId);return {id:row.id,recovered:true as const,freshness:"unavailable" as const};
  });
}

/** Exact empty-draft command recovery. The source fingerprint is server-owned
 * and need not be reconstructed after an uncertain response. */
export async function recoverEmptyV2UnknownDraft(session:Session,leaseId:string,expectedVersion:string|null,requestId:string) {
 settlementUuid(leaseId);settlementUuid(requestId);if(expectedVersion!==null)settlementUuid(expectedVersion);
 return svc(session.userId,async client=>{
  await settlementV2HistoricalContext(client,session,leaseId);await settlementRequestLock(client,session,leaseId,"statement",requestId);await requireOpenStatementRequest(client,session,leaseId,requestId);
  const row=(await client.query<{id:string;published:boolean;snapshot:unknown}>(`SELECT id,published,snapshot FROM app.settlement_versions WHERE org_id=$1 AND lease_id=$2 AND created_by=$3 AND request_id=$4`,[session.orgId,leaseId,session.userId,requestId])).rows[0];
  if(!row){await settlementDeadline(client,session,leaseId);return null;}if(row.published)throw new FlowError("errors.generic");
  const validated=validateV2UnknownSnapshot(row.snapshot);assertV2Scope(validated.scope,session,leaseId,session.userId,requestId);if(validated.requestExpectedVersion!==expectedVersion||validated.input.leaseId!==leaseId||validated.input.attributionIds.length||validated.input.items.length||validated.input.sourceReview!==null)throw new FlowError("errors.generic");
  await settlementDeadline(client,session,leaseId);return {id:row.id,recovered:true as const,freshness:"unavailable" as const};
 });
}

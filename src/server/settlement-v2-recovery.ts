import { svc } from "./db";
import { FlowError } from "./errors";
import { settlementDeadline,settlementRequestLock,settlementUuid } from "./settlement-access";
import { settlementV2HistoricalContext } from "./settlement-v2-context";
import { normalizeSettlementInput,type SettlementPreviewInput } from "./settlement-preview";
import type { Session } from "./types";

/** Recovers only an already-committed own v2 UNKNOWN draft, even if rollout is
 * now off. This path cannot issue commands or assert source freshness. */
export async function recoverV2UnknownDraft(session:Session,input:SettlementPreviewInput,expectedFingerprint:string,expectedVersion:string|null,requestId:string) {
  const normalized=normalizeSettlementInput(input);settlementUuid(requestId);if(expectedVersion!==null)settlementUuid(expectedVersion);if(!/^[a-f0-9]{64}$/.test(expectedFingerprint))throw new FlowError("errors.required");
  return svc(session.userId,async client=>{
    await settlementV2HistoricalContext(client,session,input.leaseId);await settlementRequestLock(client,session,input.leaseId,"statement",requestId);
    const row=(await client.query<{id:string;published:boolean;source_fingerprint:string;snapshot:{schema?:string;input?:SettlementPreviewInput;requestExpectedVersion?:string|null;calculation?:{authoritative?:boolean}}}>(`SELECT id,published,source_fingerprint,snapshot FROM app.settlement_versions WHERE org_id=$1 AND lease_id=$2 AND created_by=$3 AND request_id=$4`,[session.orgId,input.leaseId,session.userId,requestId])).rows[0];
    if(!row){await settlementDeadline(client,session,input.leaseId);return null;}
    if(row.published||row.snapshot.schema!=="settlement-v2"||row.snapshot.calculation?.authoritative!==false||!row.snapshot.input||row.snapshot.requestExpectedVersion!==expectedVersion||row.source_fingerprint!==expectedFingerprint||JSON.stringify(normalizeSettlementInput(row.snapshot.input))!==JSON.stringify(normalized))throw new FlowError("errors.generic");
    await settlementDeadline(client,session,input.leaseId);return {id:row.id,recovered:true as const,freshness:"unavailable" as const};
  });
}

import type { Client } from "pg";
import { FlowError } from "./errors";
import type { Session } from "./types";
export type StatementTerminal={state:"unresolved"|"busy"|"closed"}|{state:"recorded";id:string};
/** Fixed server gateway; caller must use current verified staff context. */
export async function statementTerminalOn(client:Client,session:Session,leaseId:string,requestId:string,close:boolean):Promise<StatementTerminal> {
 const result=(await client.query<{result:unknown}>(`SELECT app.settlement_statement_terminal($1,$2,$3,$4,$5,$6,$7) AS result`,[session.orgId,session.liveOrgId,session.environment,leaseId,session.sessionId,requestId,close])).rows[0]?.result;
 if(!result||typeof result!=="object"||Array.isArray(result))throw new FlowError("errors.generic");const value=result as {state?:unknown;id?:unknown};
 if(value.state==="recorded"&&typeof value.id==="string")return {state:"recorded",id:value.id};
 if(value.state==="unresolved"||value.state==="busy"||value.state==="closed")return {state:value.state};throw new FlowError("errors.generic");
}
export async function requireOpenStatementRequest(client:Client,session:Session,leaseId:string,requestId:string) {
 const terminal=await statementTerminalOn(client,session,leaseId,requestId,false);if(terminal.state==="closed"||terminal.state==="busy")throw new FlowError("errors.generic");return terminal;
}

/** Internal bounded status/close gateway. It returns a recorded ID only after
 * validating the immutable v2 snapshot and its actual row identity. The caller
 * must retain the same request ID if the transaction outcome is uncertain. */
export async function resolveStatementTerminal(session:Session,leaseId:string,requestId:string,close:boolean):Promise<StatementTerminal> {
 const { settlementUuid }=await import("./settlement-access");
 const { settlementV2HistoricalContext }=await import("./settlement-v2-context");
 const { withSettlementFencePrototype }=await import("./settlement-fenced-transaction");
 const { validateV2UnknownSnapshot,assertV2Scope }=await import("./settlement-v2-schema");
 const { v2FinalDeadline }=await import("./settlement-v2-preview");
 settlementUuid(leaseId);settlementUuid(requestId);if(typeof close!=="boolean")throw new FlowError("errors.required");let terminal:StatementTerminal;
 return withSettlementFencePrototype(session.userId,async client=>{
  await settlementV2HistoricalContext(client,session,leaseId);terminal=await statementTerminalOn(client,session,leaseId,requestId,close);
  if(terminal.state==="recorded"){
   const row=(await client.query<{snapshot:unknown;published:boolean;created_by:string;request_id:string}>(`SELECT snapshot,published,created_by,request_id FROM app.settlement_versions WHERE id=$1 AND org_id=$2 AND lease_id=$3 AND created_by=$4 AND request_id=$5`,[terminal.id,session.orgId,leaseId,session.userId,requestId])).rows[0];
   if(!row||row.published)throw new FlowError("errors.notFound");const valid=validateV2UnknownSnapshot(row.snapshot);assertV2Scope(valid.scope,session,leaseId,row.created_by,row.request_id);
  }
 },async()=>terminal,query=>v2FinalDeadline(query,session));
}

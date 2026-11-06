import { guardEffectiveSession } from "@/server/b017-custom-role-governance";
import { withClient } from "./db";
import { mapDbError } from "./errors";
import { isUuid } from "./repair-rules";
import { hashVendorToken, vendorTokenAcceptable } from "./vendor-repair-rules";
import type { Session } from "./types";
import type { Client } from "pg";

export type CenterKind = "rent_due" | "rent_overdue" | "rent_manual" | "payment_confirmed" | "payment_rejected" | "payment_reversed" | "vendor_job_assigned";
export type CenterItem = { recipient_id:string; kind:CenterKind; occurred_at:string; read_at:string|null };
export type CenterAdmission = "enabled" | "disabled" | "busy" | "denied";
export class CenterBusyError extends Error { constructor(){super("Notification temporarily unavailable");} }
export class CenterDeniedError extends Error { constructor(){super("Notification unavailable");} }
const signature="app.b028_center_session_enabled(uuid,uuid,text,uuid,text,text)";
function args(session:Session) {
  if (!["staff","tenant","owner"].includes(session.kind) || !isUuid(session.sessionId) || session.needsSandbox) throw new CenterDeniedError();
  return [session.orgId,session.liveOrgId,session.environment,session.sessionId,session.kind,session.role];
}
type Attempt<T>={kind:"ok";value:T}|{kind:"busy"}|{kind:"denied"};
/** Center-only: every retry uses a fresh transaction and the real gateway reauthorizes. */
async function centerCall<T>(userId:string|null, query:(client:Client)=>Promise<T>):Promise<Attempt<T>> {
  for(let attempt=0;attempt<2;attempt++) {
    const result=await withClient(async client=>{
      let begun=false,committing=false,gatewayStarted=false;
      try {
        await client.query("BEGIN"); begun=true;
        if(userId) await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','service_role',true)`,[userId]);
        else await client.query(`SELECT set_config('request.jwt.claim.role','service_role',true)`);
        await client.query("SET LOCAL ROLE service_role");
        gatewayStarted=true; const value=await query(client);
        committing=true; await client.query("COMMIT"); begun=false;
        return {kind:"ok",value} as const;
      } catch(error) {
        if(begun) {
          try { await client.query("ROLLBACK"); } catch(rollbackError) { throw mapDbError(rollbackError); }
        }
        const code=typeof error==="object" && error!==null && "code" in error ? (error as {code?:unknown}).code : undefined;
        if(begun && gatewayStarted && !committing && code==="55P03") return {kind:"busy"} as const;
        if(begun && gatewayStarted && !committing && code==="42501" && error instanceof Error && error.message==="Notification unavailable") return {kind:"denied"} as const;
        throw mapDbError(error);
      }
    });
    if(result.kind!=="busy" || attempt===1) return result;
  }
  throw new Error("Notification unavailable");
}
export async function centerSessionAdmission(session:Session):Promise<CenterAdmission> {
  session = await guardEffectiveSession(session, null);
  let parameters:unknown[];
  try {parameters=args(session);} catch(error) {if(error instanceof CenterDeniedError) return "denied"; throw error;}
  const result=await centerCall(session.userId,async c=>{
    if (!(await c.query<{ok:boolean}>(`SELECT to_regprocedure($1) IS NOT NULL AS ok`,[signature])).rows[0].ok) return false;
    return (await c.query<{enabled:boolean}>(`SELECT app.b028_center_session_enabled($1,$2,$3,$4,$5,$6) AS enabled`,parameters)).rows[0].enabled;
  });
  return result.kind==="ok" ? (result.value ? "enabled" : "disabled") : result.kind;
}
export async function centerSessionEnabled(session:Session) {
  const state=await centerSessionAdmission(session); if(state==="busy") throw new CenterBusyError(); return state==="enabled";
}
export type CenterPage = {items:CenterItem[]; continuation:string|null};
type CenterRow = {recipient_id:string|null; kind:CenterKind|null; occurred_at:string|null; read_at:string|null; continuation:string|null};
function page(rows:CenterRow[]):CenterPage {
  return {items:rows.filter((r):r is CenterRow & CenterItem=>Boolean(r.recipient_id && r.kind && r.occurred_at)),continuation:rows.find(r=>r.continuation)?.continuation ?? null};
}
export async function centerSessionItems(session:Session, mark:string|null=null,cursor?:string) {
  session = await guardEffectiveSession(session, null);
  if ((mark !== null && !isUuid(mark)) || (cursor && !isUuid(cursor))) throw new CenterDeniedError();
  const parameters=args(session);
  const result=await centerCall(session.userId,async c=>page((await c.query<CenterRow>(`SELECT recipient_id::text,kind,occurred_at::text,read_at::text,continuation::text FROM app.b028_center_session($1,$2,$3,$4,$5,$6,$7,$8)`,[...parameters,mark,cursor ?? null])).rows));
  if(result.kind==="busy") throw new CenterBusyError(); if(result.kind==="denied") throw new CenterDeniedError(); return result.value;
}
export async function centerVendorAdmission(token:string):Promise<CenterAdmission> {
  if (!vendorTokenAcceptable(token)) return "denied";
  const result=await centerCall(null,async c=>{
    if (!(await c.query<{ok:boolean}>(`SELECT to_regprocedure('app.b028_center_vendor_enabled(text)') IS NOT NULL AS ok`)).rows[0].ok) return false;
    return (await c.query<{enabled:boolean}>(`SELECT app.b028_center_vendor_enabled($1) AS enabled`,[hashVendorToken(token)])).rows[0].enabled;
  });
  return result.kind==="ok" ? (result.value ? "enabled" : "disabled") : result.kind;
}
export async function centerVendorEnabled(token:string) {
  const state=await centerVendorAdmission(token); if(state==="busy") throw new CenterBusyError(); return state==="enabled";
}
export async function centerVendorItems(token:string, mark:string|null=null,cursor?:string) {
  if (!vendorTokenAcceptable(token) || (mark!==null && !isUuid(mark)) || (cursor && !isUuid(cursor))) throw new CenterDeniedError();
  const result=await centerCall(null,async c=>page((await c.query<CenterRow>(`SELECT recipient_id::text,kind,occurred_at::text,read_at::text,continuation::text FROM app.b028_center_vendor($1,$2,$3)`,[hashVendorToken(token),mark,cursor ?? null])).rows));
  if(result.kind==="busy") throw new CenterBusyError(); if(result.kind==="denied") throw new CenterDeniedError(); return result.value;
}

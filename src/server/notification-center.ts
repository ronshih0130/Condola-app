import { svc } from "./db";
import { isUuid } from "./repair-rules";
import { hashVendorToken, vendorTokenAcceptable } from "./vendor-repair-rules";
import type { Session } from "./types";

export type CenterKind = "rent_due" | "rent_overdue" | "rent_manual" | "payment_confirmed" | "payment_rejected" | "payment_reversed" | "vendor_job_assigned";
export type CenterItem = { recipient_id:string; kind:CenterKind; occurred_at:string; read_at:string|null };
const signature="app.b028_center_session_enabled(uuid,uuid,text,uuid,text,text)";
function args(session:Session) {
  if (!["staff","tenant","owner"].includes(session.kind) || !isUuid(session.sessionId) || session.needsSandbox) throw new Error("Notification unavailable");
  return [session.orgId,session.liveOrgId,session.environment,session.sessionId,session.kind,session.role];
}
export async function centerSessionEnabled(session:Session) {
  try { return await svc(session.userId,async c=>{
    if (!(await c.query<{ok:boolean}>(`SELECT to_regprocedure($1) IS NOT NULL AS ok`,[signature])).rows[0].ok) return false;
    return (await c.query<{enabled:boolean}>(`SELECT app.b028_center_session_enabled($1,$2,$3,$4,$5,$6) AS enabled`,args(session))).rows[0].enabled;
  }); } catch { return false; }
}
export type CenterPage = {items:CenterItem[]; continuation:string|null};
type CenterRow = {recipient_id:string|null; kind:CenterKind|null; occurred_at:string|null; read_at:string|null; continuation:string|null};
function page(rows:CenterRow[]):CenterPage {
  return {items:rows.filter((r):r is CenterRow & CenterItem=>Boolean(r.recipient_id && r.kind && r.occurred_at)),continuation:rows.find(r=>r.continuation)?.continuation ?? null};
}
export async function centerSessionItems(session:Session, mark:string|null=null,cursor?:string) {
  if ((mark !== null && !isUuid(mark)) || (cursor && !isUuid(cursor))) throw new Error("Notification unavailable");
  return svc(session.userId,async c=>page((await c.query<CenterRow>(`SELECT recipient_id::text,kind,occurred_at::text,read_at::text,continuation::text FROM app.b028_center_session($1,$2,$3,$4,$5,$6,$7,$8)`,[...args(session),mark,cursor ?? null])).rows));
}
export async function centerVendorEnabled(token:string) {
  if (!vendorTokenAcceptable(token)) return false;
  try {return await svc(null,async c=>{
    if (!(await c.query<{ok:boolean}>(`SELECT to_regprocedure('app.b028_center_vendor_enabled(text)') IS NOT NULL AS ok`)).rows[0].ok) return false;
    return (await c.query<{enabled:boolean}>(`SELECT app.b028_center_vendor_enabled($1) AS enabled`,[hashVendorToken(token)])).rows[0].enabled;
  });} catch {return false;}
}
export async function centerVendorItems(token:string, mark:string|null=null,cursor?:string) {
  if (!vendorTokenAcceptable(token) || (mark!==null && !isUuid(mark)) || (cursor && !isUuid(cursor))) throw new Error("Notification unavailable");
  return svc(null,async c=>page((await c.query<CenterRow>(`SELECT recipient_id::text,kind,occurred_at::text,read_at::text,continuation::text FROM app.b028_center_vendor($1,$2,$3)`,[hashVendorToken(token),mark,cursor ?? null])).rows));
}

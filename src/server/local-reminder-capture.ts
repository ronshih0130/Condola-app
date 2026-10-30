import { createHash } from "node:crypto";
import type { Session } from "./types";
import { svc } from "./db";
import { moneyLabel } from "./format";

export type LocalReminder = { to: string; subject: string; text: string };
export type LocalCapture = (message: LocalReminder) => void;
type Claimed = { claim_id:string; claim_token:string; email:string; recipient_name:string; locale:string; due_date:string; balance_minor:string; currency:string; firm_name:string; recipient_kind?:string };

/** This adapter only prepares an in-memory test record. It has no provider or
 * network dependency; its digest records local preparation, not delivery. */
export function renderLocalReminder(row: Claimed): LocalReminder {
  const english=row.locale === "en";
  const minor=Number(row.balance_minor);
  if (!Number.isSafeInteger(minor) || minor <= 0) throw new Error("Reminder unavailable");
  const amount=moneyLabel(minor,row.currency,english ? "en" : "zh-TW");
  const staff=row.recipient_kind === "staff";
  return english
    ? {to:row.email,subject:"Rent bill reminder",text:`${row.recipient_name}, ${row.firm_name}: bill due ${row.due_date}; outstanding ${amount}. ${staff ? "View the rent overview." : "View your bill in the tenant portal."}`}
    : {to:row.email,subject:"租金帳單提醒",text:`${row.recipient_name}，${row.firm_name}：帳單到期日 ${row.due_date}，尚有 ${amount}。${staff ? "請至租金總覽查看帳單。" : "請至租客頁查看帳單。"}`};
}

export async function captureManualReminders(session: Session, leaseId: string, eventId: string, capture: LocalCapture = () => {}) {
  if (session.kind !== "staff" || !["admin","manager"].includes(session.role ?? "") || session.needsSandbox) throw new Error("Reminder unavailable");
  let completed=0;
  const processed:string[]=[];
  // A bound makes a large recipient list resumable rather than an unbounded request.
  for (let n=0;n<100;n++) {
    const outcome=await svc(session.userId,async (c) => {
      const args=[session.orgId,session.liveOrgId,session.environment,session.sessionId,leaseId,eventId];
      const row=(await c.query<Claimed>(`SELECT * FROM app.b028_claim_manual($1,$2,$3,$4,$5,$6,$7)`,[...args,processed])).rows[0];
      if (!row) return {state:"empty" as const};
      let digest:string | null=null;
      try {
        const message=renderLocalReminder(row);
        capture(message);
        digest=createHash("sha256").update(JSON.stringify(message)).digest("hex");
      } catch { /* Record the local failure without storing the content. */ }
      await c.query(`SELECT app.b028_finish_manual($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[...args,row.claim_id,row.claim_token,digest]);
      return {state:digest ? "captured" as const : "failed" as const, claimId:row.claim_id};
    });
    if (outcome.state === "empty") break;
    processed.push(outcome.claimId);
    if (outcome.state === "captured") completed++;
  }
  return completed;
}


export async function captureScheduledReminders(orgId:string,eventId:string,at:Date,capture:LocalCapture=()=>{}) {
  if (!Number.isFinite(at.getTime())) throw new Error("Reminder time unavailable");
  let completed=0;
  const processed:string[]=[];
  for (let n=0;n<100;n++) {
    const outcome=await svc(null,async (c)=>{
      const row=(await c.query<Claimed>(`SELECT * FROM app.b028_claim_scheduled($1,$2,$3,$4)`,[orgId,eventId,processed,at.toISOString()])).rows[0];
      if (!row) return {state:"empty" as const};
      let digest:string | null=null;
      try { const message=renderLocalReminder(row); capture(message); digest=createHash("sha256").update(JSON.stringify(message)).digest("hex"); } catch { /* Keep failure scoped to this recipient. */ }
      await c.query(`SELECT app.b028_finish_scheduled($1,$2,$3,$4)`,[orgId,row.claim_id,row.claim_token,digest]);
      return {state:digest ? "captured" as const : "failed" as const,claimId:row.claim_id};
    });
    if (outcome.state === "empty") break;
    processed.push(outcome.claimId);
    if (outcome.state === "captured") completed++;
  }
  return completed;
}

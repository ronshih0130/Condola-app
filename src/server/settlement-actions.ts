"use server";
import { revalidatePath } from "next/cache";
import { requireCurrentConsent } from "./consent-gate";
import { recoverEmptySettlementDraft, settlementCommandStatus, type SettlementCommandKind } from "./settlement-command-status";
import { setDepositAttribution } from "./settlement-attribution";
import { shareHandoverEvidence } from "./settlement-attachments";
import { observeExternalOutcome, reportSettlementOutcome, replySettlementOutcome } from "./settlement-outcomes";
import { previewSettlement, type SettlementPreviewInput } from "./settlement-preview";
import { replySettlement } from "./settlement-replies";
import { previewFinalRent } from "./settlement-rent-quote";
import { saveSettlement } from "./settlement-statement";
import { getSession } from "./session";
function refresh(lease:string) {for(const prefix of ["m","t","o"]) revalidatePath(`/${prefix}/settlement/${lease}`);}
function amount(value:FormDataEntryValue|null) {
  const text=String(value??"").trim(); if(!/^\d{1,13}(\.\d{1,2})?$/.test(text)) throw new Error("Invalid amount");
  const [whole,decimal=""]=text.split("."); const result=BigInt(whole)*BigInt(100)+BigInt(decimal.padEnd(2,"0"));
  if(result>BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Invalid amount");return Number(result);
}
export async function createSettlementDraftAction(leaseId:string,expectedVersion:string|null,requestId:string) {
  await requireCurrentConsent(); const session=await getSession();
  try {const existing=await recoverEmptySettlementDraft(session,leaseId,expectedVersion,requestId);if(existing)return {ok:true as const,id:existing};const input={leaseId,attributionIds:[],items:[]};const preview=await previewSettlement(session,input);const result=await saveSettlement(session,input,preview.fingerprint,expectedVersion,requestId,false);refresh(leaseId);return {ok:true as const,id:result.id};}catch{return {ok:false as const};}
}
export async function shareSettlementHandoverAction(leaseId:string,versionId:string,attachmentId:string) {
  await requireCurrentConsent();const session=await getSession();
  try {await shareHandoverEvidence(session,leaseId,versionId,attachmentId);refresh(leaseId);return {ok:true as const};}catch{return {ok:false as const};}
}
export async function attributeSettlementAction(leaseId:string,form:FormData) {
  await requireCurrentConsent();const session=await getSession();
  try {
    const kind=String(form.get("kind"));const source=kind==="payment" ? {kind:"payment" as const,paymentId:String(form.get("paymentId")??"")} : {kind:"external" as const,identity:String(form.get("identity")??""),declaredMinor:amount(form.get("declared"))};
    await setDepositAttribution(session,{leaseId,evidenceId:String(form.get("evidenceId")??""),requestId:String(form.get("requestId")??""),expectedAttributionId:String(form.get("expectedId")??"")||null,amountMinor:amount(form.get("amount")),reason:String(form.get("reason")??""),source});
    refresh(leaseId);return {ok:true as const};
  }catch{return {ok:false as const};}
}
export async function previewSettlementAction(input:SettlementPreviewInput) {
  await requireCurrentConsent();const session=await getSession();
  try {const result=await previewSettlement(session,input);return {ok:true as const,fingerprint:result.fingerprint,calculation:result.calculation,reconciliationRequired:result.reconciliationRequired};}catch{return {ok:false as const};}
}
export async function saveSettlementAction(input:SettlementPreviewInput,fingerprint:string,expectedVersion:string|null,requestId:string,publish:boolean) {
  await requireCurrentConsent();const session=await getSession();
  try {const result=await saveSettlement(session,input,fingerprint,expectedVersion,requestId,publish);refresh(input.leaseId);return {ok:true as const,...result};}catch{return {ok:false as const};}
}
export async function replySettlementAction(leaseId:string,versionId:string,form:FormData) {
  await requireCurrentConsent();const session=await getSession();
  try {const response=String(form.get("response"));if(response!=="confirm"&&response!=="disagree")throw new Error("Invalid reply");await replySettlement(session,{leaseId,versionId,response,note:String(form.get("note")??""),requestId:String(form.get("requestId")??"")});refresh(leaseId);return {ok:true as const};}catch{return {ok:false as const};}
}
export async function reportSettlementAction(leaseId:string,versionId:string,form:FormData) {
  await requireCurrentConsent();const session=await getSession();
  try {const direction=String(form.get("direction"));const [kind,payeeId]=String(form.get("payee")??"").split(":");if((direction!=="refund"&&direction!=="top_up")||(kind!=="staff"&&kind!=="tenant"&&kind!=="owner"))throw new Error("Invalid party");const reconciliations=form.getAll("reconcile").map(value=>{const [entryKind,id]=String(value).split(":");if(entryKind!=="outcome"&&entryKind!=="observation")throw new Error("Invalid source");return {kind:entryKind as "outcome"|"observation",id,reason:String(form.get(`reason:${entryKind}:${id}`)??""),evidenceId:String(form.get(`evidence:${entryKind}:${id}`)??"")};});const result=await reportSettlementOutcome(session,{leaseId,versionId,direction,amountMinor:amount(form.get("amount")),occurredOn:String(form.get("date")??""),payeeId,payeeKind:kind,evidenceId:String(form.get("evidenceId")??""),requestId:String(form.get("requestId")??""),reconciliations});refresh(leaseId);return {ok:true as const,...result};}catch{return {ok:false as const};}
}
export async function replyOutcomeAction(leaseId:string,outcomeId:string,form:FormData) {
  await requireCurrentConsent();const session=await getSession();
  try {const event=String(form.get("event"));if(event!=="acknowledged"&&event!=="disputed"&&event!=="withdrawn"&&event!=="external_reviewed")throw new Error("Invalid reply");const result=await replySettlementOutcome(session,{leaseId,outcomeId,event,note:String(form.get("note")??""),evidenceId:String(form.get("evidenceId")??"")||null,expectedLastEventId:String(form.get("expectedId")??"")||null,requestId:String(form.get("requestId")??"")});refresh(leaseId);return {ok:true as const,...result};}catch{return {ok:false as const};}
}
export async function observeSettlementAction(leaseId:string,versionId:string,form:FormData) {
  await requireCurrentConsent();const session=await getSession();
  try {const direction=String(form.get("direction")),[payerKind,payerId]=String(form.get("payer")??"").split(":"),[payeeKind,payeeId]=String(form.get("payee")??"").split(":");if((direction!=="refund"&&direction!=="top_up")||!["staff","tenant","owner"].includes(payerKind)||!["staff","tenant","owner"].includes(payeeKind))throw new Error("Invalid party");const result=await observeExternalOutcome(session,{leaseId,versionId,direction,amountMinor:amount(form.get("amount")),occurredOn:String(form.get("date")??""),payerId,payerKind:payerKind as "staff"|"tenant"|"owner",payeeId,payeeKind:payeeKind as "staff"|"tenant"|"owner",evidenceId:String(form.get("evidenceId")??""),reason:String(form.get("reason")??""),requestId:String(form.get("requestId")??"")});refresh(leaseId);return {ok:true as const,...result};}catch{return {ok:false as const};}
}
export async function quoteFinalRentAction(leaseId:string,form:FormData) {
  await requireCurrentConsent();const session=await getSession();
  try {const quote=await previewFinalRent(session,{leaseId,agreedPeriodStart:String(form.get("start")??""),agreedPeriodEnd:String(form.get("end")??""),evidenceId:String(form.get("evidenceId")??""),fullPeriodAsserted:form.get("asserted")==="on"});return {ok:true as const,quote:quote.quote,reconciliationRequired:quote.reconciliationRequired};}catch{return {ok:false as const};}
}

export async function settlementCommandStatusAction(leaseId:string,versionId:string|null,kind:SettlementCommandKind,requestId:string) {
  await requireCurrentConsent();const session=await getSession();
  try{return {ok:true as const,...await settlementCommandStatus(session,leaseId,versionId,kind,requestId)};}catch{return {ok:false as const};}
}

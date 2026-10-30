"use server";
import { revalidatePath } from "next/cache";
import { requireCurrentConsent } from "./consent-gate";
import { getSession } from "./session";
import type { SettlementPreviewInput } from "./settlement-preview";
import { previewV2Unknown } from "./settlement-v2-preview";
import { saveV2Unknown } from "./settlement-v2-staff";
import { createV2EmptyCommand } from "./settlement-v2-empty-command";

/** Unwired staff draft actions. Publishing and party actions are unsupported. */
export async function createV2UnknownDraftAction(leaseId:string,expectedVersion:string|null,requestId:string) {
 await requireCurrentConsent();const session=await getSession();
 const result=await createV2EmptyCommand(session,leaseId,expectedVersion,requestId);if(result.ok)revalidatePath(`/m/settlement/${leaseId}`);return result;
}
export async function previewV2UnknownAction(input:SettlementPreviewInput) {
 await requireCurrentConsent();const session=await getSession();
 try{const preview=await previewV2Unknown(session,input);if(preview.state!=="unknown")return {ok:false as const};return {ok:true as const,fingerprint:preview.fingerprint,calculation:preview.calculation,reconciliationRequired:true as const};}catch{return {ok:false as const};}
}
export async function saveV2UnknownAction(input:SettlementPreviewInput,fingerprint:string,expectedVersion:string|null,requestId:string,publish:boolean) {
 await requireCurrentConsent();const session=await getSession();
 try{if(publish!==false)return {ok:false as const};const saved=await saveV2Unknown(session,input,fingerprint,expectedVersion,requestId);revalidatePath(`/m/settlement/${input.leaseId}`);return {ok:true as const,...saved};}catch{return {ok:false as const};}
}

/** Unwired recovery action. Unknown failures retain the original request ID. */
export async function resolveV2StatementAction(leaseId:string,requestId:string,close:boolean) {
 await requireCurrentConsent();const session=await getSession();
 try{if(typeof close!=="boolean")return {ok:false as const};const { resolveStatementTerminal }=await import("./settlement-terminal");return {ok:true as const,...await resolveStatementTerminal(session,leaseId,requestId,close)};}catch{return {ok:false as const};}
}

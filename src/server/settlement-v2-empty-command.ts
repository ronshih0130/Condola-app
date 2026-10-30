import { previewV2Unknown } from "./settlement-v2-preview";
import { saveV2Unknown } from "./settlement-v2-staff";
import { recoverEmptyV2UnknownDraft } from "./settlement-v2-recovery";
import type { Session } from "./types";

/** Execute one staff empty-draft command, retaining the same request key on
 * uncertain failure. The action must authorize consent before calling this. */
export async function createV2EmptyCommand(session:Session,leaseId:string,expectedVersion:string|null,requestId:string) {
 try {
  const prior=await recoverEmptyV2UnknownDraft(session,leaseId,expectedVersion,requestId);if(prior)return {ok:true as const,id:prior.id};
  const input={leaseId,attributionIds:[],items:[]},preview=await previewV2Unknown(session,input);if(preview.state!=="unknown")return {ok:false as const};
  const saved=await saveV2Unknown(session,input,preview.fingerprint,expectedVersion,requestId);return {ok:true as const,id:saved.id};
 }catch{
  try{const prior=await recoverEmptyV2UnknownDraft(session,leaseId,expectedVersion,requestId);if(prior)return {ok:true as const,id:prior.id};}catch{}
  return {ok:false as const};
 }
}

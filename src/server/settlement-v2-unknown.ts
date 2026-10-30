import { createHash } from "node:crypto";
import { normalizeSettlementInput,type SettlementPreviewInput } from "./settlement-preview";

/** Pure internal encoding only. The caller must obtain source and prior outcomes
 * in the same authorized transaction; this function grants no authority. */
type CompleteSource = { fingerprint:string; verifiedCandidate:boolean; reason?:string } | { verifiedCandidate:false; reason:string };
type Json = null|boolean|number|string|Json[]|{[key:string]:Json};
function canonical(value:Json):string {
  if(value===null||typeof value==="string"||typeof value==="boolean")return JSON.stringify(value);
  if(typeof value==="number"){if(!Number.isFinite(value))throw new TypeError("Invalid canonical value");return JSON.stringify(value);}
  if(typeof value!=="object")throw new TypeError("Invalid canonical value");
  if(Array.isArray(value)){if(Object.getOwnPropertySymbols(value).length||Object.keys(value).length!==value.length||Object.getOwnPropertyNames(value).length!==value.length+1||!Array.from({length:value.length},(_,i)=>Object.hasOwn(value,i)).every(Boolean))throw new TypeError("Invalid canonical array");return `[${value.map(canonical).join(",")}]`;}
  if(Object.getPrototypeOf(value)!==Object.prototype||Object.getOwnPropertySymbols(value).length||Object.getOwnPropertyNames(value).length!==Object.keys(value).length)throw new TypeError("Invalid canonical object");
  return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
export function encodeUnknownV2(input:SettlementPreviewInput,source:CompleteSource,priorOutcomes:Json,scope:{orgId:string;liveOrgId:string;environment:"live"|"sandbox";leaseId:string}) {
  // An incomplete scan has no digest; never synthesize a "current" hash.
  if((!source.verifiedCandidate && ["capacity","source_changed","unavailable"].includes(source.reason??""))||!("fingerprint" in source)||!/^[a-f0-9]{64}$/.test(source.fingerprint))return {state:"unavailable" as const};
  if(!Array.isArray(input.items)||input.items.some(item=>item.invoiceLineId===undefined))throw new TypeError("Missing invoice line");
  const normalized=normalizeSettlementInput(input);
  const envelope={schema:"settlement-v2",algorithm:"b011-source-v2-unknown-1",input:normalized,scope,sourceFingerprint:source.fingerprint,sourceStatus:source.verifiedCandidate?"candidate":source.reason??"unsupported",priorOutcomes} as Json;
  const fingerprint=createHash("sha256").update(canonical(envelope)).digest("hex");
  return {state:"unknown" as const,schema:"settlement-v2" as const,fingerprint,envelope,calculation:{authoritative:false as const,netMinor:null,refundMinor:null,topUpMinor:null}};
}

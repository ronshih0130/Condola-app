import { isUuid } from "./repair-rules";

export type TransferInput = { requestId: string; propertyId: string; ownerId: string; effectiveDate: string; amount: string; reference: string; expectedCurrency: string; expectedMinorUnit: number };
export type ReverseInput = { requestId: string; originalId: string; effectiveDate: string; reason: string };
export function validTransferDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value && value >= "0001-01-01";
}
export function transferMinor(raw: unknown, scale: number): string | null {
  if (typeof raw !== "string" || !Number.isInteger(scale) || scale < 0 || scale > 4 || raw.length > 40) return null;
  const m = /^(\d+)(?:\.(\d+))?$/.exec(raw.trim());
  if (!m || (m[2]?.length ?? 0) > scale) return null;
  const amount = BigInt(m[1] + (m[2] ?? "").padEnd(scale, "0"));
  return amount > BigInt('0') && amount <= BigInt('9223372036854775807') ? amount.toString() : null;
}
export function parseTransfer(input: TransferInput, scale: number) {
  if (!input || ![input.requestId, input.propertyId, input.ownerId].every(v => typeof v === "string" && isUuid(v)) || !validTransferDate(input.effectiveDate) || typeof input.reference !== "string") return null;
  if (input.expectedMinorUnit !== scale || typeof input.expectedCurrency !== "string" || !/^[A-Z]{3}$/.test(input.expectedCurrency)) return null;
  const amountMinor = transferMinor(input.amount, scale), reference = input.reference.trim();
  if (!amountMinor || reference.length > 500) return null;
  return { requestId: input.requestId.toLowerCase(), propertyId: input.propertyId.toLowerCase(), ownerId: input.ownerId.toLowerCase(), effectiveDate: input.effectiveDate, amountMinor, reference, expectedCurrency:input.expectedCurrency, expectedMinorUnit:scale };
}
export function parseReversal(input: ReverseInput) {
  if (!input || ![input.requestId, input.originalId].every(v => typeof v === "string" && isUuid(v)) || !validTransferDate(input.effectiveDate) || typeof input.reason !== "string") return null;
  const reason = input.reason.trim();
  if (!reason || reason.length > 500) return null;
  return { requestId: input.requestId.toLowerCase(), originalId: input.originalId.toLowerCase(), effectiveDate: input.effectiveDate, reason };
}

/** Recovery storage is absent only when getItem returns null; JSON null is corrupt. */
function parseRecoveryJson(raw:string|null):unknown {
  if (raw===null) return undefined;
  if (typeof raw!=="string" || raw.length>16000) throw new Error("Invalid recovery data");
  return JSON.parse(raw);
}
export type OwnerTransferScope={userId:string;orgId:string;liveOrgId:string;environment:"live"|"sandbox"};
export type TransferRecovery=TransferInput & {expectedScope:OwnerTransferScope};
export type ReversalRecovery=ReverseInput & {expectedScope:OwnerTransferScope};
export function parseTransferRecovery(raw:string|null):TransferRecovery|null {
  const value=parseRecoveryJson(raw);if(value===undefined)return null;
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Invalid recovery data");
  const v=value as TransferRecovery;
  if(Object.keys(v).sort().join(',')!=="amount,effectiveDate,expectedCurrency,expectedMinorUnit,expectedScope,ownerId,propertyId,reference,requestId"||!parseTransfer(v,v.expectedMinorUnit)||!sameOwnerTransferScope(v.expectedScope,v.expectedScope))throw new Error("Invalid recovery data");
  return v;
}
export function parseReversalRecovery(raw:string|null):Record<string,ReversalRecovery> {
  const value=parseRecoveryJson(raw);if(value===undefined)return {};
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Invalid recovery data");
  const entries=Object.entries(value);if(entries.length>100)throw new Error("Invalid recovery data");
  for(const [id,v] of entries)if(!v||typeof v!=="object"||Array.isArray(v)||Object.keys(v).sort().join(',')!=="effectiveDate,expectedScope,originalId,reason,requestId"||!parseReversal(v as ReverseInput)||(v as ReverseInput).originalId!==id||!sameOwnerTransferScope((v as ReversalRecovery).expectedScope,(v as ReversalRecovery).expectedScope))throw new Error("Invalid recovery data");
  return Object.fromEntries(entries) as Record<string,ReversalRecovery>;
}
export function sameOwnerTransferScope(expected:unknown,actual:OwnerTransferScope):boolean {
  if(!expected||typeof expected!=="object"||Array.isArray(expected))return false;
  const s=expected as OwnerTransferScope;if(!actual||typeof actual!=="object")return false;
  return Object.keys(s).sort().join(",")==="environment,liveOrgId,orgId,userId" && ["live","sandbox"].includes(s.environment) && [s.userId,s.orgId,s.liveOrgId].every(v=>typeof v==="string"&&isUuid(v)) && s.userId===actual.userId && s.orgId===actual.orgId && s.liveOrgId===actual.liveOrgId && s.environment===actual.environment;
}

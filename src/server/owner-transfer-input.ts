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

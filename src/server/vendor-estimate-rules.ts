import { FlowError } from "./errors";
import { assertEstimate, assertIdentifiers } from "./repair-approval-rules";

export type VendorEstimateInput = {
  requestId: string; expectedHeadId: string | null; amountMinor: bigint;
  currency: string; minorUnit: number; workScope: string; evidence: { id: string }[];
};
export function assertVendorEstimate(input: VendorEstimateInput) {
  assertIdentifiers(input.requestId);
  if (input.expectedHeadId !== null) assertIdentifiers(input.expectedHeadId);
  if (typeof input.amountMinor !== "bigint") throw new FlowError("errors.amount");
  assertEstimate(input);
  const ids = input.evidence.map(ref => ref.id);
  assertIdentifiers(...ids);
  if (new Set(ids).size !== ids.length || input.evidence.some(ref => Object.keys(ref).some(key => key !== "id"))) {
    throw new FlowError("errors.required");
  }
}
export function parseVendorEstimate(value: unknown): VendorEstimateInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FlowError("errors.required");
  const v = value as Record<string, unknown>;
  if (typeof v.amountMinor !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(v.amountMinor)) {
    throw new FlowError("errors.amount");
  }
  const input = { ...v, amountMinor: BigInt(v.amountMinor) } as VendorEstimateInput;
  assertVendorEstimate(input);
  return input;
}

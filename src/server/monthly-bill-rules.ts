import { FlowError } from "./errors";

export function assertNoNegativeClaim(
  { grossMinor, creditOffsetMinor }: { grossMinor: string; creditOffsetMinor: string },
): { netMinor: string; carryMinor: string } {
  const gross = BigInt(grossMinor);
  const credit = BigInt(creditOffsetMinor);
  return credit > gross
    ? { netMinor: "0", carryMinor: (credit - gross).toString() }
    : { netMinor: (gross - credit).toString(), carryMinor: "0" };
}

export function assertPreviewMatchesPlan(
  { previewDigest, planDigest }: { previewDigest: string; planDigest: string },
): void {
  if (previewDigest !== planDigest) throw new FlowError("errors.preview_mismatch");
}

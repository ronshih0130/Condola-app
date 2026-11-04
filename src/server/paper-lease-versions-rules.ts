/** Global kill switch. Org opt-in alone never enables this feature. */
export function paperLeaseVersionsGlobalEnabled(value: unknown): boolean {
  return value === "true";
}

export const PAPER_LEASE_VERSIONS_ENABLED = paperLeaseVersionsGlobalEnabled(process.env.PAPER_LEASE_VERSIONS_ENABLED);

export function paperLeaseVersionsOn(killSwitch: boolean, featureFlags: unknown): boolean {
  if (killSwitch !== true || !featureFlags || typeof featureFlags !== "object" || Array.isArray(featureFlags)) {
    return false;
  }
  return (featureFlags as Record<string, unknown>).paper_lease_versions === true;
}

/** Closed set stored on the version and copied into audit. Not free text. */
export const PAPER_LEASE_REASON_CODES = [
  "corrected_signature",
  "wrong_file",
  "illegible_scan",
  "other",
] as const;

export type PaperLeaseReasonCode = (typeof PAPER_LEASE_REASON_CODES)[number];

export type PaperLeaseReason =
  | { ok: true; value: PaperLeaseReasonCode | null }
  | { ok: false };

const reasonCodes: readonly string[] = PAPER_LEASE_REASON_CODES;

export function paperLeaseReasonCode(input: unknown): PaperLeaseReasonCode | null {
  if (typeof input !== "string") return null;
  const value = input.trim();
  return reasonCodes.includes(value) ? value as PaperLeaseReasonCode : null;
}

/** A replacement stores one code. A first upload stores nothing. Any other text is rejected. */
export function validatePaperLeaseReason(replacing: boolean, input: unknown): PaperLeaseReason {
  if (input == null || (typeof input === "string" && input.trim() === "")) {
    return replacing ? { ok: false } : { ok: true, value: null };
  }
  const code = paperLeaseReasonCode(input);
  if (!code) return { ok: false };
  return { ok: true, value: code };
}

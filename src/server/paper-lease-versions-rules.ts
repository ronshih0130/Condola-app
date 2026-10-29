/** Global kill switch. Org opt-in alone never enables this feature. */
export const PAPER_LEASE_VERSIONS_ENABLED = false;

export function paperLeaseVersionsOn(killSwitch: boolean, featureFlags: unknown): boolean {
  if (killSwitch !== true || !featureFlags || typeof featureFlags !== "object" || Array.isArray(featureFlags)) {
    return false;
  }
  return (featureFlags as Record<string, unknown>).paper_lease_versions === true;
}

export type PaperLeaseReason =
  | { ok: true; value: string | null }
  | { ok: false };

/** Count Unicode characters as Postgres char_length does. Store only trimmed text. */
export function validatePaperLeaseReason(replacing: boolean, input: unknown): PaperLeaseReason {
  if (input != null && typeof input !== "string") return { ok: false };
  const value = typeof input === "string" ? input.trim() : "";
  const length = Array.from(value).length;
  if (length > 500 || (replacing && length === 0)) return { ok: false };
  return { ok: true, value: value || null };
}

export class PaperLeaseReasonError extends Error {
  constructor() {
    super("paper_lease_replace_reason");
    this.name = "PaperLeaseReasonError";
  }
}

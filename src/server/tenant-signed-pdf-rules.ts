/** Global kill switch. Enable only after tenant paper-PDF rollout approval. */
export const TENANT_SIGNED_PDF_ENABLED = false;

export function tenantSignedPdfOn(killSwitch: boolean, featureFlags: unknown): boolean {
  if (
    killSwitch !== true ||
    !featureFlags ||
    typeof featureFlags !== "object" ||
    Array.isArray(featureFlags)
  ) return false;

  return (featureFlags as Record<string, unknown>).tenant_signed_pdf === true;
}

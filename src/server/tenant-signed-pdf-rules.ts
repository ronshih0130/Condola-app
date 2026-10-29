/** App-level gate on; rollout is controlled by platform_settings tenant_signed_pdf (global) + organizations.feature_flags.tenant_signed_pdf (per org), both enforced in RLS (20261030151400). */
export const TENANT_SIGNED_PDF_ENABLED = true;

export function tenantSignedPdfOn(killSwitch: boolean, featureFlags: unknown): boolean {
  if (
    killSwitch !== true ||
    !featureFlags ||
    typeof featureFlags !== "object" ||
    Array.isArray(featureFlags)
  ) return false;

  return (featureFlags as Record<string, unknown>).tenant_signed_pdf === true;
}

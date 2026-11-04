/** Deployment switch. Default OFF unless the value is exactly the string "true". Org and platform_settings gates still apply. */
export function tenantSignedPdfGloballyEnabled(value: unknown = process.env.TENANT_SIGNED_PDF_ENABLED): boolean {
  return value === "true";
}

export const TENANT_SIGNED_PDF_ENABLED = tenantSignedPdfGloballyEnabled();

export function tenantSignedPdfOn(killSwitch: boolean, featureFlags: unknown): boolean {
  if (
    killSwitch !== true ||
    !featureFlags ||
    typeof featureFlags !== "object" ||
    Array.isArray(featureFlags)
  ) return false;

  return (featureFlags as Record<string, unknown>).tenant_signed_pdf === true;
}

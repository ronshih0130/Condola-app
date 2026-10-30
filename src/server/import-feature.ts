/** Both the deployment switch and the selected organization must opt in. */
export function importErrorDetailsEnabled(globalSwitch: unknown, flags: unknown): boolean {
  return globalSwitch === "true" && flags !== null && typeof flags === "object" && !Array.isArray(flags)
    && (flags as Record<string, unknown>).import_error_details === true;
}

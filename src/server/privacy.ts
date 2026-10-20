export type OwnerPrivacy = { showName: boolean; showPhone: boolean };

/** Firm defaults: owners see tenant names, and they do not see phone numbers. */
export function privacyFromSettings(settings: unknown): OwnerPrivacy {
  const value = settings && typeof settings === "object" ? (settings as Record<string, unknown>) : {};
  return {
    showName: value.show_tenant_name !== false,
    showPhone: value.show_tenant_phone === true,
  };
}

export function maskTenantNames(text: string, names: string[], hidden: string) {
  const ordered = [...new Set(names.map((name) => name.trim()).filter((name) => name.length >= 2))].sort(
    (a, b) => b.length - a.length,
  );
  return ordered.reduce((current, name) => current.split(name).join(hidden), text);
}

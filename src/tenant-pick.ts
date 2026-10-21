export type TenantOption = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
};

function localPhone(phone: string) {
  return phone.startsWith("+886") ? `0${phone.slice(4)}` : phone;
}

/** Name, email, E.164, and a Taiwan 0-prefix mobile, so a search box can match any of them. */
export function tenantSearchText(tenant: TenantOption) {
  const phone = tenant.phone ?? "";
  return `${tenant.name} ${phone} ${localPhone(phone)} ${tenant.email ?? ""}`.toLowerCase();
}

/** Empty once the search no longer contains the picked contact, so that id cannot be submitted. */
export function activeTenantPick(contactId: string, matches: readonly { id: string }[]) {
  if (!contactId) return "";
  return matches.some((row) => row.id === contactId) ? contactId : "";
}

export function filterTenants<T extends TenantOption>(tenants: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return tenants;
  const qDigits = q.replace(/\D/g, "");
  return tenants.filter((tenant) => {
    if (tenantSearchText(tenant).includes(q)) return true;
    if (qDigits.length < 3) return false;
    const phone = tenant.phone ?? "";
    return `${phone}${localPhone(phone)}`.replace(/\D/g, "").includes(qDigits);
  });
}

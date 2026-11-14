export type InviteScreen = "panel" | "qr" | "print" | "rotate" | "tenants" | "remove" | "lease";
export type InviteOptions = { bindingId?: string; leaseId?: string; notice?: "rotated" | "removed" | "saved" };
export const staffInvitePath = (unitId: string) => `/m/units/${encodeURIComponent(unitId)}/invite`;
export const staffInviteApiPath = (unitId: string) => `/api/m/units/${encodeURIComponent(unitId)}/staff-invite`;
export const inviteDate = (value: string) => {
  const date = new Date(value);
  return `${String(date.getUTCMonth() + 1).padStart(2, "0")}/${String(date.getUTCDate()).padStart(2, "0")}`;
};
export const staffInviteHeaders: Record<string, string> = {
  "Referrer-Policy": "no-referrer", "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
};

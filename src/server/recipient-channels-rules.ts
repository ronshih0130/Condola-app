/**
 * PROP-06 (L1-NOTI): channel planning for one recipient. Pure; no I/O.
 * In-app (portal notification center) first when the contact has a portal user; LINE only when
 * the contact is bound AND still a friend of the OA (push would otherwise fail); e-mail when an
 * address exists. Requested channels the recipient cannot use are reported, never silently dropped.
 */
export type Portal = "tenant" | "owner" | "vendor";
export type Channel = "in_app" | "line" | "email";
export type RecipientChannels = { portal: Portal | null; emailAvailable: boolean; inAppAvailable: boolean; lineBound: boolean; lineFriend: boolean };

/** Portal entry paths, incl. the reserved LIFF entries B-034..B-036 will serve. */
export const PORTAL_ENTRY: Record<Portal, { web: string; liff: string }> = {
  tenant: { web: "/t", liff: "/t/liff" },
  owner: { web: "/o", liff: "/o/liff" },
  vendor: { web: "/v", liff: "/v/liff" },
};

export function planChannels(r: RecipientChannels, requested: readonly Channel[] = ["in_app", "line", "email"]) {
  const usable: Record<Channel, boolean> = { in_app: r.inAppAvailable && r.portal !== null, line: r.lineBound && r.lineFriend && r.portal !== null, email: r.emailAvailable };
  const order = (["in_app", "line", "email"] as const).filter((c) => requested.includes(c));
  return {
    channels: order.filter((c) => usable[c]),
    unavailable: order.filter((c) => !usable[c]).map((c) => ({ channel: c, reason: c === "line" ? (r.portal === null ? "no_portal" : !r.lineBound ? "not_bound" : "not_friend") : c === "in_app" ? (r.portal === null ? "no_portal" : "no_portal_user") : "no_email" })),
    entry: r.portal ? PORTAL_ENTRY[r.portal] : null,
  };
}

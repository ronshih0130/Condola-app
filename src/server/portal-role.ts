export const PORTAL_ROLE_COOKIE = "condola_portal_role";

export type PortalKind = "owner" | "tenant";

/**
 * /o and /t win when the person has that role. Otherwise the last choice, then
 * the invitation they accepted most recently. Sign-in clears the choice so
 * login follows that invitation.
 */
export function pickPortalOrg<T extends { isOwner: boolean; isTenant: boolean; latestAt: number | null }>(
  rows: T[],
  path: string,
  cookie: string | null,
): T | null {
  if (!rows.length) return null;
  const owner = rows.find((row) => row.isOwner);
  const tenant = rows.find((row) => row.isTenant);
  if ((path === "/o" || path.startsWith("/o/")) && owner) return owner;
  if ((path === "/t" || path.startsWith("/t/")) && tenant) return tenant;
  if (cookie === "owner" && owner) return owner;
  if (cookie === "tenant" && tenant) return tenant;
  const stamped = rows
    .filter((row) => row.latestAt !== null)
    .sort((a, b) => (b.latestAt ?? 0) - (a.latestAt ?? 0));
  if (stamped[0]) return stamped[0];
  return tenant ?? owner ?? rows[0];
}

export function resolvePortalKind(input: {
  path: string;
  cookie: string | null;
  isOwner: boolean;
  isTenant: boolean;
  latest: PortalKind | null;
}): PortalKind | null {
  if ((input.path === "/o" || input.path.startsWith("/o/")) && input.isOwner) return "owner";
  if ((input.path === "/t" || input.path.startsWith("/t/")) && input.isTenant) return "tenant";
  if (input.cookie === "owner" && input.isOwner) return "owner";
  if (input.cookie === "tenant" && input.isTenant) return "tenant";
  if (input.latest === "owner" && input.isOwner) return "owner";
  if (input.latest === "tenant" && input.isTenant) return "tenant";
  if (input.isTenant) return "tenant";
  if (input.isOwner) return "owner";
  return null;
}

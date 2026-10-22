export type PortalPageTarget = { kind: "owner" | "tenant"; pageId: string };

const OWNER_PAGE = /^\/m\/owners\/([^/]+)$/;
const LEASE_PAGE = /^\/m\/leases\/([^/]+)$/;

/** Owner and lease pages. The id is the path segment the person is looking at. */
export function portalPageTarget(pathname: string): PortalPageTarget | null {
  const path = (pathname.split(/[?#]/, 1)[0] || "").replace(/\/+$/, "") || "/";
  const owner = OWNER_PAGE.exec(path);
  if (owner?.[1]) return { kind: "owner", pageId: decodeURIComponent(owner[1]) };
  const lease = LEASE_PAGE.exec(path);
  if (lease?.[1]) return { kind: "tenant", pageId: decodeURIComponent(lease[1]) };
  return null;
}

export function sameId(left: string, right: string) {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

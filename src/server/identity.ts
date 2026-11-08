import type { OrgRole } from "./types";
import { resolveStaffOrg, type OrgEnvironment } from "./org-scope";
import { pickPortalOrg, resolvePortalKind } from "./portal-role";

type SqlClient = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
};

export type IdentityResolution =
  | {
      kind: "staff";
      orgId: string;
      liveOrgId: string;
      environment: OrgEnvironment;
      role: OrgRole;
      liveEnabled: boolean;
      needsSandbox: boolean;
    }
  | {
      kind: "tenant" | "owner";
      orgId: string;
      liveOrgId: string;
      environment: OrgEnvironment;
      role: null;
      portals: { owner: boolean; tenant: boolean };
    };

export type IdentityResolveCtx = {
  preferredOrg: string | null;
  envCookie: OrgEnvironment | null;
  path: string;
  portalCookie: string | null;
  leaseId: string | null;
};

/** Pure resolution: staff first, then portal; no session side effects. */
export async function resolveIdentity(
  sql: SqlClient,
  userId: string,
  ctx: IdentityResolveCtx,
): Promise<IdentityResolution | null> {
  const firm = await resolveStaffOrg(sql, userId, ctx.preferredOrg, ctx.envCookie);
  if (firm) return { ...firm, kind: "staff" };
  return resolvePortalOrg(sql, userId, ctx);
}

async function resolvePortalOrg(
  sql: SqlClient,
  userId: string,
  ctx: IdentityResolveCtx,
): Promise<IdentityResolution | null> {
  const contact = await sql.query<{
    org_id: string;
    environment: OrgEnvironment;
    live_org_id: string;
    is_tenant: boolean;
    is_owner: boolean;
    latest_kind: string | null;
    latest_at: Date | null;
  }>(
    `SELECT c.org_id::text,
                o.environment::text AS environment,
                coalesce(o.live_org_id::text, c.org_id::text) AS live_org_id,
                bool_or(c.is_tenant) AS is_tenant,
                bool_or(c.is_owner) AS is_owner,
                (
                  SELECT i.kind::text
                    FROM invitations i
                   WHERE i.accepted_by = $1
                     AND i.org_id = c.org_id
                     AND i.status = 'accepted'
                     AND i.kind IN ('owner', 'tenant')
                   ORDER BY i.accepted_at DESC NULLS LAST
                   LIMIT 1
                ) AS latest_kind,
                (
                  SELECT i.accepted_at
                    FROM invitations i
                   WHERE i.accepted_by = $1
                     AND i.org_id = c.org_id
                     AND i.status = 'accepted'
                     AND i.kind IN ('owner', 'tenant')
                   ORDER BY i.accepted_at DESC NULLS LAST
                   LIMIT 1
                ) AS latest_at
           FROM contacts c
           JOIN organizations o ON o.id = c.org_id
          WHERE c.user_id = $1 AND c.archived_at IS NULL
          GROUP BY c.org_id, o.environment, o.live_org_id
          ORDER BY c.org_id`,
    [userId],
  );
  // Company choice is a preference among actual contacts, never a grant.
  const preferred = contact.rows.find(row => row.org_id === ctx.preferredOrg
    && ((ctx.path === "/o" || ctx.path.startsWith("/o/")) ? row.is_owner
      : (ctx.path === "/t" || ctx.path.startsWith("/t/")) ? row.is_tenant
      : ctx.portalCookie === "owner" ? row.is_owner : row.is_tenant));
  const candidates = preferred ? [preferred] : contact.rows;
  const picked = pickPortalOrg(
    candidates.map((row) => ({
      row,
      isOwner: row.is_owner,
      isTenant: row.is_tenant,
      latestAt: row.latest_at ? new Date(row.latest_at).getTime() : null,
    })),
    ctx.path,
    ctx.portalCookie,
  );
  const portal = picked?.row;
  if (!portal) return null;
  let orgId = portal.org_id;
  let environment: OrgEnvironment = portal.environment === "sandbox" ? "sandbox" : "live";
  let liveOrgId = portal.live_org_id;
  if (ctx.leaseId && !(ctx.path === "/o" || ctx.path.startsWith("/o/"))
    && !(ctx.portalCookie === "owner" && !ctx.path.startsWith("/t"))) {
    const leaseOrg = await sql.query<{ org_id: string; environment: OrgEnvironment; live_org_id: string }>(
      `SELECT l.org_id::text, o.environment::text AS environment, coalesce(o.live_org_id::text, l.org_id::text) AS live_org_id
             FROM leases l
             JOIN organizations o ON o.id = l.org_id
             JOIN lease_parties lp ON lp.lease_id = l.id
             JOIN contacts c ON c.id = lp.contact_id
            WHERE l.id = $1 AND c.user_id = $2
            LIMIT 1`,
      [ctx.leaseId, userId],
    );
    if (leaseOrg.rows[0]) {
      orgId = leaseOrg.rows[0].org_id;
      environment = leaseOrg.rows[0].environment === "sandbox" ? "sandbox" : "live";
      liveOrgId = leaseOrg.rows[0].live_org_id;
    }
  }
  const latest = portal.latest_kind === "owner" || portal.latest_kind === "tenant" ? portal.latest_kind : null;
  const kind = resolvePortalKind({
    path: ctx.path,
    cookie: ctx.portalCookie,
    isOwner: portal.is_owner,
    isTenant: portal.is_tenant,
    latest,
  });
  if (!kind) return null;
  return {
    kind,
    role: null,
    orgId,
    liveOrgId,
    environment,
    portals: {
      owner: contact.rows.some((row) => row.is_owner),
      tenant: contact.rows.some((row) => row.is_tenant),
    },
  };
}

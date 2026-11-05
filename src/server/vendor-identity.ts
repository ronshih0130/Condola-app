import {
  vendorLinkCapability,
  type VendorLinkCapability,
} from "./vendor-link-rules";
import { hashVendorToken, vendorTokenAcceptable } from "./vendor-repair-rules";

type SqlClient = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
};

export type VendorIdentityResolution = {
  kind: "vendor";
  jobId: string;
  orgId: string;
  ticketId: string;
  capability: VendorLinkCapability;
  tokenHash: string;
  linkable: boolean;
};

export type VendorResolveCtx = {
  token: string;
  now: Date;
  linkedUserId: string | null;
};

/** Resolve one vendor token without session, membership, or attribution side effects. */
export async function resolveVendorIdentity(
  sql: SqlClient,
  ctx: VendorResolveCtx,
): Promise<VendorIdentityResolution | null> {
  if (!vendorTokenAcceptable(ctx.token)) return null;
  const tokenHash = hashVendorToken(ctx.token);
  const result = await sql.query<{
    id: string;
    org_id: string;
    ticket_id: string;
    active: boolean;
    revoked_at: Date | string | null;
    expires_at: Date | string;
    status: string;
  }>(
    `SELECT j.id::text, j.org_id::text, j.ticket_id::text,
            j.active, j.revoked_at, j.expires_at, t.status::text
       FROM repair_vendor_secrets s
       JOIN repair_vendor_jobs j ON j.id = s.job_id
       JOIN maintenance_tickets t ON t.id = j.ticket_id AND t.org_id = j.org_id
      WHERE j.token_hash = $1
      LIMIT 1`,
    [tokenHash],
  );
  const row = result.rows[0];
  if (!row) return null;
  const capability = vendorLinkCapability({
    ticketStatus: row.status,
    active: row.active,
    revokedAt: row.revoked_at,
    expiresAt: row.expires_at,
    now: ctx.now,
  });
  const linkable = capability !== "invalid" &&
    row.status !== "closed" && row.status !== "cancelled" &&
    ctx.linkedUserId === null;
  return {
    kind: "vendor",
    jobId: row.id,
    orgId: row.org_id,
    ticketId: row.ticket_id,
    capability,
    tokenHash,
    linkable,
  };
}

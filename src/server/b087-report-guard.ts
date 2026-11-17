import type { Client } from "pg";
import { brandV2Enabled } from "./brand-v2";
import { FlowError } from "./errors";

/**
 * B-087 TEN-DUP (TEN-53-AC4): a tenant may report only the part of the lease's open balance that pending
 * tenant reports do not already cover. Server rule, gated by the org's effective brand_v3 (OFF keeps the
 * legacy rule: amount <= open balance).
 *
 * Pending = the same predicate the readers use (PENDING_TENANT_REPORT_SQL): lease-wide, any payer,
 * source 'tenant_portal', status 'submitted'. Rejected and reversed reports never count; confirmed ones are
 * already out of the open balance.
 */

/** Pure rule so the decision is unit-testable without a database. */
export function unreportedRest(openBalanceMinor: number, pendingMinor: number): number {
  return Math.max(0, openBalanceMinor - pendingMinor);
}

export function admitTenantReport(amountMinor: number, openBalanceMinor: number, pendingMinor: number): "ok" | "over_unreported" {
  const rest = unreportedRest(openBalanceMinor, pendingMinor);
  return rest > 0 && amountMinor <= rest ? "ok" : "over_unreported";
}

/** Effective brand_v3 for the lease's org, read in the caller's transaction. An unreadable org row fails closed. */
export async function b087Enabled(client: Client, orgId: string, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  const { rows } = await client.query<{ v2: unknown; v3: unknown }>(
    "SELECT feature_flags -> 'brand_v2' AS v2, feature_flags -> 'brand_v3' AS v3 FROM public.organizations WHERE id = $1::uuid",
    [orgId],
  );
  if (rows.length !== 1) throw new FlowError("errors.generic");
  return (brandV2Enabled(env) || rows[0].v2 === true) && rows[0].v3 === true;
}

/**
 * Serialises tenant reports on one lease, then reads the open balance and the pending total in ONE statement
 * (one snapshot), so a staff confirm committing in between cannot make the rest look larger than it is.
 * Must run before the INSERT, in the same transaction.
 */
export async function assertWithinUnreported(client: Client, orgId: string, leaseId: string, amountMinor: number): Promise<void> {
  // The key is built from canonical uuid text in SQL, so every spelling of the same lease id takes the same lock.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('b087:' || $1::uuid::text || ':' || $2::uuid::text, 0))", [orgId, leaseId]);
  const { rows } = await client.query<{ balance: string; pending: string }>(
    `SELECT
       (SELECT coalesce(sum(i.balance_minor), 0) FROM public.invoices i
         WHERE i.org_id = $1::uuid AND i.lease_id = $2::uuid AND i.status IN ('open','partially_paid'))::text AS balance,
       (SELECT coalesce(sum(p.amount_minor), 0) FROM public.payments p
         WHERE p.org_id = $1::uuid AND p.lease_id = $2::uuid AND p.source = 'tenant_portal' AND p.status = 'submitted')::text AS pending`,
    [orgId, leaseId],
  );
  const balance = Number(rows[0]?.balance);
  const pending = Number(rows[0]?.pending);
  if (!Number.isSafeInteger(balance) || !Number.isSafeInteger(pending)) throw new FlowError("errors.generic");
  if (admitTenantReport(amountMinor, balance, pending) !== "ok") throw new FlowError("errors.amountOverUnreported");
}

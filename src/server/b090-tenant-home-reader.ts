import { guardEffectiveSession, withEffectiveAuthority } from "@/server/b017-custom-role-governance";
import { tx } from "./db";
import { consentCoversCurrent, type StoredConsent } from "./consent";
import { logServerError } from "./errors";
import { localReminderDate } from "./reminder-foundation";
import { isUuid } from "./repair-rules";
import { historyFlagEnabled, safeMinor, summarizeBill } from "./tenant-payment-history-rules";
import { TENANT_HISTORY_CONTEXT_SQL as ctx, TENANT_HISTORY_PARTY_SQL as party, tenantHistorySessionValid } from "./tenant-payment-history";
import { tenantHomeFacts, type TenantHomeBill, type TenantHomeFacts } from "./b090-tenant-home-rules";
import type { Session } from "./types";

/**
 * Brand 3.0 B-090 slice 1, RT-HOME (TEN-54-AC1): the facts behind the 首頁 sentence.
 *
 * Its own reader, called only from the brand_v3 首頁 (tenantHomeView), so the shared tenantPaymentHistory reader
 * (the legacy /t and /t/pay body) keeps running exactly the queries it ran before B-090. It reuses that reader's
 * admission rules unchanged: the same session shape, org/session context, lease-party check, tenant_payment_history
 * gate ("off" hands the page back to the existing body), stored-consent check and current-lease statuses. Read-only,
 * repeatable read, as the tenant (RLS applies). Adds no database object and writes nothing.
 *
 * Waiting reports are summed lease-wide with the B-087 guard's predicate (any payer on the lease, source
 * tenant_portal, status submitted), so 首頁 and the 繳款 page agree (PENDING-RON PR-042 (1) = a).
 */
export type TenantHomeRead =
  | { state: "off" }
  | { state: "unavailable" }
  | { state: "ready"; bill: TenantHomeBill; facts: TenantHomeFacts };

type InvoiceRow = { status: string; total: string; paid: string; balance: string; due_on: string; period_start: string | null; currency: string };
const unavailable = { state: "unavailable" as const }, off = { state: "off" as const };

export async function tenantHomeRead(s: Session, leaseId: string): Promise<TenantHomeRead> {
  s = await guardEffectiveSession(s, null);
  if (!tenantHistorySessionValid(s) || !isUuid(leaseId)) return unavailable;
  try {
    return await tx(s.userId, async c => withEffectiveAuthority(c, s, null, async () => {
      const args = [s.orgId, s.userId, s.sessionId, s.liveOrgId, s.environment, leaseId];
      const controls = await c.query<{ flags: unknown; global: unknown }>(
        `SELECT o.feature_flags flags,(SELECT value FROM public.platform_settings WHERE key='tenant_payment_history') AS global FROM public.organizations o WHERE ${ctx}`,
        args.slice(0, 5));
      if (!controls.rows[0]) return unavailable;
      if (!historyFlagEnabled(controls.rows[0].global, controls.rows[0].flags, s.orgId)) return off;
      const context = await c.query<{ status: string; currency: string; timezone: string; consent: StoredConsent | null }>(
        `SELECT l.status::text,l.currency::text,pr.timezone,
          (SELECT jsonb_build_object('accepted_at',z.accepted_at,'terms_version',z.terms_version,'privacy_version',z.privacy_version,'source',z.source) FROM public.consents z WHERE z.user_id=$2::uuid ORDER BY z.recorded_at DESC,z.id DESC LIMIT 1) consent
         FROM public.leases l JOIN public.organizations o ON o.id=l.org_id JOIN public.properties pr ON pr.org_id=l.org_id AND pr.id=l.property_id
         WHERE ${ctx} AND l.org_id=$1::uuid AND l.id=$6::uuid AND ${party}`, args);
      const lease = context.rows[0];
      if (!lease || !consentCoversCurrent(lease.consent)) return unavailable;
      if (!["active", "pending_signature"].includes(lease.status)) return unavailable;
      const invoices = await c.query<InvoiceRow>(
        `SELECT status::text,total_minor::text total,paid_minor::text paid,balance_minor::text balance,due_date::text due_on,period_start::text period_start,currency::text
         FROM public.invoices WHERE org_id=$1::uuid AND lease_id=$2::uuid ORDER BY due_date,id`, [s.orgId, leaseId]);
      if (invoices.rows.some(i => i.currency !== lease.currency)) return unavailable;
      const now = new Date();
      const bill = summarizeBill(lease.status, invoices.rows.map(i => ({ status: i.status, total: safeMinor(i.total), paid: safeMinor(i.paid), balance: safeMinor(i.balance), dueOn: i.due_on })), lease.timezone, now);
      const waiting = await c.query<{ sum: string }>(
        `SELECT coalesce(sum(p.amount_minor),0)::text sum FROM public.payments p WHERE p.org_id=$1::uuid AND p.lease_id=$2::uuid AND p.source='tenant_portal' AND p.status='submitted'`,
        [s.orgId, leaseId]);
      const facts = tenantHomeFacts(
        invoices.rows.map(i => ({ status: i.status, balance: safeMinor(i.balance), dueOn: i.due_on, periodStart: i.period_start })),
        localReminderDate(now, lease.timezone), safeMinor(waiting.rows[0]?.sum ?? "0"));
      return { state: "ready" as const, bill: { ...bill, currency: lease.currency }, facts };
    }), { orgId: s.orgId, environment: s.environment }, { isolation: "repeatable read", readOnly: true });
  } catch (error) {
    logServerError("b090_tenant_home_read", error);
    return unavailable;
  }
}

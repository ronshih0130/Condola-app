import { guardEffectiveSession, withEffectiveAuthority } from "@/server/b017-custom-role-governance";
import { tx } from "./db";
import { consentCoversCurrent, type StoredConsent } from "./consent";
import { logServerError } from "./errors";
import { localReminderDate } from "./reminder-foundation";
import { isUuid } from "./repair-rules";
import { historyFlagEnabled, safeMinor, summarizeBill } from "./tenant-payment-history-rules";
import {
  TENANT_HISTORY_CONTEXT_SQL as ctx, TENANT_HISTORY_OWN_REPORT_SQL as personal, TENANT_HISTORY_PARTY_SQL as party, tenantHistorySessionValid,
} from "./tenant-payment-history";
import { tenantHomeFacts, type TenantHomeBill, type TenantHomeFacts } from "./b090-tenant-home-rules";
import { PAY_HISTORY_MONTHS, PAY_MONTH_REPORTS, payMonthFacts, type PayMonthReportRow, type PayMonthRow, type TenantPayFacts } from "./b090-tenant-pay-rules";
import type { Session } from "./types";

/**
 * Brand 3.0 B-090 slice 2, RT-PAY / RT-REPORT (TEN-52, TEN-53): the facts behind the 繳款 page and the 回報已繳 form.
 *
 * Its own reader, called only from the brand_v3 繳款 page (tenantPayView), so the shared tenantPaymentHistory reader
 * (the legacy /t/pay body) keeps running exactly the queries it ran before B-090 (PENDING-RON PR-043). It reuses that
 * reader's admission rules unchanged: the same session shape, org/session context, lease-party check, own-report scope,
 * tenant_payment_history gate ("off" hands the page back to the existing body), stored-consent check and current-lease
 * statuses. Read-only, repeatable read, as the tenant (RLS applies). Adds no database object and writes nothing.
 *
 * - the bill and the 首頁 facts, with the lease's waiting reports summed lease-wide by the B-087 guard's own predicate
 *   (any payer on the lease, source tenant_portal, status submitted), so the form's maximum is what the server accepts;
 * - the caller's own newest stored 帳號末五碼 on this lease (never a co-tenant's);
 * - the property's local date (the 匯款日期 default);
 * - 「之前的繳款」: complete per-month aggregates in SQL over every one of the caller's own reports on this lease (month
 *   of 匯款日期), the newest PAY_HISTORY_MONTHS months, plus at most PAY_MONTH_REPORTS rows per shown month for detail.
 */
export type TenantPayRead =
  | { state: "off" }
  | { state: "unavailable" }
  | { state: "ready"; bill: TenantHomeBill; facts: TenantHomeFacts; pay: TenantPayFacts };

type InvoiceRow = { status: string; total: string; paid: string; balance: string; due_on: string; period_start: string | null; currency: string };
const unavailable = { state: "unavailable" as const }, off = { state: "off" as const };

export async function tenantPayRead(s: Session, leaseId: string): Promise<TenantPayRead> {
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
      const now = new Date(), today = localReminderDate(now, lease.timezone);
      const bill = summarizeBill(lease.status, invoices.rows.map(i => ({ status: i.status, total: safeMinor(i.total), paid: safeMinor(i.paid), balance: safeMinor(i.balance), dueOn: i.due_on })), lease.timezone, now);
      const waiting = await c.query<{ sum: string }>(
        `SELECT coalesce(sum(p.amount_minor),0)::text sum FROM public.payments p WHERE p.org_id=$1::uuid AND p.lease_id=$2::uuid AND p.source='tenant_portal' AND p.status='submitted'`,
        [s.orgId, leaseId]);
      const facts = tenantHomeFacts(
        invoices.rows.map(i => ({ status: i.status, balance: safeMinor(i.balance), dueOn: i.due_on, periodStart: i.period_start })),
        today, safeMinor(waiting.rows[0]?.sum ?? "0"));
      const last = await c.query<{ last5: string }>(
        `SELECT p.payer_account_last5::text last5 FROM public.payments p WHERE ${personal} AND p.payer_account_last5 ~ '^[0-9]{5}$' ORDER BY p.submitted_at DESC,p.id DESC LIMIT 1`,
        [s.orgId, s.userId, leaseId]);
      const own = `WITH own AS (SELECT p.id,p.status::text AS status,p.amount_minor,p.currency::text AS currency,p.paid_on,p.submitted_at,p.rejected_reason,to_char(p.paid_on,'YYYY-MM') AS ym FROM public.payments p WHERE ${personal})`;
      const order = "o.paid_on DESC,o.submitted_at DESC,o.id DESC";
      // One month more than shown is read only to know that older months exist.
      const months = await c.query<PayMonthRow>(
        `${own},months AS (SELECT ym FROM own GROUP BY ym ORDER BY ym DESC LIMIT $4)
         SELECT o.ym,count(*)::int AS n,count(DISTINCT o.currency)::int AS currencies,coalesce(sum(o.amount_minor) FILTER (WHERE o.status IN ('submitted','confirmed')),0)::text AS counted,
          bool_or(o.status='submitted') AS any_submitted,bool_or(o.status='confirmed') AS any_confirmed,(array_agg(o.status ORDER BY ${order}))[1] AS newest_status,
          (array_agg(o.amount_minor::text ORDER BY ${order}))[1] AS newest_amount,(array_agg(o.currency ORDER BY ${order}))[1] AS currency,
          (array_agg(o.rejected_reason ORDER BY ${order}) FILTER (WHERE o.status='rejected'))[1] AS newest_reason
         FROM own o JOIN months m ON m.ym=o.ym GROUP BY o.ym ORDER BY o.ym DESC`,
        [s.orgId, s.userId, leaseId, PAY_HISTORY_MONTHS + 1]);
      const shown = months.rows.slice(0, PAY_HISTORY_MONTHS);
      const rows = shown.length ? await c.query<PayMonthReportRow>(
        `${own} SELECT x.id::text,x.status,x.amount_minor::text AS amount,x.currency,x.paid_on::text AS paid_on,x.rejected_reason,x.ym
         FROM (SELECT o.*,row_number() OVER (PARTITION BY o.ym ORDER BY ${order}) AS rn FROM own o WHERE o.ym=ANY($4::text[])) x WHERE x.rn<=$5 ORDER BY x.ym DESC,x.rn`,
        [s.orgId, s.userId, leaseId, shown.map(m => m.ym), PAY_MONTH_REPORTS]) : { rows: [] as PayMonthReportRow[] };
      const history = payMonthFacts(shown, rows.rows);
      if (!history) return unavailable;
      return {
        state: "ready" as const, bill: { ...bill, currency: lease.currency }, facts,
        pay: { lastLast5: last.rows[0]?.last5 ?? null, today, months: history, olderMonths: months.rows.length > PAY_HISTORY_MONTHS },
      };
    }), { orgId: s.orgId, environment: s.environment }, { isolation: "repeatable read", readOnly: true });
  } catch (error) {
    logServerError("b090_tenant_pay_read", error);
    return unavailable;
  }
}

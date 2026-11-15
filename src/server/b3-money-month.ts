import { brandV3ReadForOrg } from "./brand-v3";
import { guardEffectiveSession, withEffectiveReadAuthority } from "./b017-custom-role-governance";
import { PENDING_TENANT_REPORT_SQL } from "./b3-payment-eligibility";
import { tx } from "./db";
import { FlowError, logServerError } from "./errors";
import { requireOrgScope } from "./org-guard";
import { assertPerm } from "./perms";
import type { Session } from "./types";

// Brand 3.0 phase 3 §3.1, accepted §4 rules 1–9. Read projections only.
// brand_v3 (including its v2 prerequisite) is the only item gate for this page.
export const MONEY_MONTH_LIST_LIMIT = 50;
export const MONEY_MONTH_STATUSES = ["paid", "reported", "overdue", "due_today", "future"] as const;
export type MoneyMonthStatus = typeof MONEY_MONTH_STATUSES[number];
export type MoneyMonthBill = {
  leaseId: string; month: string; place: string; tenantName: string | null; currency: string;
  dueDate: string; totalMinor: string; confirmedMinor: string; remainingMinor: string; status: MoneyMonthStatus;
};
export type MoneyMonthCurrencyTotal = {
  currency: string; totalMinor: string; confirmedMinor: string; billedRows: number; paidRows: number;
};
export type MoneyMonthBills = { state: "off" } | { state: "unavailable" } | {
  state: "ready"; month: string; today: string; timezone: string;
  /** No separately reviewed ended/archive expansion exists in rule 8. */
  population: "rent_roll_active_unarchived";
  counts: Record<MoneyMonthStatus, number> & { all: number }; filteredCount: number;
  totals: MoneyMonthCurrencyTotal[];
  /** All periods, including ended/archived debt, just like dashboard. Count is leases, not people. */
  outstanding: { leaseCount: number; currencies: { currency: string; amountMinor: string; leaseCount: number }[] };
  rows: MoneyMonthBill[]; nextCursor: string | null;
};
export type MoneyMonthReport = {
  id: string; leaseId: string; place: string; tenantName: string | null;
  amountMinor: string; currency: string; paidOn: string; submittedAt: string;
  source: "tenant_portal"; bankTransactionId: string | null; proofFileId: string | null;
  /** Allocation can span months/leases. Each target appears once; each report is counted once. */
  billRows: { leaseId: string; month: string }[];
  attachment: "allocation" | "oldest_unpaid" | "other";
};
export type MoneyMonthReports = { state: "off" } | { state: "unavailable" } | {
  state: "ready"; month: string; today: string; timezone: string; yourTurn: number; attachedCount: number; otherCount: number;
  /** Unmatched pending reports are month-independent, never assigned by paid/submitted date. */
  otherScope: "all_pending";
  attached: MoneyMonthReport[]; other: MoneyMonthReport[]; nextCursor: string | null;
};
type Deps = { v3?: (orgId: string) => Promise<boolean>; transaction?: typeof tx; now?: () => Date };
type BillsInput = { month: string; status?: MoneyMonthStatus; cursor?: string };
type ReportsInput = { month: string; cursor?: string };

/** Row projection. The SQL CASE uses the same precedence for uncapped counts/filtering. */
export function moneyMonthStatus(total: string, confirmed: string, pending: boolean, dueDate: string, today: string): MoneyMonthStatus {
  if (BigInt(total) > BigInt(0) && BigInt(confirmed) >= BigInt(total)) return "paid";
  if (pending) return "reported";
  if (dueDate < today) return "overdue";
  return dueDate === today ? "due_today" : "future";
}

/** $1 org, $2 first day of selected month, $3 one captured instant.
 * Build ALL eligible months before attaching reports; navigation must not retarget a report.
 * Rent-roll space join preserved, including its whole-unit/by-room fallback and its lack of
 * a unit archived_at predicate. Rule 8 does not yet specify expansion to ended/archive rows.
 * Draft/void and nonpositive invoices are not bills. Every charge on an eligible invoice is
 * in total_minor. Confirmed allocations (not cash dates, pending payments or status alone)
 * determine the confirmed amount. No planner hint without a measured RLS plan.
 */
const POPULATION_SQL = `
WITH calendar AS (
  SELECT timezone, ($3::timestamptz AT TIME ZONE timezone)::date AS today
    FROM organizations WHERE id = $1
), confirmed_allocations AS MATERIALIZED (
  SELECT pa.invoice_id, sum(pa.amount_minor) AS confirmed
    FROM payment_allocations pa
    JOIN payments p ON p.id = pa.payment_id AND p.org_id = $1 AND p.status = 'confirmed'
   WHERE pa.org_id = $1 GROUP BY pa.invoice_id
), lease_targets AS MATERIALIZED (
  -- The rent roll's eligibility, resolved once per lease: a room-targeted lease counts on a non-archived
  -- room of a by-room unit; a unit-targeted lease counts on a whole unit, or on a by-room unit that has no
  -- non-archived room. Each step is materialized so a fresh table without planner statistics cannot turn
  -- this into a rescanned units x leases loop (measured: 2 s in CI with 58 invoices; spaces x OR join: 4.4 s).
  SELECT l.id AS lease_id, r.id AS room_id, r.label AS room_label,
         CASE WHEN r.id IS NOT NULL THEN r.unit_id ELSE l.target_unit_id END AS unit_id
    FROM leases l
    LEFT JOIN rooms r ON r.id = l.target_room_id AND r.org_id = $1 AND r.archived_at IS NULL
   WHERE l.org_id = $1 AND l.status IN ('pending_signature','active')
), eligible_leases AS MATERIALIZED (
  SELECT t.lease_id, pr.name || ' ' || u.label || coalesce(' ' || t.room_label, '') AS place
    FROM lease_targets t
    JOIN units u ON u.org_id = $1 AND u.id = t.unit_id
    JOIN properties pr ON pr.id = u.property_id AND pr.org_id = $1 AND pr.archived_at IS NULL
   WHERE (t.room_id IS NOT NULL AND u.rental_mode = 'by_room')
      OR (t.room_id IS NULL AND (u.rental_mode = 'whole_unit' OR NOT EXISTS (
            SELECT 1 FROM rooms rx WHERE rx.unit_id = u.id AND rx.org_id = $1 AND rx.archived_at IS NULL)))
), eligible_invoices AS MATERIALIZED (
  -- Driven from the invoice (one row per invoice) joined to its eligible lease.
  SELECT i.id, e.lease_id, date_trunc('month', i.period_start)::date AS month,
         i.currency::text AS currency, i.due_date, i.total_minor,
         coalesce(a.confirmed, 0) AS confirmed, e.place
    FROM invoices i
    JOIN eligible_leases e ON e.lease_id = i.lease_id
    LEFT JOIN confirmed_allocations a ON a.invoice_id = i.id
   WHERE i.org_id = $1
     AND i.status NOT IN ('draft','void') AND i.total_minor > 0 AND i.period_start IS NOT NULL
), bill_rows AS (
  SELECT lease_id, month, min(currency) AS currency, count(DISTINCT currency)::int AS currency_count,
         min(place) AS place, sum(total_minor) AS total, sum(confirmed) AS confirmed,
         greatest(sum(total_minor) - sum(confirmed), 0) AS remaining,
         coalesce(min(due_date) FILTER (WHERE confirmed < total_minor), min(due_date)) AS due_date
    FROM eligible_invoices GROUP BY lease_id, month
), pending_reports AS (
  SELECT p.* FROM payments p WHERE ${PENDING_TENANT_REPORT_SQL}
), explicit_targets AS (
  SELECT DISTINCT p.id AS report_id, i.lease_id, i.month, 'allocation'::text AS attachment
    FROM pending_reports p JOIN payment_allocations pa ON pa.payment_id = p.id AND pa.org_id = $1
    JOIN eligible_invoices i ON i.id = pa.invoice_id
), attachments AS (
  SELECT * FROM explicit_targets
  UNION ALL
  SELECT p.id, b.lease_id, b.month, 'oldest_unpaid'
    FROM pending_reports p
    CROSS JOIN LATERAL (
      SELECT b.lease_id, b.month FROM bill_rows b
       WHERE b.lease_id = p.lease_id AND b.currency = p.currency AND b.confirmed < b.total
       ORDER BY b.due_date, b.month, b.lease_id LIMIT 1
    ) b
   WHERE NOT EXISTS (SELECT 1 FROM payment_allocations pa WHERE pa.org_id = $1 AND pa.payment_id = p.id)
), selected_bill_facts AS (
  SELECT b.*, EXISTS (SELECT 1 FROM attachments a WHERE a.lease_id = b.lease_id AND a.month = b.month) AS has_pending_report
    FROM bill_rows b WHERE b.month = $2::date
), selected_bills AS (
  SELECT b.*, CASE
           WHEN b.confirmed >= b.total THEN 'paid'
           WHEN b.has_pending_report THEN 'reported'
           WHEN b.due_date < c.today THEN 'overdue'
           WHEN b.due_date = c.today THEN 'due_today'
           ELSE 'future' END AS status
    FROM selected_bill_facts b CROSS JOIN calendar c
), selected_reports AS (
  SELECT p.*, CASE WHEN EXISTS (SELECT 1 FROM attachments a WHERE a.report_id = p.id) THEN 1 ELSE 0 END AS group_order
    FROM pending_reports p
   WHERE EXISTS (SELECT 1 FROM attachments a WHERE a.report_id = p.id AND a.month = $2::date)
      OR NOT EXISTS (SELECT 1 FROM attachments a WHERE a.report_id = p.id)
)`;

export const BILLS_SUMMARY_SQL_FOR_TEST = `${POPULATION_SQL}
SELECT c.today::text, c.timezone,
       (SELECT count(*)::int FROM selected_bills WHERE currency_count <> 1) AS invalid_currencies,
       (SELECT count(*)::int FROM selected_bills) AS all_count,
       (SELECT coalesce(jsonb_object_agg(status, n), '{}'::jsonb) FROM
         (SELECT status, count(*)::int AS n FROM selected_bills GROUP BY status) s) AS counts,
       (SELECT coalesce(jsonb_agg(t ORDER BY t.currency), '[]'::jsonb) FROM (
         SELECT currency, sum(total)::text AS "totalMinor", sum(confirmed)::text AS "confirmedMinor",
                count(*)::int AS "billedRows", count(*) FILTER (WHERE status = 'paid')::int AS "paidRows"
           FROM selected_bills GROUP BY currency) t) AS totals,
       (SELECT count(DISTINCT lease_id)::int FROM invoices WHERE org_id = $1
          AND status IN ('open','partially_paid') AND balance_minor > 0) AS owing,
       (SELECT coalesce(jsonb_agg(o ORDER BY o.currency), '[]'::jsonb) FROM (
         SELECT currency::text, sum(balance_minor)::text AS "amountMinor",
                count(DISTINCT lease_id) FILTER (WHERE balance_minor > 0)::int AS "leaseCount"
           FROM invoices WHERE org_id = $1 AND status IN ('open','partially_paid') GROUP BY currency) o) AS outstanding
  FROM calendar c`;

// $4 status, $5 last due date, $6 last lease id, $7 lookahead limit.
export const BILLS_LIST_SQL_FOR_TEST = `${POPULATION_SQL}
SELECT b.lease_id::text AS "leaseId", to_char(b.month, 'YYYY-MM') AS month, b.place,
       tenant.display_name AS "tenantName", b.currency, b.due_date::text AS "dueDate",
       b.total::text AS "totalMinor", b.confirmed::text AS "confirmedMinor", b.remaining::text AS "remainingMinor", b.has_pending_report
  FROM selected_bills b
  LEFT JOIN LATERAL (
    SELECT c.display_name FROM lease_parties lp JOIN contacts c ON c.id = lp.contact_id AND c.org_id = $1
     WHERE lp.org_id = $1 AND lp.lease_id = b.lease_id AND lp.role = 'primary' ORDER BY lp.id LIMIT 1
  ) tenant ON true
 WHERE ($4::text IS NULL OR b.status = $4)
   AND ($5::date IS NULL OR (b.due_date, b.lease_id) > ($5::date, $6::uuid))
 ORDER BY b.due_date, b.lease_id LIMIT $7`;

export const REPORTS_SUMMARY_SQL_FOR_TEST = `${POPULATION_SQL}
SELECT c.today::text, c.timezone, summary.*
  FROM (SELECT count(*)::int AS count,
       count(*) FILTER (WHERE group_order = 1)::int AS attached,
       count(*) FILTER (WHERE group_order = 0)::int AS other,
       (SELECT count(*)::int FROM bill_rows WHERE currency_count <> 1) AS invalid_currencies
  FROM selected_reports) summary CROSS JOIN calendar c`;

// $4 group (other first), $5 submitted timestamp (full microseconds), $6 id, $7 lookahead.
export const REPORTS_LIST_SQL_FOR_TEST = `${POPULATION_SQL}
SELECT p.id::text, p.lease_id::text AS "leaseId", p.amount_minor::text AS "amountMinor", p.currency::text,
       p.paid_on::text AS "paidOn", to_char(p.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "submittedAt",
       p.source, p.bank_transaction_id::text AS "bankTransactionId", p.proof_file_id::text AS "proofFileId",
       pr.name || ' ' || u.label || coalesce(' ' || r.label, '') AS place, c.display_name AS "tenantName",
       coalesce((SELECT jsonb_agg(jsonb_build_object('leaseId', a.lease_id::text, 'month', to_char(a.month, 'YYYY-MM'))
           ORDER BY a.month, a.lease_id) FROM attachments a WHERE a.report_id = p.id), '[]'::jsonb) AS "billRows",
       coalesce((SELECT min(a.attachment) FROM attachments a WHERE a.report_id = p.id), 'other') AS attachment
  FROM selected_reports p
  JOIN leases l ON l.id = p.lease_id AND l.org_id = $1
  JOIN properties pr ON pr.id = l.property_id AND pr.org_id = $1
  JOIN units u ON u.id = l.unit_id AND u.org_id = $1
  LEFT JOIN rooms r ON r.id = l.target_room_id AND r.org_id = $1
  LEFT JOIN contacts c ON c.id = p.payer_contact_id AND c.org_id = $1
 WHERE ($4::int IS NULL OR (p.group_order, p.submitted_at, p.id) > ($4::int, $5::timestamptz, $6::uuid))
 ORDER BY p.group_order, p.submitted_at, p.id LIMIT $7`;

type Cursor = { v: 1; kind: "bills" | "reports"; org: string; month: string; status: MoneyMonthStatus | null; date: string; id: string; group?: number };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
}
function inputMonth(month: string): string {
  if (!/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Invalid month");
  return `${month}-01`;
}
function readCursor(value: string | undefined, expected: Pick<Cursor, "kind" | "org" | "month" | "status">): Cursor | null {
  if (value === undefined) return null;
  if (!value || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid cursor");
  const c = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Cursor;
  if (!c || c.v !== 1 || c.kind !== expected.kind || c.org !== expected.org || c.month !== expected.month || c.status !== expected.status
      || typeof c.id !== "string" || !uuid.test(c.id) || typeof c.date !== "string") throw new Error("Invalid cursor scope");
  if (c.kind === "bills" ? !validDate(c.date) :
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(c.date) || !Number.isFinite(Date.parse(c.date))
      || new Date(c.date).toISOString().slice(0, 19) !== c.date.slice(0, 19) || ![0, 1].includes(c.group!)) {
    throw new Error("Invalid cursor position");
  }
  return c;
}
const cursorFor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString("base64url");

type BillsSummary = {
  today: string; timezone: string; invalid_currencies: number; all_count: number;
  counts: Partial<Record<MoneyMonthStatus, number>>; totals: MoneyMonthCurrencyTotal[];
  owing: number; outstanding: { currency: string; amountMinor: string; leaseCount: number }[];
};
type ReportsSummary = { today: string; timezone: string; count: number; attached: number; other: number; invalid_currencies: number };
type BillRow = Omit<MoneyMonthBill, "status"> & { has_pending_report: boolean };

export async function moneyMonthBills(session: Session, input: BillsInput, deps: Deps = {}): Promise<MoneyMonthBills> {
  const v3 = deps.v3 ?? brandV3ReadForOrg;
  const transaction = deps.transaction ?? tx;
  try {
    if (!(await v3(session.orgId))) return { state: "off" };
    const admitted = await guardEffectiveSession(session, "stmt.view");
    assertPerm(admitted, "stmt.view");
    const month = inputMonth(input.month);
    if (input.status !== undefined && !MONEY_MONTH_STATUSES.includes(input.status)) throw new Error("Invalid status");
    const scope = { kind: "bills" as const, org: admitted.orgId, month: input.month, status: input.status ?? null };
    const cursor = readCursor(input.cursor, scope);
    const now = (deps.now ?? (() => new Date()))().toISOString();
    return await transaction(admitted.userId, async client => {
      await client.query("SET LOCAL statement_timeout = '2s'");
      // Measured (58 invoices, authenticated, RLS): 1.9 s without, 15 ms with. Same setting as staffPaymentTurns:
      // under RLS the planner ignores partial-index selectivity; this read-only transaction only.
      await client.query("SET LOCAL enable_seqscan = off");
      return withEffectiveReadAuthority(client, admitted, "stmt.view", async () => {
        const staff = await client.query<{ ok: boolean | null }>(
          "SELECT app.has_role($1::uuid, '{admin,manager,accountant}'::org_role[]) AS ok", [admitted.orgId]);
        if (staff.rows[0]?.ok !== true) throw new FlowError("errors.forbidden");
        const params = [admitted.orgId, month, now];
        const summary = (await client.query<BillsSummary>(BILLS_SUMMARY_SQL_FOR_TEST, params)).rows[0];
        if (!summary || summary.invalid_currencies !== 0) throw new Error("Incomplete bill summary");
        const counts = { all: summary.all_count, paid: 0, reported: 0, overdue: 0, due_today: 0, future: 0, ...summary.counts };
        const page = (await client.query<BillRow>(BILLS_LIST_SQL_FOR_TEST,
          [...params, input.status ?? null, cursor?.date ?? null, cursor?.id ?? null, MONEY_MONTH_LIST_LIMIT + 1])).rows;
        const rows = page.slice(0, MONEY_MONTH_LIST_LIMIT).map(({ has_pending_report, ...row }): MoneyMonthBill => ({
          ...row, status: moneyMonthStatus(row.totalMinor, row.confirmedMinor, has_pending_report, row.dueDate, summary.today),
        }));
        const last = rows.at(-1);
        return { state: "ready" as const, month: input.month, today: summary.today, timezone: summary.timezone,
          population: "rent_roll_active_unarchived" as const, counts, filteredCount: input.status ? counts[input.status] : counts.all,
          totals: summary.totals, outstanding: { leaseCount: summary.owing, currencies: summary.outstanding }, rows,
          nextCursor: page.length > MONEY_MONTH_LIST_LIMIT && last ? cursorFor({ v: 1, ...scope, date: last.dueDate, id: last.leaseId }) : null };
      });
    }, requireOrgScope(admitted), { isolation: "repeatable read", readOnly: true });
  } catch (error) {
    if (error instanceof FlowError && error.key === "errors.forbidden") throw error;
    logServerError("b3_money_month_bills", error);
    return { state: "unavailable" };
  }
}

export async function moneyMonthReports(session: Session, input: ReportsInput, deps: Deps = {}): Promise<MoneyMonthReports> {
  const v3 = deps.v3 ?? brandV3ReadForOrg;
  const transaction = deps.transaction ?? tx;
  try {
    if (!(await v3(session.orgId))) return { state: "off" };
    const admitted = await guardEffectiveSession(session, "pay.record");
    assertPerm(admitted, "pay.record");
    const month = inputMonth(input.month);
    const scope = { kind: "reports" as const, org: admitted.orgId, month: input.month, status: null };
    const cursor = readCursor(input.cursor, scope);
    const now = (deps.now ?? (() => new Date()))().toISOString();
    return await transaction(admitted.userId, async client => {
      await client.query("SET LOCAL statement_timeout = '2s'");
      // Measured (58 invoices, authenticated, RLS): 1.9 s without, 15 ms with. Same setting as staffPaymentTurns:
      // under RLS the planner ignores partial-index selectivity; this read-only transaction only.
      await client.query("SET LOCAL enable_seqscan = off");
      return withEffectiveReadAuthority(client, admitted, "pay.record", async () => {
        const staff = await client.query<{ ok: boolean | null }>(
          "SELECT app.has_role($1::uuid, '{admin,manager,accountant}'::org_role[]) AS ok", [admitted.orgId]);
        if (staff.rows[0]?.ok !== true) throw new FlowError("errors.forbidden");
        const params = [admitted.orgId, month, now];
        const summary = (await client.query<ReportsSummary>(REPORTS_SUMMARY_SQL_FOR_TEST, params)).rows[0];
        if (!summary || summary.invalid_currencies !== 0) throw new Error("Incomplete report summary");
        const page = (await client.query<MoneyMonthReport>(REPORTS_LIST_SQL_FOR_TEST,
          [...params, cursor?.group ?? null, cursor?.date ?? null, cursor?.id ?? null, MONEY_MONTH_LIST_LIMIT + 1])).rows;
        const rows = page.slice(0, MONEY_MONTH_LIST_LIMIT), last = rows.at(-1);
        return { state: "ready" as const, month: input.month, today: summary.today, timezone: summary.timezone, yourTurn: summary.count, attachedCount: summary.attached,
          otherCount: summary.other, otherScope: "all_pending" as const,
          attached: rows.filter(r => r.attachment !== "other"), other: rows.filter(r => r.attachment === "other"),
          nextCursor: page.length > MONEY_MONTH_LIST_LIMIT && last ? cursorFor({ v: 1, ...scope, date: last.submittedAt,
            id: last.id, group: last.attachment === "other" ? 0 : 1 }) : null };
      });
    }, requireOrgScope(admitted), { isolation: "repeatable read", readOnly: true });
  } catch (error) {
    if (error instanceof FlowError && error.key === "errors.forbidden") throw error;
    logServerError("b3_money_month_reports", error);
    return { state: "unavailable" };
  }
}

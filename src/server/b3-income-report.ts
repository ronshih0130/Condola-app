import type { Client } from "pg";
import { guardEffectiveSession, withEffectiveReadAuthority } from "./b017-custom-role-governance";
import { brandV3ReadForOrg } from "./brand-v3";
import { tx } from "./db";
import { FlowError, logServerError } from "./errors";
import { requireOrgScope } from "./org-guard";
import { assertPerm } from "./perms";
import type { Session } from "./types";

export type IncomeReportInput = { mode?: string; month?: string; from?: string; to?: string; property?: string; owner?: string; cursor?: string };
export type IncomeReportPeriod = { mode: "month" | "range"; month: string; start: string; end: string };
export type IncomeReportLine = {
  key: string; date: string; kind: "income" | "expense" | "deposit"; item: string;
  propertyId: string; property: string; ownerId: string | null; owner: string | null;
  currency: string; amountMinor: string; sourceAmountMinor: string; sourceId: string; invoiceId: string | null; allocationId: string | null;
};
export type IncomeReportTotal = { currency: string; incomeMinor: string; expenseMinor: string; netMinor: string; depositMinor: string };
export type IncomeReportReady = {
  state: "ready"; period: IncomeReportPeriod; timezone: string; count: number;
  totals: IncomeReportTotal[]; rows: IncomeReportLine[]; nextCursor: string | null;
  choices: { properties: { id: string; name: string }[]; owners: { id: string; name: string }[] };
};
export type IncomeReport = IncomeReportReady | { state: "off" | "unavailable" };
export type IncomeReportDeps = { v3?: (org: string) => Promise<boolean>; transaction?: typeof tx; now?: () => Date };
export const INCOME_REPORT_LIMIT = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function day(value: string) {
  return /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
export function incomeReportPeriod(input: IncomeReportInput, today: string): IncomeReportPeriod {
  if (input.mode && input.mode !== "month" && input.mode !== "range") throw new FlowError("errors.reportRange");
  if (input.mode === "range") {
    const start = input.from ?? "", end = input.to ?? "";
    if (!day(start) || !day(end) || end < start) throw new FlowError("errors.reportRange");
    return { mode: "range", month: start.slice(0, 7), start, end };
  }
  const month = input.month || today.slice(0, 7);
  if (!/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new FlowError("errors.reportRange");
  const end = new Date(`${month}-01T00:00:00Z`);
  end.setUTCMonth(end.getUTCMonth() + 1, 0);
  return { mode: "month", month, start: `${month}-01`, end: end.toISOString().slice(0, 10) };
}
function filterId(value?: string) {
  if (!value) return null;
  if (!UUID.test(value)) throw new FlowError("errors.reportRange");
  return value.toLowerCase();
}

/** Existing report property/owner overlap and allocation waterfall. Partition BEFORE excluding
 * deposits/future rent, so excluded money is never reassigned to another charge. One income
 * row is one allocation x invoice-line portion; expenses are one row each. No repair-state filter.
 * Existing cost_bearer `manager` is company liability (not the paid_by actor).
 * Rent uses invoice.period_start against the inclusive query end; it is not later
 * recognized by this cash-date reader. Missing rent periods fail the whole report.
 * $1 org, $2 inclusive start, $3 inclusive end, $4 property, $5 owner. */
export const INCOME_REPORT_POPULATION_SQL = `WITH props AS MATERIALIZED (
  SELECT p.id, p.name, o.id AS owner_id, o.name AS owner_name
    FROM properties p
    LEFT JOIN LATERAL (
      SELECT c.id, c.display_name AS name FROM property_owners po
      JOIN contacts c ON c.id = po.owner_contact_id AND c.org_id = $1
      WHERE po.org_id = $1 AND po.property_id = p.id
        AND po.effective_from <= $3::date AND (po.effective_to IS NULL OR po.effective_to >= $2::date)
      ORDER BY po.is_primary DESC, po.effective_from DESC, po.id LIMIT 1
    ) o ON true
   WHERE p.org_id = $1 AND p.archived_at IS NULL
     AND ($4::uuid IS NULL OR p.id = $4)
     AND ($5::uuid IS NULL OR EXISTS (SELECT 1 FROM property_owners po WHERE po.org_id = $1
       AND po.property_id = p.id AND po.owner_contact_id = $5
       AND po.effective_from <= $3::date AND (po.effective_to IS NULL OR po.effective_to >= $2::date)))
), portions AS (
  SELECT pay.id AS source_id, pay.amount_minor AS source_amount, pay.paid_on AS date, btrim(pay.currency) AS currency,
    p.id AS property_id, p.name AS property, p.owner_id, p.owner_name AS owner,
    a.id AS allocation_id, il.id AS line_id, i.id AS invoice_id, i.period_start,
    il.charge_type, il.description AS item,
    least(greatest(0, a.amount_minor - coalesce(sum(greatest(il.amount_minor, 0)) OVER (
      PARTITION BY a.id ORDER BY CASE il.charge_type
        WHEN 'rent' THEN 1 WHEN 'add_on' THEN 2 WHEN 'late_fee' THEN 3 WHEN 'one_off' THEN 4
        WHEN 'maintenance' THEN 5 WHEN 'utility' THEN 6 WHEN 'deposit' THEN 7
        WHEN 'adjustment' THEN 8 WHEN 'credit' THEN 9 ELSE 0 END, il.line_no
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)), greatest(il.amount_minor, 0)) AS amount
  FROM payments pay
  JOIN leases l ON l.id = pay.lease_id AND l.org_id = $1
  JOIN props p ON p.id = l.property_id
  JOIN payment_allocations a ON a.payment_id = pay.id AND a.org_id = $1
  JOIN invoices i ON i.id = a.invoice_id AND i.org_id = $1 AND i.lease_id = pay.lease_id AND i.currency = pay.currency
  JOIN invoice_lines il ON il.invoice_id = i.id AND il.org_id = $1
  WHERE pay.org_id = $1 AND pay.status = 'confirmed' AND pay.paid_on BETWEEN $2::date AND $3::date
), report_lines AS (
  SELECT allocation_id::text || ':' || line_id::text AS key, date,
    CASE WHEN charge_type = 'deposit' THEN 'deposit' ELSE 'income' END AS kind,
    item, property_id, property, owner_id, owner, currency, amount,
    source_id, invoice_id, allocation_id, source_amount
  FROM portions WHERE amount > 0
    AND (charge_type <> 'rent' OR period_start <= $3::date)
  UNION ALL
  SELECT e.id::text, e.incurred_on, 'expense', coalesce(e.description, e.category),
    p.id, p.name, p.owner_id, p.owner_name, btrim(e.currency), e.amount_minor,
    e.id, NULL::uuid, NULL::uuid, e.amount_minor
  FROM expenses e JOIN props p ON p.id = e.property_id
  WHERE e.org_id = $1 AND e.status IN ('approved','posted') AND e.bill_to IN ('owner','manager')
    AND e.incurred_on BETWEEN $2::date AND $3::date
)`;
export const INCOME_REPORT_SUMMARY_SQL = `${INCOME_REPORT_POPULATION_SQL}
SELECT (SELECT count(*)::int FROM report_lines) AS count,
  (SELECT count(*)::int FROM portions WHERE charge_type = 'rent' AND amount > 0 AND period_start IS NULL) AS unknown_periods,
  coalesce(jsonb_agg(t ORDER BY currency), '[]'::jsonb) AS totals FROM (
    SELECT currency, coalesce(sum(amount) FILTER (WHERE kind = 'income'), 0)::text AS "incomeMinor",
      coalesce(sum(amount) FILTER (WHERE kind = 'expense'), 0)::text AS "expenseMinor",
      (coalesce(sum(amount) FILTER (WHERE kind = 'income'), 0) - coalesce(sum(amount) FILTER (WHERE kind = 'expense'), 0))::text AS "netMinor",
      coalesce(sum(amount) FILTER (WHERE kind = 'deposit'), 0)::text AS "depositMinor"
    FROM report_lines GROUP BY currency) t`;
export const INCOME_REPORT_LIST_SQL = `${INCOME_REPORT_POPULATION_SQL}
SELECT key, date::text, kind, item, property_id::text AS "propertyId", property,
  owner_id::text AS "ownerId", owner, currency, amount::text AS "amountMinor",
  source_amount::text AS "sourceAmountMinor", source_id::text AS "sourceId", invoice_id::text AS "invoiceId", allocation_id::text AS "allocationId"
FROM report_lines WHERE ($6::date IS NULL OR (date, key) > ($6::date, $7::text))
ORDER BY date, key LIMIT $8`;

async function staffOn(client: Client, session: Session) {
  const staff = await client.query<{ ok: boolean | null }>(
    "SELECT app.has_role($1::uuid, '{admin,manager,accountant}'::org_role[]) AS ok", [session.orgId]);
  if (session.kind !== "staff" || staff.rows[0]?.ok !== true) throw new FlowError("errors.forbidden");
}

/** Private snapshot composition; export calls it once with no LIMIT, never by paging across snapshots. */
async function readOn(client: Client, session: Session, input: IncomeReportInput, now: Date, all: boolean): Promise<IncomeReportReady> {
  await staffOn(client, session);
  const calendar = (await client.query<{ today: string; timezone: string }>(
    "SELECT ($2::timestamptz AT TIME ZONE timezone)::date::text AS today, timezone FROM organizations WHERE id = $1",
    [session.orgId, now.toISOString()])).rows[0];
  if (!calendar) throw new Error("Missing calendar");
  const period = incomeReportPeriod(input, calendar.today), property = filterId(input.property), owner = filterId(input.owner);
  const scope = JSON.stringify([session.orgId, session.environment, period.start, period.end, property, owner]);
  let cursor: { scope: string; date: string; key: string } | null = null;
  if (input.cursor && !all) {
    if (input.cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw new FlowError("errors.reportRange");
    cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
    if (!cursor || cursor.scope !== scope || !day(cursor.date) || typeof cursor.key !== "string"
      || !/^[0-9a-f:-]{36,73}$/i.test(cursor.key)) throw new FlowError("errors.reportRange");
  }
  const args = [session.orgId, period.start, period.end, property, owner];
  const summary = (await client.query<{ count: number; unknown_periods: number; totals: IncomeReportTotal[] }>(INCOME_REPORT_SUMMARY_SQL, args)).rows[0];
  if (!summary || summary.unknown_periods !== 0) throw new Error("Unknown rent period");
  const page = (await client.query<IncomeReportLine>(INCOME_REPORT_LIST_SQL,
    [...args, cursor?.date ?? null, cursor?.key ?? null, all ? null : INCOME_REPORT_LIMIT + 1])).rows;
  const rows = all ? page : page.slice(0, INCOME_REPORT_LIMIT), last = rows.at(-1);
  const properties = (await client.query<{ id: string; name: string }>(
    "SELECT id::text, name FROM properties WHERE org_id = $1 AND archived_at IS NULL ORDER BY name, id", [session.orgId])).rows;
  const owners = (await client.query<{ id: string; name: string }>(
    "SELECT id::text, display_name AS name FROM contacts WHERE org_id = $1 AND is_owner ORDER BY display_name, id", [session.orgId])).rows;
  return { state: "ready", period, timezone: calendar.timezone, count: summary.count, totals: summary.totals, rows,
    choices: { properties, owners }, nextCursor: !all && page.length > INCOME_REPORT_LIMIT && last
      ? Buffer.from(JSON.stringify({ scope, date: last.date, key: last.key })).toString("base64url") : null };
}

export async function incomeExpenseLines(session: Session, input: IncomeReportInput, deps: IncomeReportDeps = {}): Promise<IncomeReport> {
  try {
    if (!await (deps.v3 ?? brandV3ReadForOrg)(session.orgId)) return { state: "off" };
    const admitted = await guardEffectiveSession(session, "stmt.view");
    assertPerm(admitted, "stmt.view");
    return await (deps.transaction ?? tx)(admitted.userId, async client => {
      await client.query("SET LOCAL statement_timeout = '2s'");
      return withEffectiveReadAuthority(client, admitted, "stmt.view", () => readOn(client, admitted, input, (deps.now ?? (() => new Date()))(), false));
    }, requireOrgScope(admitted), { isolation: "repeatable read", readOnly: true });
  } catch (error) {
    if (error instanceof FlowError && error.key === "errors.forbidden") throw error;
    logServerError("b3_income_report", error);
    return { state: "unavailable" };
  }
}

/** Export read requires BOTH capabilities; audit is deliberately outside this read-only snapshot. */
export async function incomeExpenseExportData(session: Session, input: IncomeReportInput, deps: IncomeReportDeps = {}): Promise<IncomeReportReady> {
  if (!await (deps.v3 ?? brandV3ReadForOrg)(session.orgId)) throw new FlowError("errors.forbidden");
  let admitted = await guardEffectiveSession(session, "reports.export");
  assertPerm(admitted, "reports.export");
  admitted = await guardEffectiveSession(admitted, "stmt.view");
  assertPerm(admitted, "stmt.view");
  return (deps.transaction ?? tx)(admitted.userId, async client => {
    await client.query("SET LOCAL statement_timeout = '2s'");
    return withEffectiveReadAuthority(client, admitted, "reports.export", () =>
      withEffectiveReadAuthority(client, admitted, "stmt.view", () => readOn(client, admitted, input, (deps.now ?? (() => new Date()))(), true)));
  }, requireOrgScope(admitted), { isolation: "repeatable read", readOnly: true });
}

export async function revalidateIncomeExport(session: Session, deps: IncomeReportDeps = {}): Promise<Session> {
  const admitted = await guardEffectiveSession(session, "reports.export");
  assertPerm(admitted, "reports.export");
  if (!await (deps.v3 ?? brandV3ReadForOrg)(admitted.orgId)) throw new FlowError("errors.forbidden");
  await (deps.transaction ?? tx)(admitted.userId, async client => {
    await client.query("SET LOCAL statement_timeout = '2s'");
    return withEffectiveReadAuthority(client, admitted, "reports.export", () => staffOn(client, admitted));
  }, requireOrgScope(admitted), { isolation: "repeatable read", readOnly: true });
  return admitted;
}

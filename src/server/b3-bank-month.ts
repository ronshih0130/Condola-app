import { bankMatchBasis, type BankMatchBasis } from "../lib/bank-match-basis";
import { brandV3ReadForOrg } from "./brand-v3";
import { guardEffectiveSession, withEffectiveReadAuthority } from "./b017-custom-role-governance";
import { tx } from "./db";
import { FlowError, logServerError } from "./errors";
import { requireOrgScope } from "./org-guard";
import { assertPerm } from "./perms";
import type { Session } from "./types";

export const BANK_MONTH_LIST_LIMIT = 50;
export const BANK_MONTH_FILTERS = ["review", "matched", "all"] as const;
export type BankMonthFilter = typeof BANK_MONTH_FILTERS[number];
export type BankCandidate = {
  paymentId: string; suggestionId: string | null; name: string | null; paidOn: string;
  amountMinor: string; currency: string; basis: BankMatchBasis;
  invoices: { id: string; month: string | null; number: string; amountMinor: string }[];
};
export type BankCandidateState = { kind: "exact" | "possible" | "same_day" | "none"; count: number };
/** Count stored, still eligible suggestions only. A single partial suggestion is possible, never exact.
 * Multiple: ALL have exact amount + same date -> same_day takes priority; otherwise possible.
 * This projection never generates, upgrades or confirms a suggestion.
 */
export function bankCandidateState(candidates: Pick<BankCandidate, "suggestionId" | "basis">[]): BankCandidateState {
  const suggestions = candidates.filter(c => c.suggestionId !== null);
  const count = suggestions.length;
  if (!count) return { kind: "none", count };
  if (count === 1 && suggestions[0].basis.amountExact && suggestions[0].basis.last5Matched && suggestions[0].basis.dateDeltaDays === 0) return { kind: "exact", count };
  if (count > 1 && suggestions.every(c => c.basis.amountExact && c.basis.dateDeltaDays === 0)) return { kind: "same_day", count };
  return { kind: "possible", count };
}
export type BankMonthRow = {
  id: string; postedOn: string; last5: string | null; amountMinor: string; currency: string;
  memo: string | null; account: string; status: "unmatched" | "suggested" | "matched" | "ignored";
  candidates: BankCandidate[]; candidateState: BankCandidateState;
};
export type BankMonth = { state: "off" } | { state: "unavailable" } | {
  state: "ready"; month: string; timezone: string; filter: BankMonthFilter;
  counts: { all: number; matched: number; review: number; ignored: number }; filteredCount: number;
  lastUploadAt: string | null; lastUploadScope: "org_unarchived_accounts_all_time";
  accounts: { id: string; nickname: string; currency: string }[];
  rows: BankMonthRow[]; nextCursor: string | null;
};
export type BankMonthInput = { month?: string; filter?: BankMonthFilter; cursor?: string };
type Deps = { v3?: (orgId: string) => Promise<boolean>; transaction?: typeof tx; now?: () => Date };

// Preserve the existing bank item gate and session validity, inside the same authenticated snapshot.
export const BANK_ADMISSION_SQL_FOR_TEST = `SELECT
  EXISTS (SELECT 1 FROM organizations WHERE id = $1 AND environment::text = $4
    AND (CASE WHEN environment = 'sandbox' THEN live_org_id ELSE id END) = $5::uuid) AS valid_scope,
  EXISTS (SELECT 1 FROM auth_sessions WHERE id = $2 AND user_id = $3 AND revoked_at IS NULL AND expires_at > now()) AS valid_session,
  EXISTS (SELECT 1 FROM organizations o JOIN platform_settings p ON p.key = 'bank_matching'
    WHERE o.id = $1 AND o.feature_flags->'bank_matching' = 'true'::jsonb AND p.value->'enabled' = 'true'::jsonb
      AND jsonb_typeof(p.value->'allowed_org_ids') = 'array'
      AND p.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) AS enabled`;
export const BANK_CALENDAR_SQL_FOR_TEST = `SELECT timezone,
  to_char($2::timestamptz AT TIME ZONE timezone, 'YYYY-MM') AS month FROM organizations WHERE id = $1`;
const POPULATION = `WITH selected AS (
 SELECT b.*, a.nickname AS account, a.property_id AS account_property
 FROM bank_transactions b JOIN bank_accounts a ON a.org_id = b.org_id AND a.id = b.bank_account_id
 WHERE b.org_id = $1 AND a.archived_at IS NULL
   AND b.posted_on >= $2::date AND b.posted_on < ($2::date + interval '1 month')
)`;
export const BANK_SUMMARY_SQL_FOR_TEST = `${POPULATION}
SELECT count(*)::int AS all, count(*) FILTER (WHERE status = 'matched')::int AS matched,
 count(*) FILTER (WHERE status IN ('unmatched','suggested'))::int AS review,
 count(*) FILTER (WHERE status = 'ignored')::int AS ignored,
 (SELECT to_char(max(i.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  FROM bank_statement_imports i JOIN bank_accounts a ON a.id = i.bank_account_id AND a.org_id = i.org_id
  WHERE i.org_id = $1 AND a.archived_at IS NULL) AS "lastUploadAt",
 (SELECT coalesce(jsonb_agg(jsonb_build_object('id', a.id::text, 'nickname', a.nickname, 'currency', a.currency)
   ORDER BY a.created_at, a.id), '[]'::jsonb) FROM bank_accounts a WHERE a.org_id = $1 AND a.archived_at IS NULL) AS accounts
FROM selected`;
// Newest posted date first; stable UUID tie-breaker. Only the 50+1 page gets candidate projections.
// Manual eligibility mirrors BankMatching/decideBankMatch; allocation context is factual, not a guessed bill month.
export const BANK_LIST_SQL_FOR_TEST = `${POPULATION}, page AS (
 SELECT * FROM selected WHERE ($3 = 'all' OR ($3 = 'matched' AND status = 'matched')
   OR ($3 = 'review' AND status IN ('unmatched','suggested')))
 AND ($4::date IS NULL OR (posted_on, id) < ($4::date, $5::uuid))
 ORDER BY posted_on DESC, id DESC LIMIT $6
)
SELECT b.id::text, b.posted_on::text AS "postedOn", b.counterparty_account_last5::text AS last5,
 b.amount_minor::text AS "amountMinor", b.currency::text, b.description AS memo, b.account, b.status::text,
 coalesce(c.candidates, '[]'::jsonb) AS candidates
FROM page b LEFT JOIN LATERAL (
 SELECT jsonb_agg(jsonb_build_object('paymentId', p.id::text, 'suggestionId', s.id::text, 'name', contact.display_name,
   'paidOn', p.paid_on::text, 'amountMinor', p.amount_minor::text, 'currency', p.currency::text, 'reasons', s.reasons,
   'invoices', coalesce((SELECT jsonb_agg(jsonb_build_object('id', i.id::text, 'month', to_char(i.period_start, 'YYYY-MM'),
     'number', i.invoice_number, 'amountMinor', pa.amount_minor::text) ORDER BY i.period_start, i.id)
     FROM payment_allocations pa JOIN invoices i ON i.org_id = pa.org_id AND i.id = pa.invoice_id
     WHERE pa.org_id = $1 AND pa.payment_id = p.id), '[]'::jsonb)) ORDER BY p.paid_on DESC, p.id, s.id) AS candidates
 FROM payments p LEFT JOIN contacts contact ON contact.org_id = p.org_id AND contact.id = p.payer_contact_id
 LEFT JOIN bank_match_suggestions s ON s.org_id = $1 AND s.bank_transaction_id = b.id
   AND s.payment_id = p.id AND s.status = 'suggested'
 WHERE p.org_id = $1 AND p.bank_transaction_id IS NULL AND p.status IN ('submitted','confirmed')
   AND p.currency = b.currency AND p.amount_minor = b.amount_minor
   AND (b.account_property IS NULL OR p.property_id = b.account_property)
   AND b.amount_minor > 0 AND b.amount_minor <= 9007199254740991 AND b.status IN ('unmatched','suggested')
) c ON true ORDER BY b.posted_on DESC, b.id DESC`;

type Cursor = { v: 1; org: string; month: string; filter: BankMonthFilter; date: string; id: string };
function validMonth(value: string) { return typeof value === "string" && /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(value); }
function readCursor(value: string | undefined, scope: Pick<Cursor, "org" | "month" | "filter">): Cursor | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !value || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid cursor");
  const c = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Cursor;
  if (!c || c.v !== 1 || c.org !== scope.org || c.month !== scope.month || c.filter !== scope.filter
    || typeof c.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(c.id)
    || typeof c.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(c.date) || c.date.slice(0, 7) !== scope.month
    || !Number.isFinite(Date.parse(`${c.date}T00:00:00Z`)) || new Date(`${c.date}T00:00:00Z`).toISOString().slice(0, 10) !== c.date) throw new Error("Invalid cursor scope");
  return c;
}
type RawCandidate = Omit<BankCandidate, "basis"> & { reasons: unknown };
type RawRow = Omit<BankMonthRow, "candidates" | "candidateState"> & { candidates: RawCandidate[] };
type Summary = Extract<BankMonth, { state: "ready" }>["counts"] & Pick<Extract<BankMonth, { state: "ready" }>, "lastUploadAt" | "accounts">;

export async function bankMonth(session: Session, input: BankMonthInput = {}, deps: Deps = {}): Promise<BankMonth> {
  try {
    if (!(await (deps.v3 ?? brandV3ReadForOrg)(session.orgId))) return { state: "off" };
    const admitted = await guardEffectiveSession(session, "bank.reconcile");
    assertPerm(admitted, "bank.reconcile");
    if (admitted.needsSandbox) throw new FlowError("errors.forbidden");
    if (input.month !== undefined && !validMonth(input.month)) throw new Error("Invalid month");
    const filter = input.filter ?? "review";
    if (!BANK_MONTH_FILTERS.includes(filter)) throw new Error("Invalid filter");
    const now = (deps.now ?? (() => new Date()))().toISOString();
    return await (deps.transaction ?? tx)(admitted.userId, async client => {
      await client.query("SET LOCAL statement_timeout = '2s'");
      return withEffectiveReadAuthority(client, admitted, "bank.reconcile", async () => {
        const staff = await client.query<{ ok: boolean | null }>(
          "SELECT app.has_role($1::uuid, '{admin,accountant}'::org_role[]) AS ok", [admitted.orgId]);
        if (staff.rows[0]?.ok !== true) throw new FlowError("errors.forbidden");
        const admission = (await client.query<{ valid_scope: boolean; valid_session: boolean; enabled: boolean }>(BANK_ADMISSION_SQL_FOR_TEST,
          [admitted.orgId, admitted.sessionId, admitted.userId, admitted.environment, admitted.liveOrgId])).rows[0];
        if (!admission?.valid_scope || !admission.valid_session) throw new FlowError("errors.forbidden");
        if (!admission.enabled) return { state: "unavailable" as const };
        const calendar = (await client.query<{ month: string; timezone: string }>(BANK_CALENDAR_SQL_FOR_TEST, [admitted.orgId, now])).rows[0];
        if (!calendar || !validMonth(calendar.month)) throw new Error("Missing calendar");
        const month = input.month ?? calendar.month;
        const scope = { org: admitted.orgId, month, filter };
        const cursor = readCursor(input.cursor, scope);
        const summary = (await client.query<Summary>(BANK_SUMMARY_SQL_FOR_TEST, [admitted.orgId, `${month}-01`])).rows[0];
        if (!summary || summary.all !== summary.matched + summary.review + summary.ignored) throw new Error("Incomplete bank counts");
        const page = (await client.query<RawRow>(BANK_LIST_SQL_FOR_TEST,
          [admitted.orgId, `${month}-01`, filter, cursor?.date ?? null, cursor?.id ?? null, BANK_MONTH_LIST_LIMIT + 1])).rows;
        const rows = page.slice(0, BANK_MONTH_LIST_LIMIT).map(({ candidates: raw, ...row }): BankMonthRow => {
          const candidates = raw.map(({ reasons, ...candidate }) => ({ ...candidate, basis: bankMatchBasis(reasons) }));
          return { ...row, candidates, candidateState: bankCandidateState(candidates) };
        });
        const last = rows.at(-1);
        const { lastUploadAt, accounts, ...counts } = summary;
        return { state: "ready" as const, month, timezone: calendar.timezone, filter, counts, filteredCount: counts[filter],
          lastUploadAt, lastUploadScope: "org_unarchived_accounts_all_time" as const, accounts, rows,
          nextCursor: page.length > BANK_MONTH_LIST_LIMIT && last
            ? Buffer.from(JSON.stringify({ v: 1, ...scope, date: last.postedOn, id: last.id })).toString("base64url") : null };
      });
    }, requireOrgScope(admitted), { isolation: "repeatable read", readOnly: true });
  } catch (error) {
    if (error instanceof FlowError && error.key === "errors.forbidden") throw error;
    logServerError("b3_bank_month", error);
    return { state: "unavailable" };
  }
}

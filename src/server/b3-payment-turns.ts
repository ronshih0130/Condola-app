import { brandV3ReadForOrg } from "./brand-v3";
import { guardEffectiveSession, withEffectiveReadAuthority } from "./b017-custom-role-governance";
import { tx } from "./db";
import { FlowError, logServerError } from "./errors";
import { requireOrgScope } from "./org-guard";
import { assertPerm } from "./perms";
import type { TenantPaymentHistory } from "./tenant-payment-history";
import type { Session } from "./types";

// Brand 3.0 Batch 3a (B-070): whose turn a payment report is in. Derived at read time; nothing
// is stored and no database object is added. Spec: condola-hub
// 20-build/specs/BRAND-3.0-batch3a-payments-spec.md r4. Stories: PLT-53, MGT-125, MGT-126, TEN-51.
//
// Rules (first match wins), over payment reports (source = 'tenant_portal'):
//   P1 submitted                                   -> 管, since submitted_at (exact), confirm_payment
//   P2 rejected AND the lease's most recently submitted rejected report AND the lease has an
//      open balance AND the lease has no report currently submitted
//                                                  -> 租, since updated_at (approximate), re_report
//   P3 other rejected, P4 confirmed, P5 reversed   -> nobody (never listed, never counted)

export type TurnHolder = "manager" | "tenant";
export type TurnStep = "confirm_payment" | "re_report";
export type PaymentTurnMatter = {
  id: string;
  rule: "P1" | "P2";
  holder: TurnHolder;
  step: TurnStep;
  /** ISO timestamp. Exact for P1; approximate for P2 (no rejected_at column), so no day count. */
  since: string;
  sinceExact: boolean;
  timezone: string;
  amountMinor: number;
  currency: string;
  paidOn: string;
  leaseId: string;
  place: string;
  tenantName: string | null;
};
export type PaymentTurnCount = { holder: TurnHolder; step: TurnStep; count: number };
export type StaffPaymentTurns =
  | { state: "off" }
  | { state: "unavailable" }
  | {
      state: "ready";
      /** Per holder and step, over every matter of the org, before any list limit. */
      counts: PaymentTurnCount[];
      /** Matters this viewer can act on: holder 管, step confirm_payment (admission requires pay.record). */
      yourTurn: number;
      mine: PaymentTurnMatter[];
      others: PaymentTurnMatter[];
    };

export const PAYMENT_TURN_LIST_LIMIT = 50;
const STAFF_ROLES = "{admin,manager,accountant}";

/** The matters of one org. $1 = org id. Reads payments and invoices only. */
export const PAYMENT_TURN_MATTERS_SQL = `
WITH open_leases AS (
  SELECT i.lease_id
    FROM invoices i
   WHERE i.org_id = $1 AND i.status IN ('open','partially_paid')
   GROUP BY i.lease_id
  HAVING sum(i.balance_minor) > 0
), p2 AS (
  SELECT latest.id
    FROM open_leases ol
   CROSS JOIN LATERAL (
     SELECT p.id
       FROM payments p
      WHERE p.org_id = $1 AND p.lease_id = ol.lease_id AND p.source = 'tenant_portal' AND p.status = 'rejected'
      ORDER BY p.submitted_at DESC, p.id DESC
      LIMIT 1
   ) latest
   WHERE NOT EXISTS (
     SELECT 1 FROM payments s
      WHERE s.org_id = $1 AND s.lease_id = ol.lease_id AND s.source = 'tenant_portal' AND s.status = 'submitted')
), matters AS (
  SELECT p.id, 'P1'::text AS rule, 'manager'::text AS holder, 'confirm_payment'::text AS step,
         p.submitted_at AS since, true AS since_exact
    FROM payments p
   WHERE p.org_id = $1 AND p.source = 'tenant_portal' AND p.status = 'submitted'
  UNION ALL
  SELECT p.id, 'P2', 'tenant', 're_report', p.updated_at, false
    FROM payments p JOIN p2 ON p2.id = p.id
   WHERE p.org_id = $1
)`;

const COUNTS_SQL = `${PAYMENT_TURN_MATTERS_SQL}
SELECT holder, step, count(*)::int AS count FROM matters GROUP BY holder, step ORDER BY holder, step`;

const LISTS_SQL = `${PAYMENT_TURN_MATTERS_SQL}
SELECT m.id::text, m.rule, m.holder, m.step,
       to_char(m.since AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS since, m.since_exact,
       pr.timezone, p.amount_minor::text AS amount, p.currency::text AS currency, p.paid_on::text AS paid_on,
       p.lease_id::text AS lease_id, pr.name || coalesce(' ' || r.label, '') AS place, c.display_name AS tenant
  FROM (SELECT x.*, row_number() OVER (PARTITION BY x.holder ORDER BY x.since, x.id) AS rn FROM matters x) m
  JOIN payments p ON p.id = m.id AND p.org_id = $1
  JOIN leases l ON l.id = p.lease_id
  JOIN properties pr ON pr.id = l.property_id
  LEFT JOIN rooms r ON r.id = l.target_room_id
  LEFT JOIN contacts c ON c.id = p.payer_contact_id
 WHERE m.rn <= $2
 ORDER BY m.holder, m.since, m.id`;

/** Exported for the read-only and denial tests only. */
export const COUNTS_SQL_FOR_TEST = COUNTS_SQL;
export const LISTS_SQL_FOR_TEST = LISTS_SQL;

type ListRow = {
  id: string; rule: "P1" | "P2"; holder: TurnHolder; step: TurnStep; since: string; since_exact: boolean;
  timezone: string; amount: string; currency: string; paid_on: string; lease_id: string; place: string; tenant: string | null;
};

function safeMinor(value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("Unsafe amount");
  return n;
}

type Deps = { v3?: (orgId: string) => Promise<boolean>; transaction?: typeof tx };

/**
 * Staff reader (MGT-125, MGT-126, PLT-53-AC6). A complete authorization boundary of its own:
 * staff session + effective pay.record in TypeScript, and current staff membership checked
 * in the database inside the same snapshot. A refusal is errors.forbidden, never an empty list.
 * Any other failure, at any step including admission, is "unavailable", never zero (MGT-125-AC3).
 */
export async function staffPaymentTurns(session: Session, deps: Deps = {}): Promise<StaffPaymentTurns> {
  const v3 = deps.v3 ?? brandV3ReadForOrg;
  const transaction = deps.transaction ?? tx;
  try {
    if (!(await v3(session.orgId))) return { state: "off" };
    // Resolves the current custom-role authority when custom roles are on (a database read);
    // passes native and non-staff sessions through unchanged, so it is not a boundary by itself.
    const admitted = await guardEffectiveSession(session, "pay.record");
    // Staff identity and the native (and, for a custom role, effective) permission.
    assertPerm(admitted, "pay.record");
    return await transaction(admitted.userId, async (client) => {
      await client.query("SET LOCAL statement_timeout = '2s'");
      // Planner hint, this transaction only. Under row-level security the status filters below
      // are not leakproof (enum equality), so the planner cannot credit the partial indexes
      // (invoices_open_idx, payments_inbox_idx) with their selectivity and prefers scanning every
      // invoice of the org, running the policies on each row. Measured on 5,000 leases / 60,000
      // invoices / 50,000 payments: 926 ms per statement with the default plan, 91 ms with this.
      await client.query("SET LOCAL enable_seqscan = off");
      return withEffectiveReadAuthority(client, admitted, "pay.record", async () => {
        // Current staff membership in this org and environment, in this snapshot. Without it a
        // former staff member who is also a tenant here would still see their lease's reports
        // through the tenant policy.
        const staff = await client.query<{ ok: boolean | null }>(`SELECT app.has_role($1::uuid, $2::org_role[]) AS ok`, [admitted.orgId, STAFF_ROLES]);
        if (staff.rows[0]?.ok !== true) throw new FlowError("errors.forbidden");
        const counts = (await client.query<PaymentTurnCount>(COUNTS_SQL, [admitted.orgId])).rows;
        const rows = (await client.query<ListRow>(LISTS_SQL, [admitted.orgId, PAYMENT_TURN_LIST_LIMIT])).rows;
        const matters = rows.map((r): PaymentTurnMatter => ({
          id: r.id, rule: r.rule, holder: r.holder, step: r.step, since: r.since, sinceExact: r.since_exact,
          timezone: r.timezone, amountMinor: safeMinor(r.amount), currency: r.currency, paidOn: r.paid_on,
          leaseId: r.lease_id, place: r.place, tenantName: r.tenant,
        }));
        return {
          state: "ready" as const,
          counts,
          yourTurn: counts.find((c) => c.holder === "manager" && c.step === "confirm_payment")?.count ?? 0,
          mine: matters.filter((m) => m.holder === "manager"),
          others: matters.filter((m) => m.holder === "tenant"),
        };
      });
    }, requireOrgScope(admitted), { isolation: "repeatable read", readOnly: true });
  } catch (error) {
    // A refusal stays a refusal. Everything else — the flag lookup, the custom-role lookup,
    // a timeout, a lost connection — is "unavailable"; it is never reported as zero.
    if (error instanceof FlowError && error.key === "errors.forbidden") throw error;
    logServerError("b3_staff_payment_turns", error);
    return { state: "unavailable" };
  }
}

export type TenantPaymentTurn =
  | { kind: "waiting"; amountMinor: number; currency: string }
  | { kind: "your_turn"; step: "re_report" }
  | null;

/**
 * Tenant line (TEN-51). Pure: reads only the unpaginated turn summary the tenant's own loader
 * computed. Carries no person's name; the caller adds the company name.
 */
export function tenantPaymentTurn(history: TenantPaymentHistory): TenantPaymentTurn {
  if (history.state !== "ready" || !history.turn) return null;
  if (history.turn.waiting) return { kind: "waiting", amountMinor: history.turn.waiting.amountMinor, currency: history.turn.waiting.currency };
  if (history.turn.reReport) return { kind: "your_turn", step: "re_report" };
  return null;
}

/**
 * 「第 N 天」: calendar days from `since` to `now` in the property's timezone, counting from 1.
 * Null when `since` is approximate (PLT-53-AC5) or the inputs are unusable.
 */
export function turnDayNumber(matter: Pick<PaymentTurnMatter, "since" | "sinceExact" | "timezone">, now: Date = new Date()): number | null {
  if (!matter.sinceExact) return null;
  const since = new Date(matter.since);
  if (Number.isNaN(since.getTime()) || Number.isNaN(now.getTime())) return null;
  let local: (d: Date) => string;
  try {
    const format = new Intl.DateTimeFormat("en-CA", { timeZone: matter.timezone, year: "numeric", month: "2-digit", day: "2-digit" });
    local = (d) => format.format(d);
  } catch {
    return null;
  }
  const day = (d: Date) => Date.parse(`${local(d)}T00:00:00Z`) / 86_400_000;
  const n = day(now) - day(since) + 1;
  return Number.isFinite(n) && n >= 1 ? n : null;
}

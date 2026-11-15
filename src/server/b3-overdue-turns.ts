import { brandV3ReadForOrg } from "./brand-v3";
import { guardEffectiveSession, withEffectiveReadAuthority } from "./b017-custom-role-governance";
import { PAYMENT_TURN_MATTERS_SQL } from "./b3-payment-turns";
import { query, tx } from "./db";
import { FlowError, logServerError } from "./errors";
import { requireOrgScope } from "./org-guard";
import { assertPerm } from "./perms";
import type { Session } from "./types";

// Brand 3.0 phase 2 §3.2/6/8, accepted R5/R6. Tenant-held matters only.
export type OverdueTurnRow = {
  leaseId: string;
  currency: string;
  amountMinor: string;
  oldestDueDate: string;
  /** Month of the oldest overdue invoice's period, not its due date. */
  oldestMonth: number;
  /** Elapsed property-calendar days; yesterday is 1 (no inclusive +1). */
  dayNumber: number;
  tenantName: string | null;
  place: string;
  /** Unknown: reminder events/attempts have no authenticated SELECT path. */
  reminderCount: number | null;
};
export type StaffOverdueTurns =
  | { state: "off" }
  | { state: "unavailable" }
  | { state: "ready"; count: number; others: OverdueTurnRow[] };
export const OVERDUE_TURN_LIST_LIMIT = 50;
type Deps = {
  v3?: (orgId: string) => Promise<boolean>;
  gates?: (session: Session) => Promise<{ enabled: boolean }>;
  transaction?: typeof tx;
  now?: () => Date;
};

/** Configuration only. The existing B-042 helper includes today_home and allowlist
 * checks; sandbox visibility follows its live parent, never its business data. */
async function overdueGates(session: Session): Promise<{ enabled: boolean }> {
  const row = (await query<{ enabled: boolean }>(
    "SELECT app.b042_flag_on('today_dash', $1::uuid) AS enabled",
    [session.environment === "sandbox" ? session.liveOrgId : session.orgId])).rows[0];
  if (!row) throw new Error("Missing overdue-turn configuration");
  return { enabled: row.enabled === true };
}

/** $1 selected org, $2 one captured instant, $3 selected environment.
 * Reuse the payment reader's complete P1/P2 population verbatim, in this snapshot:
 * no copied predicate that can drift, and no change to existing payment consumers.
 * No active/archive restriction: collectible ended-lease debt remains eligible.
 */
const MATTERS_SQL = `${PAYMENT_TURN_MATTERS_SQL}, overdue_invoices AS (
  SELECT i.id, i.lease_id, i.currency, i.balance_minor, i.due_date, i.period_start,
         ($2::timestamptz AT TIME ZONE pr.timezone)::date AS today
    FROM invoices i
    JOIN leases l ON l.id = i.lease_id AND l.org_id = $1
    JOIN properties pr ON pr.id = l.property_id AND pr.org_id = $1 AND i.property_id = pr.id
    JOIN units u ON u.id = l.unit_id AND u.org_id = $1
    LEFT JOIN rooms r ON r.id = l.target_room_id AND r.org_id = $1
   WHERE i.org_id = $1 AND i.status IN ('open','partially_paid') AND i.balance_minor > 0
     AND i.due_date < ($2::timestamptz AT TIME ZONE pr.timezone)::date
     AND NOT EXISTS (
       SELECT 1 FROM matters m JOIN payments p ON p.id = m.id AND p.org_id = $1
        WHERE p.lease_id = i.lease_id)
     AND ($3::text = 'sandbox' OR NOT EXISTS (
       SELECT 1 FROM sample_marks sm WHERE sm.org_id = $1
         AND ((sm.entity_table = 'invoices' AND sm.entity_id = i.id)
           OR (sm.entity_table = 'leases' AND sm.entity_id = l.id)
           OR (sm.entity_table = 'properties' AND sm.entity_id = pr.id)
           OR (sm.entity_table = 'units' AND sm.entity_id = u.id)
           OR (sm.entity_table = 'rooms' AND sm.entity_id = r.id))))
), overdue AS (
  SELECT lease_id, currency, sum(balance_minor)::text AS amount_minor,
         min(due_date) AS oldest_due_date,
         (array_agg(extract(month FROM period_start)::int ORDER BY due_date, id))[1] AS oldest_month,
         today - min(due_date) AS day_number
    FROM overdue_invoices
   GROUP BY lease_id, currency, today
)`;
export const COUNTS_SQL_FOR_TEST = `${MATTERS_SQL}
SELECT count(*)::int AS count FROM overdue`;
export const LISTS_SQL_FOR_TEST = `${MATTERS_SQL}
SELECT m.lease_id::text, m.currency::text, m.amount_minor, m.oldest_due_date::text,
       m.oldest_month, m.day_number, tenant.display_name AS tenant_name,
       pr.name || ' ' || u.label || coalesce(' ' || r.label, '') AS place
  FROM (SELECT * FROM overdue ORDER BY oldest_due_date, lease_id, currency LIMIT $4) m
  JOIN leases l ON l.id = m.lease_id AND l.org_id = $1
  JOIN properties pr ON pr.id = l.property_id AND pr.org_id = $1
  JOIN units u ON u.id = l.unit_id AND u.org_id = $1
  LEFT JOIN rooms r ON r.id = l.target_room_id AND r.org_id = $1
  LEFT JOIN LATERAL (
    SELECT c.display_name FROM lease_parties lp JOIN contacts c ON c.id = lp.contact_id AND c.org_id = $1
     WHERE lp.org_id = $1 AND lp.lease_id = m.lease_id AND lp.role = 'primary' AND c.archived_at IS NULL
       AND ($3::text = 'sandbox' OR NOT EXISTS (
         SELECT 1 FROM sample_marks sm WHERE sm.org_id = $1 AND sm.entity_table = 'contacts' AND sm.entity_id = c.id))
     ORDER BY lp.id LIMIT 1
  ) tenant ON true
 ORDER BY m.oldest_due_date, m.lease_id, m.currency`;

type ListRow = {
  lease_id: string; currency: string; amount_minor: string; oldest_due_date: string;
  oldest_month: number | null; day_number: number; tenant_name: string | null; place: string;
};

export async function staffOverdueTurns(session: Session, deps: Deps = {}): Promise<StaffOverdueTurns> {
  const v3 = deps.v3 ?? brandV3ReadForOrg;
  const gates = deps.gates ?? overdueGates;
  const transaction = deps.transaction ?? tx;
  try {
    if (!(await v3(session.orgId))) return { state: "off" };
    const admitted = await guardEffectiveSession(session, "pay.record");
    assertPerm(admitted, "pay.record");
    if (!(await gates(admitted)).enabled) return { state: "off" };
    const now = (deps.now ?? (() => new Date()))().toISOString();
    return await transaction(admitted.userId, async client => {
      await client.query("SET LOCAL statement_timeout = '2s'");
      return withEffectiveReadAuthority(client, admitted, "pay.record", async () => {
        const staff = await client.query<{ ok: boolean | null }>(
          "SELECT app.has_role($1::uuid, '{admin,manager,accountant}'::org_role[]) AS ok", [admitted.orgId]);
        if (staff.rows[0]?.ok !== true) throw new FlowError("errors.forbidden");
        const params = [admitted.orgId, now, admitted.environment];
        const count = (await client.query<{ count: number }>(COUNTS_SQL_FOR_TEST, params)).rows[0]?.count;
        if (count === undefined) throw new Error("Missing overdue count");
        const rows = (await client.query<ListRow>(LISTS_SQL_FOR_TEST, [...params, OVERDUE_TURN_LIST_LIMIT])).rows;
        const others = rows.map((r): OverdueTurnRow => {
          // period_start is nullable in the schema. Never invent a rent month from the due
          // date or drop debt silently; invalid required presentation data is unavailable.
          if (r.oldest_month === null || !Number.isInteger(r.oldest_month) || r.oldest_month < 1 || r.oldest_month > 12) {
            throw new Error("Missing overdue invoice period");
          }
          return {
            leaseId: r.lease_id, currency: r.currency, amountMinor: r.amount_minor,
            oldestDueDate: r.oldest_due_date, oldestMonth: r.oldest_month, dayNumber: r.day_number,
            tenantName: r.tenant_name, place: r.place,
            // B010 events/B028 claims and delivery attempts are definer-only. Phase 3 rule
            // 20 needs success on at least one channel; queued/captured is not proof. No
            // service-role fallback, new object, or fabricated zero for unavailable history.
            reminderCount: null,
          };
        });
        return { state: "ready" as const, count, others };
      });
    }, requireOrgScope(admitted), { isolation: "repeatable read", readOnly: true });
  } catch (error) {
    if (error instanceof FlowError && error.key === "errors.forbidden") throw error;
    logServerError("b3_staff_overdue_turns", error);
    return { state: "unavailable" };
  }
}

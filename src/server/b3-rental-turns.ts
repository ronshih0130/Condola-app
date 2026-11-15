import { brandV3ReadForOrg } from "./brand-v3";
import { guardEffectiveSession, withEffectiveReadAuthority } from "./b017-custom-role-governance";
import { query, tx } from "./db";
import { FlowError, logServerError } from "./errors";
import { isMoveOutNoticeGloballyEnabled, moveOutNoticeAdmitted } from "./move-out-notice";
import { requireOrgScope } from "./org-guard";
import { assertPerm } from "./perms";
import type { Session } from "./types";

// Brand 3.0 phase 2 §3.1/3.3/3.4, §6, R2–R4/R6/R7; hub OQ-051 recommendations.
// Projection only: no status changes, invitation issuance or stored turn records.
export type RentalTurnKind = "vacant" | "renewal_ask" | "early_vacancy";
export type RentalTurnRow = {
  kind: RentalTurnKind;
  targetKind: "room" | "unit";
  targetId: string;
  propertyId: string;
  place: string;
  tenantName: string | null;
  leaseId: string | null;
  /** ISO calendar date: vacancy start, lease end or planned departure. */
  date: string | null;
  /** Elapsed vacant days, or days until end/departure. Day zero is zero, not one. */
  dayNumber: number | null;
  /** 待出租 only (MGT-101-AC3): monthly rent lost — room base rent, else unit base rent, else the
   * previous lease's rent. Null when none exists (the money is omitted, never shown as zero). */
  rentMinor: string | null;
  rentCurrency: string | null;
};
export type StaffRentalTurns =
  | { state: "off" }
  | { state: "unavailable" }
  | { state: "ready"; counts: { vacant: number; renewalAsk: number; earlyVacancy: number }; mine: RentalTurnRow[] };

/** All three kinds belong to the same manager-held group. */
export const RENTAL_TURN_LIST_LIMIT = 50;
type Gates = { enabled: boolean; vacant: boolean; earlyVacancy: boolean };
type Deps = {
  v3?: (orgId: string) => Promise<boolean>;
  gates?: (session: Session) => Promise<Gates>;
  transaction?: typeof tx;
  now?: () => Date;
};

/** Configuration only, after admission. b042_flag_on is service-only; do not call it
 * as authenticated or copy its dependency/allowlist rules. No business tables here.
 * B-042 sandbox visibility follows its live parent; item gates use the selected org,
 * just as the existing move-out action does. Business data never follows that parent.
 */
async function rentalGates(session: Session): Promise<Gates> {
  const row = (await query<{ enabled: boolean; vacant: boolean; feature_flags: unknown; move_out: unknown }>(`
    SELECT app.b042_flag_on('today_dash', $2::uuid) AS enabled,
           coalesce(o.feature_flags->'today_dash_vacant' = 'true'::jsonb, false) AS vacant,
           o.feature_flags,
           (SELECT value FROM platform_settings WHERE key = 'move_out_notice') AS move_out
      FROM organizations o WHERE o.id = $1`, [session.orgId, session.environment === "sandbox" ? session.liveOrgId : session.orgId])).rows[0];
  if (!row) throw new Error("Missing rental-turn configuration");
  return {
    enabled: row.enabled === true,
    vacant: row.vacant === true,
    earlyVacancy: isMoveOutNoticeGloballyEnabled() && moveOutNoticeAdmitted(row.move_out, row.feature_flags, session.orgId),
  };
}

/** $1 org, $2 one captured calendar date, $3 environment, $4 vacancy gate, $5 move-out gate.
 * Counts and the capped list use this exact population in one repeatable-read snapshot.
 * R2 explicitly uses the Asia/Taipei calendar; creation timestamps are converted accordingly.
 */
const MATTERS_SQL = `
WITH spaces AS (
  SELECT 'unit'::text AS target_kind, u.id AS target_id, p.id AS property_id,
         p.name || ' ' || u.label AS place, (u.created_at AT TIME ZONE 'Asia/Taipei')::date AS created_on,
         u.base_rent_minor AS base_rent_minor, p.currency::text AS currency
    FROM units u JOIN properties p ON p.id = u.property_id AND p.org_id = $1
   WHERE u.org_id = $1 AND u.rental_mode = 'whole_unit'
     AND p.archived_at IS NULL AND u.archived_at IS NULL
     AND ($3::text = 'sandbox' OR NOT EXISTS (
       SELECT 1 FROM sample_marks sm WHERE sm.org_id = $1
         AND ((sm.entity_table = 'properties' AND sm.entity_id = p.id)
           OR (sm.entity_table = 'units' AND sm.entity_id = u.id))))
  UNION ALL
  SELECT 'room', r.id, p.id, p.name || ' ' || u.label || ' ' || r.label,
         (r.created_at AT TIME ZONE 'Asia/Taipei')::date, coalesce(r.base_rent_minor, u.base_rent_minor), p.currency::text
    FROM rooms r JOIN units u ON u.id = r.unit_id AND u.org_id = $1
    JOIN properties p ON p.id = u.property_id AND p.org_id = $1
   WHERE r.org_id = $1 AND u.rental_mode = 'by_room'
     AND p.archived_at IS NULL AND u.archived_at IS NULL AND r.archived_at IS NULL
     AND ($3::text = 'sandbox' OR NOT EXISTS (
       SELECT 1 FROM sample_marks sm WHERE sm.org_id = $1
         AND ((sm.entity_table = 'properties' AND sm.entity_id = p.id)
           OR (sm.entity_table = 'units' AND sm.entity_id = u.id)
           OR (sm.entity_table = 'rooms' AND sm.entity_id = r.id))))
), scoped_leases AS (
  SELECT l.*, CASE WHEN l.target_room_id IS NOT NULL THEN 'room' ELSE 'unit' END AS target_kind,
         coalesce(l.target_room_id, l.target_unit_id) AS target_id
    FROM leases l
   WHERE l.org_id = $1
     AND ($3::text = 'sandbox' OR NOT EXISTS (
       SELECT 1 FROM sample_marks sm WHERE sm.org_id = $1 AND sm.entity_table = 'leases' AND sm.entity_id = l.id))
), vacant AS (
  SELECT s.*, NULL::uuid AS lease_id, 'vacant'::text AS kind,
         CASE WHEN h.id IS NULL THEN CASE WHEN s.created_on <= $2::date THEN s.created_on END
              WHEN h.departure BETWEEN h.start_date AND $2::date THEN h.departure END AS date,
         coalesce(s.base_rent_minor, h.rent_amount_minor) AS rent_minor,
         -- A lease's currency must equal its property's (enforced), so the property currency applies to every source.
         CASE WHEN coalesce(s.base_rent_minor, h.rent_amount_minor) IS NULL THEN NULL ELSE s.currency END AS rent_currency
    FROM spaces s
    LEFT JOIN LATERAL (
      SELECT l.id, l.start_date, coalesce(l.moved_out_on, l.end_date, l.terminated_on) AS departure,
             l.rent_amount_minor
        FROM scoped_leases l
       WHERE l.target_kind = s.target_kind AND l.target_id = s.target_id AND l.status IN ('ended','terminated')
       ORDER BY coalesce(l.moved_out_on, l.end_date, l.terminated_on) DESC NULLS LAST, l.start_date DESC, l.id DESC
       LIMIT 1
    ) h ON true
   WHERE $4::boolean AND NOT EXISTS (
     SELECT 1 FROM scoped_leases l WHERE l.target_kind = s.target_kind AND l.target_id = s.target_id
       AND l.status IN ('active','pending_signature'))
), current_leases AS (
  SELECT s.*, l.id AS lease_id, l.end_date, l.moved_out_on, l.renewal_status,
         CASE WHEN l.moved_out_on > $2::date THEN l.moved_out_on
              WHEN l.moved_out_on IS NULL AND l.renewal_status = 'declined' THEN l.end_date END AS departure
    FROM spaces s JOIN scoped_leases l ON l.target_kind = s.target_kind AND l.target_id = s.target_id
   WHERE l.status = 'active' AND l.start_date <= $2::date AND l.terminated_on IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM scoped_leases next
        WHERE next.target_kind = l.target_kind AND next.target_id = l.target_id AND next.id <> l.id
          AND next.status IN ('active','pending_signature') AND next.start_date > l.end_date)
), early AS (
  SELECT DISTINCT ON (target_kind, target_id)
         target_kind, target_id, property_id, place, created_on, base_rent_minor, currency, lease_id, 'early_vacancy'::text AS kind, departure AS date,
         NULL::bigint AS rent_minor, NULL::text AS rent_currency
    FROM current_leases
   WHERE $5::boolean AND departure BETWEEN $2::date AND $2::date + 60
   ORDER BY target_kind, target_id, departure, lease_id
), matters AS (
  SELECT * FROM vacant
  UNION ALL
  SELECT * FROM early
  UNION ALL
  SELECT c.target_kind, c.target_id, c.property_id, c.place, c.created_on, c.base_rent_minor, c.currency, c.lease_id, 'renewal_ask', c.end_date,
         NULL::bigint, NULL::text
    FROM current_leases c
   WHERE c.end_date BETWEEN $2::date AND $2::date + 60
     AND c.moved_out_on IS NULL AND c.renewal_status IN ('none','reminder_sent')
     AND NOT EXISTS (SELECT 1 FROM early e WHERE e.target_kind = c.target_kind AND e.target_id = c.target_id)
)`;

export const COUNTS_SQL_FOR_TEST = `${MATTERS_SQL}
SELECT kind, count(*)::int AS count FROM matters GROUP BY kind`;

export const LISTS_SQL_FOR_TEST = `${MATTERS_SQL}
SELECT m.kind, m.target_kind, m.target_id::text, m.property_id::text, m.place, m.lease_id::text,
       m.date::text, CASE WHEN m.kind = 'vacant' THEN $2::date - m.date ELSE m.date - $2::date END AS day_number,
       tenant.display_name AS tenant_name, m.rent_minor::text AS rent_minor, m.rent_currency
  FROM (SELECT * FROM matters
         ORDER BY CASE kind WHEN 'renewal_ask' THEN 0 WHEN 'early_vacancy' THEN 1 ELSE 2 END,
                  date ASC NULLS LAST, coalesce(lease_id, target_id), target_kind
         LIMIT $6) m
  LEFT JOIN LATERAL (
    SELECT c.display_name FROM lease_parties lp JOIN contacts c ON c.id = lp.contact_id AND c.org_id = $1
     WHERE lp.org_id = $1 AND lp.lease_id = m.lease_id AND lp.role = 'primary' AND c.archived_at IS NULL
       AND ($3::text = 'sandbox' OR NOT EXISTS (
         SELECT 1 FROM sample_marks sm WHERE sm.org_id = $1 AND sm.entity_table = 'contacts' AND sm.entity_id = c.id))
     ORDER BY lp.id LIMIT 1
  ) tenant ON true
 ORDER BY CASE m.kind WHEN 'renewal_ask' THEN 0 WHEN 'early_vacancy' THEN 1 ELSE 2 END,
          m.date ASC NULLS LAST, coalesce(m.lease_id, m.target_id), m.target_kind`;

type ListRow = {
  kind: RentalTurnKind; target_kind: RentalTurnRow["targetKind"]; target_id: string; property_id: string;
  place: string; lease_id: string | null; date: string | null; day_number: number | null; tenant_name: string | null;
  rent_minor: string | null; rent_currency: string | null;
};

export async function staffRentalTurns(session: Session, deps: Deps = {}): Promise<StaffRentalTurns> {
  const v3 = deps.v3 ?? brandV3ReadForOrg;
  const gates = deps.gates ?? rentalGates;
  const transaction = deps.transaction ?? tx;
  try {
    if (!(await v3(session.orgId))) return { state: "off" };
    const admitted = await guardEffectiveSession(session, "leases.edit");
    assertPerm(admitted, "leases.edit");
    assertPerm(admitted, "props.view");
    const flags = await gates(admitted);
    if (!flags.enabled) return { state: "off" };
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
    }).format((deps.now ?? (() => new Date()))());
    return await transaction(admitted.userId, async (client) => {
      await client.query("SET LOCAL statement_timeout = '2s'");
      return withEffectiveReadAuthority(client, admitted, "leases.edit", () =>
        withEffectiveReadAuthority(client, admitted, "props.view", async () => {
          const staff = await client.query<{ ok: boolean | null }>(
            "SELECT app.has_role($1::uuid, '{admin,manager}'::org_role[]) AS ok", [admitted.orgId]);
          if (staff.rows[0]?.ok !== true) throw new FlowError("errors.forbidden");
          const params = [admitted.orgId, today, admitted.environment, flags.vacant, flags.earlyVacancy];
          const counts = { vacant: 0, renewalAsk: 0, earlyVacancy: 0 };
          for (const row of (await client.query<{ kind: RentalTurnKind; count: number }>(COUNTS_SQL_FOR_TEST, params)).rows) {
            const key = { vacant: "vacant", renewal_ask: "renewalAsk", early_vacancy: "earlyVacancy" } as const;
            counts[key[row.kind]] = row.count;
          }
          const rows = (await client.query<ListRow>(LISTS_SQL_FOR_TEST, [...params, RENTAL_TURN_LIST_LIMIT])).rows;
          return { state: "ready" as const, counts, mine: rows.map((r): RentalTurnRow => ({
            kind: r.kind, targetKind: r.target_kind, targetId: r.target_id, propertyId: r.property_id,
            place: r.place, tenantName: r.tenant_name, leaseId: r.lease_id, date: r.date, dayNumber: r.day_number,
            rentMinor: r.rent_minor, rentCurrency: r.rent_currency,
          })) };
        }));
    }, requireOrgScope(admitted), { isolation: "repeatable read", readOnly: true });
  } catch (error) {
    if (error instanceof FlowError && error.key === "errors.forbidden") throw error;
    logServerError("b3_staff_rental_turns", error);
    return { state: "unavailable" };
  }
}

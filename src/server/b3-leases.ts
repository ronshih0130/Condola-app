import { brandV3ReadForOrg } from "./brand-v3";
import { customAuthorityAllowsOn, guardEffectiveSession, withEffectiveReadAuthority } from "./b017-custom-role-governance";
import { TENANTS_ADMISSION_SQL } from "./b3-tenants";
import { tx } from "./db";
import { FlowError, logServerError } from "./errors";
import { contactMatch, ilikePattern, LEASE_PLACE, parseListQuery, textSearch } from "./list-search";
import { requireOrgScope } from "./org-guard";
import { assertPerm } from "./perms";
import { isUuid } from "./repair-rules";
import type { Session } from "./types";

// B-071 (Brand 3.0 round 3: 租約), read-only parts. Projections of existing lease data only:
// no new SQL objects, no writes, no stored statuses. Same population as the legacy
// /m/leases list (searchLeases: leases with their primary tenant party).

export type LeasesInput = { q?: string; page?: string };
export type LeaseListRow = {
  id: string; tenant: string; place: string; status: string; endDate: string | null;
  /** 即將到期: an active lease whose end date falls in the next 60 days of its property's calendar. */
  endingSoon: boolean;
};
export type LeasesResult = { state: "off" | "unavailable" } | {
  state: "ready"; q: string; page: number; total: number; filteredCount: number; hasNext: boolean; rows: LeaseListRow[];
};
export type LeaseReady = {
  state: "ready"; id: string; tenant: string; place: string; status: string;
  startDate: string; endDate: string | null; currency: string; rentMinor: string; depositMinor: string; dueDay: number;
};
export type LeaseResult = { state: "off" | "unavailable" | "not_found" } | LeaseReady;
type Deps = { v3?: (orgId: string) => Promise<boolean>; transaction?: typeof tx; now?: () => Date };

export const LEASES_PAGE_SIZE = 50;
/** Same window as the 今天 renewal ask (b3-rental-turns) and MGT-130 (60 days). */
export const LEASE_ENDING_SOON_DAYS = 60;

/** The legacy lease list search terms; without tenants.contact authority the phone/email terms are
 * dropped (the projection loadContactList applies to custom roles). $2 is the bound literal pattern. */
export function leasesSearchTerms(contact: boolean) {
  return contact ? [textSearch(LEASE_PLACE), contactMatch("l.org_id")].join(" OR ")
    : [textSearch(LEASE_PLACE), textSearch(["c.display_name", "coalesce(c.legal_name, '')"])].join(" OR ");
}
const POPULATION = `FROM leases l
 JOIN properties p ON p.id=l.property_id AND p.org_id=l.org_id
 JOIN units u ON u.id=l.unit_id AND u.org_id=l.org_id
 LEFT JOIN rooms r ON r.id=l.target_room_id AND r.org_id=l.org_id
 JOIN lease_parties lp ON lp.lease_id=l.id AND lp.org_id=l.org_id AND lp.role='primary'
 JOIN contacts c ON c.id=lp.contact_id AND c.org_id=l.org_id
 WHERE l.org_id=$1`;
/** $1 org, $2 literal search pattern (or null). total ignores the search; filteredCount applies it. */
export function leasesSummarySql(contact: boolean) {
  return `SELECT count(*)::int AS total,
 count(*) FILTER (WHERE $2::text IS NULL OR ${leasesSearchTerms(contact)})::int AS "filteredCount"
 ${POPULATION}`;
}
/** $1 org, $2 pattern, $3 captured instant, $4 page size + 1, $5 offset. Legacy order (created_at DESC, id). */
export function leasesListSql(contact: boolean) {
  return `SELECT l.id::text, c.display_name AS tenant,
 p.name || ' ' || u.label || coalesce(' ' || r.label, '') AS place,
 l.status::text AS status, l.end_date::text AS "endDate",
 (l.status='active' AND l.end_date IS NOT NULL
   AND l.end_date BETWEEN ($3::timestamptz AT TIME ZONE p.timezone)::date
     AND ($3::timestamptz AT TIME ZONE p.timezone)::date + ${LEASE_ENDING_SOON_DAYS}) AS "endingSoon"
 ${POPULATION}
 AND ($2::text IS NULL OR ${leasesSearchTerms(contact)})
 ORDER BY l.created_at DESC, l.id LIMIT $4 OFFSET $5`;
}
/** $1 org, $2 lease. The legacy leaseDetail population (primary tenant party required). */
export const LEASE_ONE_SQL = `SELECT l.id::text, l.status::text, c.display_name AS tenant,
 p.name || ' ' || u.label || coalesce(' ' || r.label, '') AS place,
 l.start_date::text AS "startDate", l.end_date::text AS "endDate", l.currency::text AS currency,
 l.rent_amount_minor::text AS "rentMinor", l.deposit_amount_minor::text AS "depositMinor", l.due_day AS "dueDay"
 ${POPULATION} AND l.id=$2::uuid
 ORDER BY lp.id LIMIT 1`;

/** R3-LIST: P-ADM, P-MGR only (P-ACC and P-MNT 403). Lease writes are admin/manager (leases.edit). */
export async function brandLeases(session: Session, input: LeasesInput = {}, deps: Deps = {}): Promise<LeasesResult> {
  try {
    if (!(await (deps.v3 ?? brandV3ReadForOrg)(session.orgId))) return { state: "off" };
    const admitted = await guardEffectiveSession(session, "leases.edit");
    assertPerm(admitted, "leases.edit");
    assertPerm(admitted, "props.view");
    if (admitted.needsSandbox) throw new FlowError("errors.forbidden");
    const { q, page } = parseListQuery(input);
    const now = (deps.now ?? (() => new Date()))().toISOString();
    return await (deps.transaction ?? tx)(admitted.userId, async client => {
      await client.query("SET LOCAL statement_timeout = '2s'");
      return withEffectiveReadAuthority(client, admitted, "leases.edit", () =>
        withEffectiveReadAuthority(client, admitted, "props.view", async () => {
          const context = (await client.query<{ role: string }>(TENANTS_ADMISSION_SQL,
            [admitted.orgId, admitted.sessionId, admitted.userId, admitted.environment, admitted.liveOrgId])).rows[0];
          // The actual membership decides, never the session's cached role.
          if (!context || !["admin", "manager"].includes(context.role)) throw new FlowError("errors.forbidden");
          const contact = await customAuthorityAllowsOn(client, admitted, "tenants.contact");
          const pattern = ilikePattern(q);
          const summary = (await client.query<{ total: number; filteredCount: number }>(leasesSummarySql(contact), [admitted.orgId, pattern])).rows[0];
          if (!summary) throw new Error("Missing lease counts");
          const found = (await client.query<LeaseListRow>(leasesListSql(contact),
            [admitted.orgId, pattern, now, LEASES_PAGE_SIZE + 1, (page - 1) * LEASES_PAGE_SIZE])).rows;
          const rows = found.slice(0, LEASES_PAGE_SIZE).map(({ id, tenant, place, status, endDate, endingSoon }) =>
            ({ id, tenant, place, status, endDate, endingSoon: endingSoon === true }));
          return { state: "ready" as const, q, page, total: summary.total, filteredCount: summary.filteredCount,
            hasNext: found.length > LEASES_PAGE_SIZE, rows };
        }));
    }, requireOrgScope(admitted), { isolation: "repeatable read", readOnly: true });
  } catch (error) {
    if (error instanceof FlowError && error.key === "errors.forbidden") throw error;
    logServerError("b3_leases", error);
    return { state: "unavailable" };
  }
}

/** Lease page (概要／押金 read only): P-ADM, P-MGR, P-ACC (R3-FEES/R3-DEP); P-MNT 403. */
export async function brandLease(session: Session, id: string, deps: Deps = {}): Promise<LeaseResult> {
  try {
    if (!(await (deps.v3 ?? brandV3ReadForOrg)(session.orgId))) return { state: "off" };
    const admitted = await guardEffectiveSession(session, "props.view");
    assertPerm(admitted, "props.view");
    if (admitted.needsSandbox) throw new FlowError("errors.forbidden");
    if (!isUuid(id)) return { state: "not_found" };
    return await (deps.transaction ?? tx)(admitted.userId, async client => {
      await client.query("SET LOCAL statement_timeout = '2s'");
      return withEffectiveReadAuthority(client, admitted, "props.view", async () => {
        const context = (await client.query<{ role: string }>(TENANTS_ADMISSION_SQL,
          [admitted.orgId, admitted.sessionId, admitted.userId, admitted.environment, admitted.liveOrgId])).rows[0];
        if (!context) throw new FlowError("errors.forbidden");
        const lease = (await client.query<Omit<LeaseReady, "state">>(LEASE_ONE_SQL, [admitted.orgId, id])).rows[0];
        if (!lease) return { state: "not_found" as const };
        const { tenant, place, status, startDate, endDate, currency, rentMinor, depositMinor, dueDay } = lease;
        return { state: "ready" as const, id: lease.id, tenant, place, status, startDate, endDate, currency, rentMinor, depositMinor, dueDay: Number(dueDay) };
      });
    }, requireOrgScope(admitted), { isolation: "repeatable read", readOnly: true });
  } catch (error) {
    if (error instanceof FlowError && error.key === "errors.forbidden") throw error;
    logServerError("b3_lease", error);
    return { state: "unavailable" };
  }
}

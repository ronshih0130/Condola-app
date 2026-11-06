import { effectiveReadOptions, guardEffectiveSession, withEffectiveReadAuthority } from "@/server/b017-custom-role-governance";
import { customRolesAdmitted, customRolesEnabledOn, customAuthorityAllowsOn, requireEffectivePerm, maskContactFields, resolveCustomRoleSession } from "./b017-custom-role-governance";
import { assertPerm, can, canTicketPhotos, type PermKey } from "./perms";
import type { TenantOption } from "@/tenant-pick";
import type { QueryResultRow } from "pg";
import { query, maybe, many, tx } from "./db";
import {
  LIST_PAGE_SIZE,
  bindList,
  leaseSearchSql,
  parseListQuery,
  propertySearchSql,
  slicePage,
  spaceSearchSql,
  tenantContactSearchSql,
  type ListOpts,
} from "./list-search";
import { rentUtilityDueMinor, tenantBillLines } from "./money";
import type { Session } from "./types";
import {
  tenantSignedPdfGloballyEnabled,
  tenantSignedPdfOn,
} from "./tenant-signed-pdf-rules";
import { requireOrgScope } from "./org-guard";

/** Layouts and pages render concurrently; every reader owns its admission. */
async function admitCustomRead(session: Session, key: PermKey) {
  if (session.kind !== "staff") return;
  if (session.customRole || customRolesAdmitted(session.orgId)) {
    const current = customRolesAdmitted(session.orgId) ? await resolveCustomRoleSession(session) : session;
    if (current.customRole) assertPerm(current, key);
  }
}

export type Tryout = { property: boolean; lease: boolean; statement: boolean; repair: boolean };

const EMPTY_TRYOUT: Tryout = { property: false, lease: false, statement: false, repair: false };

export async function loadTryout(session: Session): Promise<Tryout> {
  session = await guardEffectiveSession(session, null);
  try {
    return await tx(session.userId, async (client) => withEffectiveReadAuthority(client, session, null, async () => {
      const row = await maybe<{ settings: { tryout?: Partial<Tryout> } }>(
        client,
        `SELECT settings FROM organizations WHERE id = $1`,
        [session.orgId],
      );
      const flags = row?.settings?.tryout ?? {};
      return {
        property: Boolean(flags.property),
        lease: Boolean(flags.lease),
        statement: Boolean(flags.statement),
        repair: Boolean(flags.repair),
      };
    }), requireOrgScope(session), effectiveReadOptions(session));
  } catch {
    return EMPTY_TRYOUT;
  }
}

export async function loadManagerChrome(session: Session) {
  const empty = {
    flags: EMPTY_TRYOUT,
    firm: { name: "", bankName: "", last5: "", defaultLocale: "zh-TW" as const },
    badge: { pending: 0, tickets: 0 },
  };
  if (session.customRole) return empty;
  try {
    session = await guardEffectiveSession(session, null);
    return await tx(session.userId, async (client) => withEffectiveReadAuthority(client, session, null, async () => {
      const row = await maybe<{ settings: { tryout?: Partial<Tryout> }; name: string; default_locale: string }>(
        client,
        `SELECT settings, name, default_locale FROM organizations WHERE id = $1`,
        [session.orgId],
      );
      const flags = row?.settings?.tryout ?? {};
      const bank = session.customRole && !can(session, "bank.reconcile") ? null : await maybe<{ bank_name: string; account_last5: string }>(
        client,
        `SELECT bank_name, account_last5 FROM bank_accounts
          WHERE org_id = $1 AND archived_at IS NULL AND show_to_tenants ORDER BY created_at LIMIT 1`,
        [session.orgId],
      );
      const countsRow = session.customRole ? {
        pending: can(session, "pay.record") ? (await many<{ n: string }>(client, "SELECT count(*)::text AS n FROM payments WHERE org_id=$1 AND status='submitted'", [session.orgId]))[0].n : "0",
        tickets: can(session, "tickets.update") ? (await many<{ n: string }>(client, "SELECT count(*)::text AS n FROM maintenance_tickets WHERE org_id=$1 AND status NOT IN ('resolved','closed','cancelled')", [session.orgId]))[0].n : "0",
      } : await maybe<{ pending: string; tickets: string }>(
        client,
        `SELECT
           (SELECT count(*)::text FROM payments WHERE org_id = $1 AND status = 'submitted') AS pending,
           (SELECT count(*)::text FROM maintenance_tickets WHERE org_id = $1 AND status NOT IN ('resolved','closed','cancelled')) AS tickets`,
        [session.orgId],
      );
      return {
        flags: {
          property: Boolean(flags.property),
          lease: Boolean(flags.lease),
          statement: Boolean(flags.statement),
          repair: Boolean(flags.repair),
        },
        firm: {
          name: row?.name ?? "",
          bankName: bank?.bank_name ?? "",
          last5: bank?.account_last5 ?? "",
          defaultLocale: (row?.default_locale === "en" ? "en" : "zh-TW") as "zh-TW" | "en",
        },
        badge: { pending: Number(countsRow?.pending ?? 0), tickets: Number(countsRow?.tickets ?? 0) },
      };
    }), requireOrgScope(session), effectiveReadOptions(session));
  } catch {
    return empty;
  }
}

export async function loadFirm(session: Session) {
  session = await guardEffectiveSession(session, null);
  return tx(session.userId, async (client) => withEffectiveReadAuthority(client, session, null, async () => {
    const org = await maybe<{ name: string; default_locale: string }>(
      client,
      `SELECT name, default_locale FROM organizations WHERE id = $1`,
      [session.orgId],
    );
    const bank = await maybe<{ bank_name: string; account_last5: string }>(
      client,
      `SELECT bank_name, account_last5 FROM bank_accounts
        WHERE org_id = $1 AND archived_at IS NULL AND show_to_tenants ORDER BY created_at LIMIT 1`,
      [session.orgId],
    );
    const locale = org?.default_locale === "en" ? "en" : "zh-TW";
    return { name: org?.name ?? "", bankName: bank?.bank_name ?? "", last5: bank?.account_last5 ?? "", defaultLocale: locale as "zh-TW" | "en" };
  }), requireOrgScope(session), effectiveReadOptions(session));
}

export async function dashboard(session: Session) {
  session = await guardEffectiveSession(session, "dash.view");
  await admitCustomRead(session, "dash.view");
  return tx(session.userId, async (client) => withEffectiveReadAuthority(client, session, "dash.view", async () => {
    const money = await maybe<{ received: string; outstanding: string; owing: string }>(
      client,
      `SELECT
         (SELECT coalesce(sum(amount_minor),0)::text FROM payments
           WHERE org_id = $1 AND status = 'confirmed' AND paid_on >= date_trunc('month', current_date)::date) AS received,
         (SELECT coalesce(sum(balance_minor),0)::text FROM invoices
           WHERE org_id = $1 AND status IN ('open','partially_paid')) AS outstanding,
         (SELECT count(DISTINCT lease_id)::text FROM invoices
           WHERE org_id = $1 AND status IN ('open','partially_paid') AND balance_minor > 0) AS owing`,
      [session.orgId],
    );
    const counts = await maybe<{ pending: string; tickets: string; rooms: string; occupied: string }>(
      client,
      `SELECT
         (SELECT count(*)::text FROM payments WHERE org_id = $1 AND status = 'submitted') AS pending,
         (SELECT count(*)::text FROM maintenance_tickets WHERE org_id = $1 AND status NOT IN ('resolved','closed','cancelled')) AS tickets,
         (
           (SELECT count(*) FROM rooms r JOIN units u ON u.id = r.unit_id
             WHERE r.org_id = $1 AND r.archived_at IS NULL AND u.archived_at IS NULL AND u.rental_mode = 'by_room')
           + (SELECT count(*) FROM units u
               WHERE u.org_id = $1 AND u.archived_at IS NULL AND u.rental_mode = 'whole_unit')
         )::text AS rooms,
         (
           (SELECT count(DISTINCT l.target_room_id) FROM leases l
              JOIN rooms r ON r.id = l.target_room_id
              JOIN units u ON u.id = r.unit_id
             WHERE l.org_id = $1 AND l.status IN ('pending_signature','active') AND u.rental_mode = 'by_room')
           + (SELECT count(DISTINCT l.target_unit_id) FROM leases l
               JOIN units u ON u.id = l.target_unit_id
              WHERE l.org_id = $1 AND l.status IN ('pending_signature','active') AND u.rental_mode = 'whole_unit')
         )::text AS occupied`,
      [session.orgId],
    );
    const properties = await many<{ id: string; name: string; received: string; billed: string }>(
      client,
      `SELECT p.id::text, p.name,
              coalesce((SELECT sum(pay.amount_minor) FROM payments pay
                 JOIN leases l ON l.id = pay.lease_id
                WHERE l.property_id = p.id AND pay.status = 'confirmed'
                  AND pay.paid_on >= date_trunc('month', current_date)::date),0)::text AS received,
              coalesce((SELECT sum(i.total_minor) FROM invoices i
                WHERE i.property_id = p.id AND i.issue_date >= date_trunc('month', current_date)::date
                  AND i.status <> 'void'),0)::text AS billed
         FROM properties p
        WHERE p.org_id = $1 AND p.archived_at IS NULL
        ORDER BY p.name`,
      [session.orgId],
    );
    const owing = await many<{ lease_id: string; tenant: string; place: string; balance: string; currency: string }>(
      client,
      `SELECT l.id::text AS lease_id, c.display_name AS tenant,
              p.name || coalesce(' ' || r.label, '') AS place,
              i.balance_minor::text AS balance, i.currency
         FROM invoices i
         JOIN leases l ON l.id = i.lease_id
         JOIN properties p ON p.id = l.property_id
         LEFT JOIN rooms r ON r.id = l.target_room_id
         JOIN lease_parties lp ON lp.lease_id = l.id AND lp.role = 'primary'
         JOIN contacts c ON c.id = lp.contact_id
        WHERE i.org_id = $1 AND i.status IN ('open','partially_paid') AND i.balance_minor > 0
        ORDER BY i.due_date
        LIMIT 8`,
      [session.orgId],
    );
    const expiring = await many<{ lease_id: string; tenant: string; place: string; end_date: string }>(
      client,
      `SELECT l.id::text AS lease_id, c.display_name AS tenant,
              p.name || ' ' || u.label || coalesce(' ' || r.label, '') AS place,
              l.end_date::text AS end_date
         FROM leases l
         JOIN properties p ON p.id = l.property_id
         JOIN units u ON u.id = l.unit_id
         LEFT JOIN rooms r ON r.id = l.target_room_id
         JOIN lease_parties lp ON lp.lease_id = l.id AND lp.role = 'primary'
         JOIN contacts c ON c.id = lp.contact_id
        WHERE l.org_id = $1 AND l.status = 'active' AND l.end_date IS NOT NULL
          AND l.end_date <= (current_date + interval '11 months')::date
        ORDER BY l.end_date
        LIMIT 8`,
      [session.orgId],
    );
    return {
      received: Number(money?.received ?? 0),
      outstanding: Number(money?.outstanding ?? 0),
      owingCount: Number(money?.owing ?? 0),
      pending: Number(counts?.pending ?? 0),
      tickets: Number(counts?.tickets ?? 0),
      rooms: Number(counts?.rooms ?? 0),
      occupied: Number(counts?.occupied ?? 0),
      properties,
      owing,
      expiring,
    };
  }), requireOrgScope(session), effectiveReadOptions(session));
}

type PropertyListRow = {
  id: string;
  name: string;
  address_display: string;
  currency: string;
  rental_mode: string;
  rooms: string;
  occupied: string;
  owner_name: string | null;
};

const PROPERTY_LIST_SQL = `SELECT p.id::text, p.name, coalesce(p.address_display,'') AS address_display, p.currency,
              p.default_rental_mode::text AS rental_mode,
              (
                (SELECT count(*) FROM rooms r JOIN units u ON u.id = r.unit_id
                  WHERE u.property_id = p.id AND r.archived_at IS NULL AND u.archived_at IS NULL AND u.rental_mode = 'by_room')
                + (SELECT count(*) FROM units u
                    WHERE u.property_id = p.id AND u.archived_at IS NULL AND u.rental_mode = 'whole_unit')
              )::text AS rooms,
              (
                (SELECT count(DISTINCT l.target_room_id) FROM leases l
                   JOIN rooms r ON r.id = l.target_room_id
                   JOIN units u ON u.id = r.unit_id
                  WHERE l.property_id = p.id AND l.status IN ('pending_signature','active') AND u.rental_mode = 'by_room')
                + (SELECT count(DISTINCT l.target_unit_id) FROM leases l
                    JOIN units u ON u.id = l.target_unit_id
                   WHERE l.property_id = p.id AND l.status IN ('pending_signature','active') AND u.rental_mode = 'whole_unit')
              )::text AS occupied,
              (SELECT c.display_name FROM property_owners po JOIN contacts c ON c.id = po.owner_contact_id
                WHERE po.property_id = p.id AND po.is_primary LIMIT 1) AS owner_name
         FROM properties p
        WHERE p.org_id = $1 AND p.archived_at IS NULL
          ${propertySearchSql()}
        ORDER BY p.created_at, p.id`;

const PROPERTY_LIST_ORDER = "ORDER BY p.created_at, p.id";

function listScope(session: Session) { return requireOrgScope(session); }

async function loadList<T extends QueryResultRow>(
  client: Parameters<typeof many>[0],
  sql: string,
  order: string,
  bound: ReturnType<typeof bindList>,
) {
  const rows = await many<T>(client, `${sql} ${bound.pageSql}`, bound.params);
  const counted =
    bound.limit === null
      ? null
      : await maybe<{ n: number }>(
          client,
          `SELECT count(*)::int AS n FROM (${sql.slice(0, sql.lastIndexOf(order))}) counted`,
          bound.params.slice(0, 2),
        );
  const total = bound.limit === null ? rows.length : Number(counted?.n ?? 0);
  return slicePage(rows, bound.limit, total, bound.page);
}

async function loadContactList<T extends QueryResultRow>(client: import("pg").Client, session: Session, sql: string, order: string, bound: ReturnType<typeof bindList>) {
  if (session.kind !== "staff" || (!session.customRole && (!customRolesAdmitted(session.orgId) || !await customRolesEnabledOn(client, session.orgId)))) return loadList<T>(client,sql,order,bound);
  await requireEffectivePerm(client,session,"props.view");
  const contact = await customAuthorityAllowsOn(client,session,"tenants.contact");
  const source = contact ? sql : sql.replace(/app\.has_role\([^)]*'\{admin,manager,maintenance\}'\)/g,"false");
  const result = await loadList<T>(client,source,order,bound);
  return contact ? result : maskContactFields(result);
}

async function queryProperties(session: Session, opts?: ListOpts) {
  const bound = bindList(session.orgId, opts);
  return tx(
    session.userId,
    (client) => loadContactList<PropertyListRow>(client, session, PROPERTY_LIST_SQL, PROPERTY_LIST_ORDER, bound),
    listScope(session), effectiveReadOptions(session),
  );
}

export async function listProperties(session: Session) {
  session = await guardEffectiveSession(session, "props.view");
  await admitCustomRead(session, "props.view");
  return (await queryProperties(session)).rows;
}

export async function searchProperties(session: Session, raw?: { q?: string; page?: string | number; limit?: number }) {
  session = await guardEffectiveSession(session, "props.view");
  await admitCustomRead(session, "props.view");
  const parsed = parseListQuery(raw);
  const result = await queryProperties(session, { q: parsed.q, page: parsed.page, limit: raw?.limit ?? LIST_PAGE_SIZE });
  return { ...result, q: parsed.q, page: parsed.page };
}

export async function propertyDetail(session: Session, id: string) {
  session = await guardEffectiveSession(session, "props.view");
  await admitCustomRead(session, "props.view");
  return tx(session.userId, async (client) => withEffectiveReadAuthority(client, session, "props.view", async () => {
    const property = await maybe<{
      id: string;
      name: string;
      address_display: string;
      currency: string;
      rental_mode: string;
      archiveState: "active" | "archived";
    }>(
      client,
      `SELECT id::text, name, coalesce(address_display,'') AS address_display, currency, default_rental_mode::text AS rental_mode,
              CASE WHEN archived_at IS NULL THEN 'active' ELSE 'archived' END AS "archiveState"
         FROM properties WHERE id = $1 AND org_id = $2`,
      [id, session.orgId],
    );
    if (!property) return null;
    const owner = await maybe<{ id: string; contact_id: string; name: string; phone_visible: boolean }>(
      client,
      `SELECT po.id::text, po.owner_contact_id::text AS contact_id, c.display_name AS name,
              po.can_view_tenant_phone AS phone_visible
         FROM property_owners po JOIN contacts c ON c.id = po.owner_contact_id
        WHERE po.property_id = $1 AND po.is_primary LIMIT 1`,
      [id],
    );
    const rooms = await many<{
      id: string;
      unit_label: string;
      label: string;
      room_type: string;
      base_rent_minor: string;
      lease_id: string | null;
      tenant: string | null;
    }>(
      client,
      `SELECT r.id::text, u.label AS unit_label, r.label, r.room_type::text, r.base_rent_minor::text,
              l.id::text AS lease_id, c.display_name AS tenant
         FROM rooms r
         JOIN units u ON u.id = r.unit_id
         LEFT JOIN leases l ON l.target_room_id = r.id AND l.status IN ('pending_signature','active')
         LEFT JOIN lease_parties lp ON lp.lease_id = l.id AND lp.role = 'primary'
         LEFT JOIN contacts c ON c.id = lp.contact_id
        WHERE u.property_id = $1 AND r.archived_at IS NULL AND u.archived_at IS NULL AND u.rental_mode = 'by_room'
        ORDER BY u.label, r.label`,
      [id],
    );
    const meter = await maybe<{ serial_number: string | null }>(
      client,
      `SELECT serial_number FROM meters
        WHERE property_id = $1 AND utility = 'electricity' AND room_id IS NULL AND archived_at IS NULL
        ORDER BY created_at LIMIT 1`,
      [id],
    );
    const meterSerial = meter?.serial_number?.trim() ? meter.serial_number.trim() : null;
    const repairs = await many<{
      id: string;
      number: string;
      title: string;
      status: string;
      place: string;
      vendor_name: string | null;
      scheduled_on: string | null;
      completed_on: string | null;
      final_cost: string | null;
      currency: string | null;
    }>(
      client,
      `SELECT t.id::text, t.ticket_number::text AS number, t.title, t.status::text,
              coalesce(r.label, u.label, '') AS place, t.vendor_name,
              t.scheduled_on::text, t.completed_on::text, t.final_cost_minor::text AS final_cost, t.currency
         FROM maintenance_tickets t
         LEFT JOIN units u ON u.id = t.unit_id
         LEFT JOIN rooms r ON r.id = t.room_id
        WHERE t.property_id = $1
        ORDER BY t.created_at DESC
        LIMIT 50`,
      [id],
    );
    const wholes = await many<{ id: string; label: string; base_rent_minor: string }>(
      client,
      `SELECT u.id::text, u.label, coalesce(u.base_rent_minor, 0)::text AS base_rent_minor
         FROM units u
        WHERE u.property_id = $1 AND u.org_id = $2 AND u.rental_mode = 'whole_unit' AND u.archived_at IS NULL
        ORDER BY u.label`,
      [id, session.orgId],
    );
    const byRoomUnits = await many<{id:string;label:string}>(client, `SELECT u.id::text,u.label FROM units u JOIN properties p ON p.org_id=u.org_id AND p.id=u.property_id WHERE u.org_id=$1 AND u.property_id=$2 AND p.archived_at IS NULL AND u.archived_at IS NULL AND u.rental_mode='by_room' ORDER BY u.label,u.id`,[session.orgId,id]);
    return { property, owner, rooms, wholes, byRoomUnits, meterSerial, repairs };
  }, true), requireOrgScope(session), effectiveReadOptions(session));
}

export async function listOwners(session: Session) {
  session = await guardEffectiveSession(session, "props.view");
  await admitCustomRead(session, "props.view");
  return tx(session.userId, async (client) =>
    withEffectiveReadAuthority(client, session, "props.view", async () => many<{ id: string; name: string }>(
      client,
      `SELECT id::text, display_name AS name FROM contacts
        WHERE org_id = $1 AND is_owner AND archived_at IS NULL
        ORDER BY display_name`,
      [session.orgId],
    ), true), requireOrgScope(session), effectiveReadOptions(session),
  );
}

/** Active 租客 contacts in the signed-in firm. RLS hides every other firm. */
export async function listTenants(session: Session): Promise<TenantOption[]> {
  session = await guardEffectiveSession(session, "props.view");
  await admitCustomRead(session, "props.view");
  return tx(
    session.userId,
    async (client) =>
      withEffectiveReadAuthority(client, session, "props.view", async () => many<TenantOption>(
        client,
        `SELECT id::text, display_name AS name, phone_e164 AS phone, email::text AS email
           FROM contacts
          WHERE org_id = $1 AND is_tenant AND archived_at IS NULL
          ORDER BY display_name, id`,
        [session.orgId],
      ), true),
    { orgId: session.orgId, environment: session.environment }, effectiveReadOptions(session),
  );
}

type TenantListRow = {
  id: string;
  tenant: string;
  contact_id: string;
  place: string;
  status: string;
  lease_count: string;
};

/**
 * One row per 租客 contact. Other primary leases are a count, not extra rows.
 * The search predicate stays on `contacts c` only.
 */
const TENANT_LIST_SQL = `SELECT (array_agg(l.id::text ORDER BY l.created_at DESC, l.id))[1] AS id,
              c.display_name AS tenant,
              c.id::text AS contact_id,
              (array_agg(p.name || ' ' || u.label || coalesce(' ' || r.label, '') ORDER BY l.created_at DESC, l.id))[1] AS place,
              (array_agg(l.status::text ORDER BY l.created_at DESC, l.id))[1] AS status,
              count(*)::text AS lease_count
         FROM contacts c
         JOIN lease_parties lp ON lp.contact_id = c.id AND lp.role = 'primary' AND lp.org_id = c.org_id
         JOIN leases l ON l.id = lp.lease_id
         JOIN properties p ON p.id = l.property_id
         JOIN units u ON u.id = l.unit_id
         LEFT JOIN rooms r ON r.id = l.target_room_id
        WHERE c.org_id = $1 AND c.is_tenant AND c.archived_at IS NULL
          ${tenantContactSearchSql()}
        GROUP BY c.id, c.display_name
        ORDER BY c.display_name, c.id`;

const TENANT_LIST_ORDER = "ORDER BY c.display_name, c.id";

async function queryTenants(session: Session, opts?: ListOpts) {
  const bound = bindList(session.orgId, opts);
  return tx(
    session.userId,
    (client) => loadContactList<TenantListRow>(client, session, TENANT_LIST_SQL, TENANT_LIST_ORDER, bound),
    listScope(session), effectiveReadOptions(session),
  );
}

export async function searchTenants(session: Session, raw?: { q?: string; page?: string | number; limit?: number }) {
  session = await guardEffectiveSession(session, "props.view");
  await admitCustomRead(session, "props.view");
  const parsed = parseListQuery(raw);
  const result = await queryTenants(session, { q: parsed.q, page: parsed.page, limit: raw?.limit ?? LIST_PAGE_SIZE });
  return { ...result, q: parsed.q, page: parsed.page };
}

export type RoomLeaseSpan = { start: string; end: string };

export type RoomOption = {
  id: string;
  label: string;
  unitLabel: string;
  propertyName: string;
  currency: string;
  baseRentMinor: number;
  unitRooms: { id: string; label: string; occupied: boolean }[];
  leases: RoomLeaseSpan[];
};

export async function vacantRooms(session: Session): Promise<RoomOption[]> {
  session = await guardEffectiveSession(session, "leases.edit");
  await admitCustomRead(session, "leases.edit");
  return tx(session.userId, async (client) => withEffectiveReadAuthority(client, session, "leases.edit", async () => {
    const rows = await many<{
      id: string;
      label: string;
      unit_id: string;
      unit_label: string;
      property_name: string;
      currency: string;
      base_rent_minor: string;
      kind: string;
    }>(
      client,
      `SELECT id, label, unit_id, unit_label, property_name, currency, base_rent_minor, kind
         FROM (
           SELECT r.id::text AS id, r.label, u.id::text AS unit_id, u.label AS unit_label,
                  p.name AS property_name, p.currency, r.base_rent_minor::text AS base_rent_minor,
                  'room'::text AS kind, p.created_at, 0 AS rank
             FROM rooms r
             JOIN units u ON u.id = r.unit_id AND u.org_id = r.org_id
             JOIN properties p ON p.id = u.property_id AND p.org_id = u.org_id
            WHERE r.org_id = $1 AND r.archived_at IS NULL AND u.archived_at IS NULL AND p.archived_at IS NULL
              AND u.rental_mode = 'by_room'
           UNION ALL
           SELECT u.id::text, ''::text, u.id::text, u.label, p.name, p.currency,
                  u.base_rent_minor::text, 'whole_unit'::text, p.created_at, 1
             FROM units u
             JOIN properties p ON p.id = u.property_id AND p.org_id = u.org_id
            WHERE u.org_id = $1 AND u.archived_at IS NULL AND p.archived_at IS NULL
              AND u.rental_mode = 'whole_unit'
         ) spaces
        ORDER BY created_at DESC, rank, label`,
      [session.orgId],
    );
    const unitIds = [...new Set(rows.map((row) => row.unit_id))];
    const spaceIds = rows.map((row) => row.id);
    const leaseRows = spaceIds.length
      ? await many<{
          id: string;
          unit_id: string;
          target_room_id: string | null;
          target_unit_id: string | null;
          start_date: string;
          end_date: string;
        }>(
          client,
          `SELECT l.id::text, l.unit_id::text, l.target_room_id::text, l.target_unit_id::text,
                  l.start_date::text AS start_date, coalesce(l.end_date, l.start_date)::text AS end_date
             FROM leases l
            WHERE l.org_id = $1
              AND l.status IN ('pending_signature','active')
              AND (
                l.target_room_id = ANY($2::uuid[])
                OR l.target_unit_id = ANY($2::uuid[])
                OR l.unit_id = ANY($2::uuid[])
              )
            ORDER BY l.start_date, l.id`,
          [session.orgId, [...new Set([...spaceIds, ...unitIds])]],
        )
      : [];
    const siblings = unitIds.length
      ? await many<{ id: string; unit_id: string; label: string; occupied: boolean }>(
          client,
          `SELECT r.id::text, r.unit_id::text, r.label,
                  EXISTS (
                    SELECT 1 FROM leases l
                     WHERE l.target_room_id = r.id
                       AND l.status IN ('pending_signature','active')
                  ) AS occupied
             FROM rooms r
             JOIN units u ON u.id = r.unit_id
            WHERE r.unit_id = ANY($1::uuid[]) AND r.archived_at IS NULL AND u.rental_mode = 'by_room'
            ORDER BY r.label`,
          [unitIds],
        )
      : [];
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      unitLabel: row.unit_label,
      propertyName: row.property_name,
      currency: row.currency,
      baseRentMinor: Number(row.base_rent_minor),
      unitRooms: siblings
        .filter((room) => room.unit_id === row.unit_id)
        .map((room) => ({ id: room.id, label: room.label, occupied: room.occupied })),
      leases: leaseRows
        .filter((lease) =>
          row.kind === "room"
            ? lease.target_room_id === row.id || lease.target_unit_id === row.unit_id
            : lease.target_unit_id === row.id || (lease.unit_id === row.unit_id && lease.target_room_id !== null),
        )
        .map((lease) => ({ start: lease.start_date, end: lease.end_date })),
    }));
  }), { orgId: session.orgId, environment: session.environment }, effectiveReadOptions(session));
}

type LeaseListRow = {
  id: string;
  status: string;
  esign: string;
  tenant: string;
  contact_id: string;
  place: string;
  rent: string;
  deposit: string;
  currency: string;
  start_date: string;
  end_date: string;
  electricity: string;
};

const LEASE_LIST_SQL = `SELECT l.id::text, l.status::text, l.esign_status::text AS esign, c.display_name AS tenant,
              c.id::text AS contact_id,
              p.name || ' ' || u.label || coalesce(' ' || r.label, '') AS place,
              l.rent_amount_minor::text AS rent, l.deposit_amount_minor::text AS deposit, l.currency,
              l.start_date::text, l.end_date::text,
              coalesce(
                (SELECT r.split_method::text
                   FROM utility_allocation_lines line
                   JOIN utility_allocation_runs r ON r.id = line.run_id
                  WHERE line.lease_id = l.id
                    AND r.status <> 'void'
                  -- Latest non-void run for the period. A recalculation supersedes the original.
                  ORDER BY r.period_start DESC, r.computed_at DESC, r.id DESC
                  LIMIT 1),
                -- A pending lease is not on the split yet. Show the unit's current run, not the meter method from the first save.
                (SELECT r.split_method::text
                   FROM utility_allocation_runs r
                   JOIN meters m ON m.id = r.meter_id
                  WHERE m.unit_id = l.unit_id
                    AND m.utility = 'electricity'
                    AND m.room_id IS NULL
                    AND m.archived_at IS NULL
                    AND r.status <> 'void'
                  ORDER BY r.period_start DESC, r.computed_at DESC, r.id DESC
                  LIMIT 1),
                (SELECT m.split_method::text
                   FROM meters m
                  WHERE m.unit_id = l.unit_id AND m.utility = 'electricity'
                    AND m.room_id IS NULL AND m.archived_at IS NULL
                  ORDER BY m.created_at DESC
                  LIMIT 1),
                ''
              ) AS electricity
         FROM leases l
         JOIN properties p ON p.id = l.property_id
         JOIN units u ON u.id = l.unit_id
         LEFT JOIN rooms r ON r.id = l.target_room_id
         JOIN lease_parties lp ON lp.lease_id = l.id AND lp.role = 'primary'
         JOIN contacts c ON c.id = lp.contact_id
        WHERE l.org_id = $1
          ${leaseSearchSql()}
        ORDER BY l.created_at DESC, l.id`;

const LEASE_LIST_ORDER = "ORDER BY l.created_at DESC, l.id";

async function queryLeases(session: Session, opts?: ListOpts) {
  const bound = bindList(session.orgId, opts);
  return tx(
    session.userId,
    (client) => loadContactList<LeaseListRow>(client, session, LEASE_LIST_SQL, LEASE_LIST_ORDER, bound),
    listScope(session), effectiveReadOptions(session),
  );
}

export async function listLeases(session: Session) {
  session = await guardEffectiveSession(session, "props.view");
  await admitCustomRead(session, "props.view");
  return (await queryLeases(session)).rows;
}

export async function searchLeases(session: Session, raw?: { q?: string; page?: string | number; limit?: number }) {
  session = await guardEffectiveSession(session, "props.view");
  await admitCustomRead(session, "props.view");
  const parsed = parseListQuery(raw);
  const result = await queryLeases(session, { q: parsed.q, page: parsed.page, limit: raw?.limit ?? LIST_PAGE_SIZE });
  return { ...result, q: parsed.q, page: parsed.page };
}

export async function leaseDetail(session: Session, id: string) {
  session = await guardEffectiveSession(session, "props.view");
  await admitCustomRead(session, "props.view");
  return tx(session.userId, async (client) => withEffectiveReadAuthority(client, session, "props.view", async () => {
    const lease = await maybe<{
      id: string;
      status: string;
      esign: string;
      currency: string;
      rent: string;
      deposit: string;
      due_day: number;
      start_date: string;
      end_date: string;
      place: string;
      tenant_contact_id: string;
      tenant_user_id: string | null;
      tenant: string;
      phone: string | null;
      email: string | null;
      line_user_id: string | null;
      signed_pdf: string | null;
      thread_id: string | null;
      deposit_months: string | null;
      deposit_override_reason: string | null;
      updated_at: string;
      signed_at: string | null;
      first_period_basis: unknown;
      rent_frequency: string;
      archiveState: "active" | "archived" | "inherited";
    }>(
      client,
      `SELECT l.id::text, l.status::text, l.esign_status::text AS esign, l.currency,
              l.rent_amount_minor::text AS rent, l.deposit_amount_minor::text AS deposit, l.due_day,
              l.deposit_months::text AS deposit_months, l.deposit_override_reason,
              l.updated_at::text AS updated_at, l.signed_at::text AS signed_at,
              l.start_date::text, l.end_date::text, l.first_period_basis, l.rent_frequency::text,
              CASE WHEN (l.target_room_id IS NOT NULL AND r.archived_at IS NOT NULL) OR (l.target_room_id IS NULL AND u.archived_at IS NOT NULL) THEN 'archived'
                   WHEN p.archived_at IS NOT NULL OR u.archived_at IS NOT NULL THEN 'inherited' ELSE 'active' END AS "archiveState",
              p.name || ' ' || u.label || coalesce(' ' || r.label, '') AS place,
              c.id::text AS tenant_contact_id,
              c.user_id::text AS tenant_user_id,
              c.display_name AS tenant,
              CASE WHEN app.has_role(l.org_id, '{admin,manager,maintenance}') THEN c.phone_e164 END AS phone,
              c.email,
              c.line_user_id,
              (SELECT f.file_name FROM lease_signed_pdfs pdf
                 JOIN files f ON f.id = pdf.file_id
                WHERE pdf.lease_id = l.id
                ORDER BY pdf.created_at DESC LIMIT 1) AS signed_pdf,
              (SELECT t.id::text FROM message_threads t WHERE t.lease_id = l.id AND t.kind = 'lease' LIMIT 1) AS thread_id
         FROM leases l
         JOIN properties p ON p.id = l.property_id
         JOIN units u ON u.id = l.unit_id
         LEFT JOIN rooms r ON r.id = l.target_room_id
         JOIN lease_parties lp ON lp.lease_id = l.id AND lp.role = 'primary'
         JOIN contacts c ON c.id = lp.contact_id
        WHERE l.id = $1 AND l.org_id = $2`,
      [id, session.orgId],
    );
    if (!lease) return null;
    const signatures = await many<{ role: string; status: string; signed_name: string | null; signed_at: string | null }>(
      client,
      `SELECT signer_role::text AS role, status::text, signed_name, signed_at::text
         FROM lease_signatures WHERE lease_id = $1 ORDER BY signing_order`,
      [id],
    );
    const invoices = await many<{
      id: string;
      status: string;
      total: string;
      paid: string;
      balance: string;
      currency: string;
      due_date: string;
    }>(
      client,
      `SELECT id::text, status::text, total_minor::text AS total, paid_minor::text AS paid,
              balance_minor::text AS balance, currency, due_date::text
         FROM invoices WHERE lease_id = $1 AND status <> 'void' ORDER BY issue_date, created_at`,
      [id],
    );
    const lines = invoices.length
      ? await many<{ id: string; invoice_id: string; charge_type: string; amount: string; description: string }>(
          client,
          `SELECT id::text, invoice_id::text, charge_type::text, amount_minor::text AS amount, description
             FROM invoice_lines WHERE invoice_id = ANY($1::uuid[]) ORDER BY line_no`,
          [invoices.map((invoice) => invoice.id)],
        )
      : [];
    const open = invoices.filter((invoice) => invoice.status === "open" || invoice.status === "partially_paid");
    const dueMinor = open.reduce((sum, invoice) => {
      const invoiceLines = lines
        .filter((line) => line.invoice_id === invoice.id)
        .map((line) => ({ charge_type: line.charge_type, amount_minor: Number(line.amount), description: line.description }));
      return sum + rentUtilityDueMinor(invoiceLines, Number(invoice.paid));
    }, 0);
    const sumType = (type: string) =>
      lines.filter((line) => line.charge_type === type).reduce((sum, line) => sum + Number(line.amount), 0);
    const electricityCredit = lines
      .filter((line) => line.charge_type === "credit" && line.description.startsWith("沖銷電費"))
      .reduce((sum, line) => sum + Number(line.amount), 0);
    return {
      lease,
      signatures,
      invoices,
      lines,
      dueMinor,
      rentMinor: sumType("rent"),
      utilityMinor: sumType("utility") + electricityCredit,
      depositMinor: sumType("deposit"),
    };
  }, true), requireOrgScope(session), effectiveReadOptions(session));
}

export async function signedLeasePdf(session: Session, leaseId: string) {
  session = await guardEffectiveSession(session, "props.view");
  await admitCustomRead(session, "props.view");
  return tx(session.userId, async (client) =>
    withEffectiveReadAuthority(client, session, "props.view", async () => maybe<{ file_name: string; content: Buffer }>(
      client,
      `SELECT f.file_name, pdf.content
         FROM lease_signed_pdfs pdf
         JOIN files f ON f.id = pdf.file_id
        WHERE pdf.lease_id = $1 AND pdf.org_id = $2
        ORDER BY pdf.created_at DESC
        LIMIT 1`,
      [leaseId, session.orgId],
    )), requireOrgScope(session), effectiveReadOptions(session),
  );
}

export async function listPayments(session: Session) {
  session = await guardEffectiveSession(session, "pay.record");
  await admitCustomRead(session, "pay.record");
  return tx(session.userId, async (client) =>
    withEffectiveReadAuthority(client, session, "pay.record", async () => many<{
      id: string;
      status: string;
      amount: string;
      currency: string;
      paid_on: string;
      last5: string | null;
      tenant: string;
      place: string;
    }>(
      client,
      `SELECT p.id::text, p.status::text, p.amount_minor::text AS amount, p.currency, p.paid_on::text,
              p.payer_account_last5 AS last5, c.display_name AS tenant,
              pr.name || coalesce(' ' || r.label, '') AS place
         FROM payments p
         JOIN leases l ON l.id = p.lease_id
         JOIN properties pr ON pr.id = l.property_id
         LEFT JOIN rooms r ON r.id = l.target_room_id
         LEFT JOIN contacts c ON c.id = p.payer_contact_id
        WHERE p.org_id = $1
        ORDER BY p.created_at DESC
        LIMIT 40`,
      [session.orgId],
    )), requireOrgScope(session), effectiveReadOptions(session),
  );
}

export async function listMatches(session: Session) {
  session = await guardEffectiveSession(session, "bank.reconcile");
  await admitCustomRead(session, "bank.reconcile");
  return tx(session.userId, async (client) =>
    withEffectiveReadAuthority(client, session, "bank.reconcile", async () => many<{
      id: string;
      score: string;
      amount: string;
      currency: string;
      posted_on: string;
      last5: string | null;
      tenant: string;
      payment_amount: string;
    }>(
      client,
      `SELECT s.id::text, s.score::text, b.amount_minor::text AS amount, b.currency, b.posted_on::text,
              b.counterparty_account_last5 AS last5, c.display_name AS tenant, p.amount_minor::text AS payment_amount
         FROM bank_match_suggestions s
         JOIN bank_transactions b ON b.id = s.bank_transaction_id
         JOIN payments p ON p.id = s.payment_id
         LEFT JOIN contacts c ON c.id = p.payer_contact_id
        WHERE s.org_id = $1 AND s.status = 'suggested'
        ORDER BY s.score DESC, s.created_at DESC`,
      [session.orgId],
    )), requireOrgScope(session), effectiveReadOptions(session),
  );
}

export async function latestUnmatchedPayment(session: Session) {
  session = await guardEffectiveSession(session, "bank.reconcile");
  await admitCustomRead(session, "bank.reconcile");
  return tx(session.userId, async (client) =>
    withEffectiveReadAuthority(client, session, "bank.reconcile", async () => maybe<{ paid_on: string; amount_minor: string; last5: string | null; currency: string }>(
      client,
      `SELECT paid_on::text, amount_minor::text, payer_account_last5 AS last5, currency
         FROM payments
        WHERE org_id = $1 AND bank_transaction_id IS NULL AND status IN ('submitted','confirmed')
        ORDER BY created_at DESC LIMIT 1`,
      [session.orgId],
    )), requireOrgScope(session), effectiveReadOptions(session),
  );
}

export async function listStatements(session: Session) {
  session = await guardEffectiveSession(session, "stmt.view");
  await admitCustomRead(session, "stmt.view");
  return tx(session.userId, async (client) =>
    withEffectiveReadAuthority(client, session, "stmt.view", async () => many<{
      id: string;
      owner_id: string;
      owner_name: string;
      period_start: string;
      currency: string;
      rent: string;
      other: string;
      fee: string;
      expenses: string;
      opening: string;
      payouts: string;
      closing: string;
      status: string;
    }>(
      client,
      `SELECT s.id::text, s.owner_contact_id::text AS owner_id, c.display_name AS owner_name,
              s.period_start::text, s.currency, s.rent_received_minor::text AS rent,
              s.other_income_minor::text AS other, s.management_fee_minor::text AS fee,
              s.expenses_minor::text AS expenses, s.opening_balance_minor::text AS opening,
              s.payouts_minor::text AS payouts, s.closing_balance_minor::text AS closing, s.status::text
         FROM owner_statements s
         JOIN contacts c ON c.id = s.owner_contact_id
        WHERE s.org_id = $1 AND s.status <> 'void'
        ORDER BY s.period_start DESC, c.display_name`,
      [session.orgId],
    )), requireOrgScope(session), effectiveReadOptions(session),
  );
}

export type RosterRow = {
  id: string | null;
  owner_id: string;
  owner_name: string;
  period_start: string;
  currency: string;
  properties: string;
  fee_rule: string | null;
  rent: string | null;
  other: string | null;
  fee: string | null;
  expenses: string | null;
  opening: string | null;
  payouts: string | null;
  closing: string | null;
  generated: boolean;
};

export async function statementRoster(session: Session, month: string): Promise<RosterRow[]> {
  session = await guardEffectiveSession(session, "stmt.view");
  await admitCustomRead(session, "stmt.view");
  return tx(session.userId, async (client) => withEffectiveReadAuthority(client, session, "stmt.view", async () => {
    const issued = await many<RosterRow>(
      client,
      `SELECT s.id::text, s.owner_contact_id::text AS owner_id, c.display_name AS owner_name,
              s.period_start::text, s.currency,
              coalesce((
                SELECT string_agg(DISTINCT p.name, '、' ORDER BY p.name)
                  FROM property_owners po JOIN properties p ON p.id = po.property_id
                 WHERE po.owner_contact_id = s.owner_contact_id
              ), '') AS properties,
              (
                SELECT fr.name FROM management_agreements ma
                  JOIN fee_rules fr ON fr.id = ma.fee_rule_id
                 WHERE ma.owner_contact_id = s.owner_contact_id
                 ORDER BY ma.property_id NULLS LAST
                 LIMIT 1
              ) AS fee_rule,
              s.rent_received_minor::text AS rent, s.other_income_minor::text AS other,
              s.management_fee_minor::text AS fee, s.expenses_minor::text AS expenses,
              s.opening_balance_minor::text AS opening, s.payouts_minor::text AS payouts,
              s.closing_balance_minor::text AS closing, true AS generated
         FROM owner_statements s
         JOIN contacts c ON c.id = s.owner_contact_id
        WHERE s.org_id = $1 AND s.status <> 'void'
        ORDER BY s.period_start DESC, c.display_name`,
      [session.orgId],
    );
    const pending = await many<RosterRow>(
      client,
      `SELECT NULL::text AS id, c.id::text AS owner_id, c.display_name AS owner_name,
              ($2::date)::text AS period_start,
              coalesce((
                SELECT p.currency FROM property_owners po JOIN properties p ON p.id = po.property_id
                 WHERE po.owner_contact_id = c.id LIMIT 1
              ), 'TWD') AS currency,
              coalesce((
                SELECT string_agg(DISTINCT p.name, '、' ORDER BY p.name)
                  FROM property_owners po JOIN properties p ON p.id = po.property_id
                 WHERE po.owner_contact_id = c.id
              ), '') AS properties,
              (
                SELECT fr.name FROM management_agreements ma
                  JOIN fee_rules fr ON fr.id = ma.fee_rule_id
                 WHERE ma.owner_contact_id = c.id
                 ORDER BY ma.property_id NULLS LAST
                 LIMIT 1
              ) AS fee_rule,
              NULL::text AS rent, NULL::text AS other, NULL::text AS fee, NULL::text AS expenses,
              NULL::text AS opening, NULL::text AS payouts, NULL::text AS closing, false AS generated
         FROM contacts c
        WHERE c.org_id = $1 AND c.is_owner AND c.archived_at IS NULL
          AND EXISTS (SELECT 1 FROM property_owners po WHERE po.owner_contact_id = c.id)
          AND NOT EXISTS (
            SELECT 1 FROM owner_statements s
             WHERE s.owner_contact_id = c.id AND s.period_start = $2::date AND s.status <> 'void'
          )
        ORDER BY c.display_name`,
      [session.orgId, `${month}-01`],
    );
    return [...issued, ...pending];
  }), requireOrgScope(session), effectiveReadOptions(session));
}

export async function rentRoll(session: Session) {
  session = await guardEffectiveSession(session, "stmt.view");
  await admitCustomRead(session, "stmt.view");
  return tx(session.userId, async (client) =>
    withEffectiveReadAuthority(client, session, "stmt.view", async () => many<{
      property_id: string;
      property_name: string;
      currency: string;
      owner_name: string;
      space_id: string;
      space_label: string;
      lease_id: string | null;
      tenant: string | null;
      rent: string | null;
      due: string;
      received: string;
      balance: string;
      due_date: string | null;
      reported: boolean;
    }>(
      client,
      `SELECT p.id::text AS property_id, p.name AS property_name, p.currency,
              coalesce(ow.display_name, '') AS owner_name,
              coalesce(r.id::text, u.id::text) AS space_id,
              CASE WHEN r.id IS NULL THEN u.label ELSE u.label || '-' || r.label END AS space_label,
              l.id::text AS lease_id, c.display_name AS tenant, l.rent_amount_minor::text AS rent,
              coalesce(inv.due, 0)::text AS due, coalesce(inv.received, 0)::text AS received,
              coalesce(inv.balance, 0)::text AS balance, inv.due_date::text AS due_date,
              coalesce(rep.reported, false) AS reported
         FROM properties p
         JOIN units u ON u.property_id = p.id
         LEFT JOIN rooms r ON r.unit_id = u.id AND r.archived_at IS NULL AND u.rental_mode = 'by_room'
         LEFT JOIN LATERAL (
           SELECT c.display_name
             FROM property_owners po JOIN contacts c ON c.id = po.owner_contact_id
            WHERE po.property_id = p.id AND po.is_primary
            LIMIT 1
         ) ow ON true
         LEFT JOIN leases l ON l.status IN ('pending_signature','active')
           AND ((r.id IS NOT NULL AND l.target_room_id = r.id) OR (r.id IS NULL AND l.target_unit_id = u.id))
         LEFT JOIN lease_parties lp ON lp.lease_id = l.id AND lp.role = 'primary'
         LEFT JOIN contacts c ON c.id = lp.contact_id
         LEFT JOIN LATERAL (
           SELECT coalesce(sum(i.total_minor), 0) AS due,
                  coalesce(sum(i.paid_minor), 0) AS received,
                  coalesce(sum(i.balance_minor) FILTER (WHERE i.status IN ('open','partially_paid')), 0) AS balance,
                  min(i.due_date) FILTER (WHERE i.status IN ('open','partially_paid') AND i.balance_minor > 0) AS due_date
             FROM invoices i
            WHERE l.id IS NOT NULL AND i.lease_id = l.id AND i.status <> 'void'
              AND i.period_start >= date_trunc('month', current_date)::date
              AND i.period_start < (date_trunc('month', current_date) + interval '1 month')::date
         ) inv ON true
         LEFT JOIN LATERAL (
           SELECT true AS reported FROM payments pay
            WHERE l.id IS NOT NULL AND pay.lease_id = l.id AND pay.status = 'submitted'
            LIMIT 1
         ) rep ON true
        WHERE p.org_id = $1 AND p.archived_at IS NULL
          AND (u.rental_mode = 'whole_unit' OR r.id IS NOT NULL OR NOT EXISTS (
            SELECT 1 FROM rooms rx WHERE rx.unit_id = u.id AND rx.archived_at IS NULL AND u.rental_mode = 'by_room'
          ))
        ORDER BY p.name, space_label`,
      [session.orgId],
    )), requireOrgScope(session), effectiveReadOptions(session),
  );
}

export async function statementDetail(session: Session, id: string) {
  session = await guardEffectiveSession(session, "stmt.view");
  await admitCustomRead(session, "stmt.view");
  return tx(session.userId, async (client) => withEffectiveReadAuthority(client, session, "stmt.view", async () => {
    const statement = await maybe<{
      id: string;
      owner_name: string;
      period_start: string;
      period_end: string;
      currency: string;
      opening: string;
      rent: string;
      other: string;
      fee: string;
      expenses: string;
      payouts: string;
      closing: string;
      status: string;
    }>(
      client,
      `SELECT s.id::text, c.display_name AS owner_name, s.period_start::text, s.period_end::text, s.currency,
              s.opening_balance_minor::text AS opening, s.rent_received_minor::text AS rent,
              s.other_income_minor::text AS other, s.management_fee_minor::text AS fee,
              s.expenses_minor::text AS expenses, s.payouts_minor::text AS payouts,
              s.closing_balance_minor::text AS closing, s.status::text
         FROM owner_statements s
         JOIN contacts c ON c.id = s.owner_contact_id
        WHERE s.id = $1`,
      [id],
    );
    if (!statement) return null;
    const lines = await many<{ line_type: string; description: string | null; amount: string }>(
      client,
      `SELECT line_type::text, description, amount_minor::text AS amount
         FROM owner_statement_lines WHERE statement_id = $1 ORDER BY line_type, description`,
      [id],
    );
    return { statement, lines };
  }), requireOrgScope(session), effectiveReadOptions(session));
}

export async function listTicketProperties(session: Session) {
  session = await guardEffectiveSession(session, "tickets.update");
  await admitCustomRead(session, "tickets.update");
  return tx(session.userId, async (client) =>
    withEffectiveReadAuthority(client, session, "tickets.update", async () => many<{ id: string; name: string }>(
      client,
      `SELECT id::text, name FROM properties WHERE org_id = $1 AND archived_at IS NULL ORDER BY name`,
      [session.orgId],
    )), requireOrgScope(session), effectiveReadOptions(session),
  );
}

export async function listTicketFilters(session: Session) {
  session = await guardEffectiveSession(session, "tickets.update");
  await admitCustomRead(session, "tickets.update");
  return tx(session.userId, async (client) => withEffectiveReadAuthority(client, session, "tickets.update", async () => {
    const units = await many<{ id: string; property_id: string; label: string }>(
      client,
      `SELECT u.id::text, u.property_id::text, u.label
         FROM units u
        WHERE u.org_id = $1 AND u.archived_at IS NULL
        ORDER BY u.label`,
      [session.orgId],
    );
    const rooms = await many<{ id: string; unit_id: string; property_id: string; label: string; unit_label: string }>(
      client,
      `SELECT r.id::text, r.unit_id::text, u.property_id::text, r.label, u.label AS unit_label
         FROM rooms r
         JOIN units u ON u.id = r.unit_id
        WHERE r.org_id = $1 AND r.archived_at IS NULL AND u.archived_at IS NULL AND u.rental_mode = 'by_room'
        ORDER BY u.label, r.label`,
      [session.orgId],
    );
    return { units, rooms };
  }), requireOrgScope(session), effectiveReadOptions(session));
}

export async function listTickets(
  session: Session,
  filters: { propertyId?: string | null; unitId?: string | null; roomId?: string | null } = {},
) {
  session = await guardEffectiveSession(session, "tickets.update");
  await admitCustomRead(session, "tickets.update");
  return tx(session.userId, async (client) =>
    withEffectiveReadAuthority(client, session, "tickets.update", async () => many<{
      id: string;
      number: string;
      title: string;
      status: string;
      category: string;
      priority: string;
      place: string;
      property_id: string;
      vendor_name: string | null;
      scheduled_on: string | null;
      completed_on: string | null;
      final_cost: string | null;
      currency: string | null;
    }>(
      client,
      `SELECT t.id::text, t.ticket_number::text AS number, t.title, t.status::text, t.category::text, t.priority::text,
              p.name || coalesce(' ' || r.label, '') AS place, t.property_id::text,
              t.vendor_name, t.scheduled_on::text, t.completed_on::text,
              t.final_cost_minor::text AS final_cost, t.currency
         FROM maintenance_tickets t
         JOIN properties p ON p.id = t.property_id
         LEFT JOIN rooms r ON r.id = t.room_id
        WHERE t.org_id = $1
          AND ($2::uuid IS NULL OR t.property_id = $2)
          AND ($3::uuid IS NULL OR t.unit_id = $3)
          AND ($4::uuid IS NULL OR t.room_id = $4)
        ORDER BY t.created_at DESC`,
      [session.orgId, filters.propertyId || null, filters.unitId || null, filters.roomId || null],
    )), requireOrgScope(session), effectiveReadOptions(session),
  );
}

/** Recent repairs for one room, or for a whole unit that has no rooms. */
export async function spaceRepairs(session: Session, target: { roomId: string } | { unitId: string }) {
  session = await guardEffectiveSession(session, "tickets.update");
  await admitCustomRead(session, "tickets.update");
  const roomId = "roomId" in target ? target.roomId : null;
  const unitId = "unitId" in target ? target.unitId : null;
  return tx(session.userId, async (client) =>
    withEffectiveReadAuthority(client, session, "tickets.update", async () => many<{
      id: string;
      number: string;
      title: string;
      vendor_name: string | null;
      final_cost: string | null;
      currency: string;
    }>(
      client,
      `SELECT t.id::text, t.ticket_number::text AS number, t.title, t.vendor_name,
              t.final_cost_minor::text AS final_cost, coalesce(t.currency, p.currency) AS currency
         FROM maintenance_tickets t
         JOIN properties p ON p.id = t.property_id
        WHERE t.org_id = $1
          AND ($2::uuid IS NULL OR t.room_id = $2)
          AND ($3::uuid IS NULL OR (t.unit_id = $3 AND t.room_id IS NULL))
        ORDER BY t.created_at DESC
        LIMIT 8`,
      [session.orgId, roomId, unitId],
    )), requireOrgScope(session), effectiveReadOptions(session),
  );
}

export async function tenantRepairs(session: Session, leaseId: string) {
  session = await guardEffectiveSession(session, null);
  return tx(session.userId, async (client) =>
    withEffectiveReadAuthority(client, session, null, async () => many<{ id: string; number: string; title: string; status: string; category: string; created_at: string }>(
      client,
      `SELECT t.id::text, t.ticket_number::text AS number, t.title, t.status::text, t.category::text,
              t.created_at::text
         FROM maintenance_tickets t
        WHERE t.lease_id = $1 AND t.org_id = $2
        ORDER BY t.created_at DESC`,
      [leaseId, session.orgId],
    )), requireOrgScope(session), effectiveReadOptions(session),
  );
}

export async function ticketDetail(session: Session, ticketId: string) {
  session = await guardEffectiveSession(session, "tickets.update");
  await admitCustomRead(session, "tickets.update");
  return tx(session.userId, async (client) => withEffectiveReadAuthority(client, session, "tickets.update", async () => {
    const ticket = await maybe<{
      id: string;
      number: string;
      title: string;
      description: string | null;
      status: string;
      category: string;
      place: string;
      property_id: string;
      property_name: string;
      currency: string | null;
      property_currency: string;
      vendor_name: string | null;
      estimated_cost: string | null;
      final_cost: string | null;
      cost_bearer: string;
      scheduled_on: string | null;
      completed_on: string | null;
      expense_id: string | null;
      expense_status: string | null;
    }>(
      client,
      `SELECT t.id::text, t.ticket_number::text AS number, t.title, t.description, t.status::text, t.category::text,
              p.name || coalesce(' ' || r.label, '') AS place, t.property_id::text, p.name AS property_name,
              t.currency, p.currency AS property_currency, t.vendor_name,
              t.estimated_cost_minor::text AS estimated_cost, t.final_cost_minor::text AS final_cost,
              t.cost_bearer::text, t.scheduled_on::text, t.completed_on::text, t.expense_id::text,
              e.status::text AS expense_status
         FROM maintenance_tickets t
         JOIN properties p ON p.id = t.property_id
         LEFT JOIN rooms r ON r.id = t.room_id
         LEFT JOIN expenses e ON e.id = t.expense_id AND e.org_id = t.org_id
        WHERE t.id = $1 AND t.org_id = $2`,
      [ticketId, session.orgId],
    );
    if (!ticket) return null;
    const comments = await many<{
      id: string;
      body: string | null;
      internal: boolean;
      status_from: string | null;
      status_to: string | null;
      at: string;
      author: string;
    }>(
      client,
      `SELECT c.id::text, c.body, c.is_internal AS internal, c.status_from::text, c.status_to::text,
              c.created_at::text AS at, coalesce(p.display_name, '') AS author
         FROM ticket_comments c
         LEFT JOIN profiles p ON p.id = c.author_user_id
        WHERE c.ticket_id = $1
        ORDER BY c.created_at, c.id`,
      [ticket.id],
    );
    const photos = session.customRole && session.kind === "staff" && !canTicketPhotos(session) ? [] : await many<{ id: string; name: string; path: string; mime: string | null; internal: boolean }>(
      client,
      `SELECT a.id::text, f.file_name AS name, f.storage_path AS path, f.mime_type AS mime, a.is_internal AS internal
         FROM ticket_attachments a
         JOIN files f ON f.id = a.file_id
        WHERE a.ticket_id = $1
        ORDER BY a.created_at`,
      [ticket.id],
    );
    return { ticket, comments, photos };
  }), requireOrgScope(session), effectiveReadOptions(session));
}

export async function listThreads(session: Session) {
  session = await guardEffectiveSession(session, "messages.send");
  await admitCustomRead(session, "messages.send");
  return tx(session.userId, async (client) =>
    withEffectiveReadAuthority(client, session, "messages.send", async () => many<{ id: string; place: string; tenant: string; preview: string | null }>(
      client,
      `SELECT t.id::text,
              p.name || coalesce(' ' || r.label, '') AS place,
              c.display_name AS tenant,
              (SELECT m.body FROM messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS preview
         FROM message_threads t
         JOIN leases l ON l.id = t.lease_id
         JOIN properties p ON p.id = l.property_id
         LEFT JOIN rooms r ON r.id = l.target_room_id
         JOIN lease_parties lp ON lp.lease_id = l.id AND lp.role = 'primary'
         JOIN contacts c ON c.id = lp.contact_id
        WHERE t.org_id = $1
        ORDER BY t.last_message_at DESC NULLS LAST`,
      [session.orgId],
    )), requireOrgScope(session), effectiveReadOptions(session),
  );
}

export async function threadMessages(session: Session, threadId: string) {
  session = await guardEffectiveSession(session, "messages.send");
  await admitCustomRead(session, "messages.send");
  return tx(session.userId, async (client) =>
    withEffectiveReadAuthority(client, session, "messages.send", async () => many<{ id: string; body: string; at: string; mine: boolean }>(
      client,
      `SELECT id::text, body, created_at::text AS at, (sender_user_id = $2) AS mine
         FROM messages WHERE thread_id = $1 ORDER BY created_at`,
      [threadId, session.userId],
    )), requireOrgScope(session), effectiveReadOptions(session),
  );
}

export async function listTeam(session: Session) {
  session = await guardEffectiveSession(session, "team.manage");
  await admitCustomRead(session, "team.manage");
  const rows = await tx(session.userId, async (client) =>
    withEffectiveReadAuthority(client, session, "team.manage", async () => many<{
      member_id: string | null;
      invitation_id: string | null;
      name: string;
      email: string | null;
      role: string;
      status: string;
      expires_at: string | null;
      user_id: string | null;
    }>(
      client,
      `SELECT m.id::text AS member_id, NULL::text AS invitation_id, p.display_name AS name, p.email::text AS email,
              m.role::text, m.status::text, NULL::text AS expires_at, m.user_id::text
         FROM org_members m
         JOIN profiles p ON p.id = m.user_id
        WHERE m.org_id = $1 AND m.status <> 'removed'
        UNION ALL
        SELECT NULL::text, i.id::text, coalesce(i.email::text, ''), i.email::text, i.role::text, i.status::text,
               i.expires_at::text, NULL::text
          FROM invitations i
         WHERE i.org_id = $1 AND i.kind = 'team_member' AND i.status IN ('pending', 'revoked')
         ORDER BY 3`,
      [session.orgId],
    )), requireOrgScope(session), effectiveReadOptions(session),
  );
  const ids = rows.map((row) => row.user_id).filter((id): id is string => Boolean(id));
  const extra = new Map<string, { mfa: boolean; last_sign_in: string | null }>();
  if (ids.length) {
    const facts = await query<{ user_id: string; mfa: boolean; last_sign_in: string | null }>(
      `SELECT u.id::text AS user_id, coalesce(f.enabled, false) AS mfa,
              (SELECT max(s.last_active_at)::text FROM auth_sessions s WHERE s.user_id = u.id) AS last_sign_in
         FROM auth.users u
         LEFT JOIN user_mfa f ON f.user_id = u.id
        WHERE u.id = ANY($1::uuid[])`,
      [ids],
    );
    for (const fact of facts.rows) extra.set(fact.user_id, { mfa: fact.mfa, last_sign_in: fact.last_sign_in });
  }
  return rows.map((row) => ({
    ...row,
    mfa: row.user_id ? (extra.get(row.user_id)?.mfa ?? false) : false,
    last_sign_in: row.user_id ? (extra.get(row.user_id)?.last_sign_in ?? null) : null,
  }));
}

export async function tenantLeases(session: Session) {
  session = await guardEffectiveSession(session, null);
  return tx(session.userId, async (client) =>
    withEffectiveReadAuthority(client, session, null, async () => many<{
      lease_id: string;
      org_id: string;
      firm_name: string;
      property_name: string;
      address_display: string | null;
      unit_label: string;
      room_label: string | null;
      lease_status: string;
      start_date: string;
      end_date: string;
      thread_id: string | null;
    }>(
      client,
      `SELECT lease_id::text, org_id::text, firm_name, property_name, address_display, unit_label, room_label,
              lease_status::text, start_date::text, end_date::text, thread_id::text
         FROM tenant_lease_picker`,
    )), requireOrgScope(session), effectiveReadOptions(session),
  );
}

export async function tenantLeaseMoney(session: Session, leaseId: string) {
  session = await guardEffectiveSession(session, null);
  return tx(session.userId, async (client) => withEffectiveReadAuthority(client, session, null, async () => {
    const lease = await maybe<{
      id: string;
      currency: string;
      rent: string;
      deposit: string;
      due_day: number;
      start_date: string;
      end_date: string;
      status: string;
      place: string;
      firm: string;
      first_period_basis: unknown;
    }>(
      client,
      `SELECT l.id::text, l.currency, l.rent_amount_minor::text AS rent, l.deposit_amount_minor::text AS deposit,
              l.due_day, l.start_date::text, l.end_date::text, l.status::text, l.first_period_basis,
              p.name || ' ' || u.label || coalesce(' ' || r.label, '') AS place, o.name AS firm
         FROM leases l
         JOIN properties p ON p.id = l.property_id
         JOIN units u ON u.id = l.unit_id
         LEFT JOIN rooms r ON r.id = l.target_room_id
         JOIN organizations o ON o.id = l.org_id
         JOIN lease_parties lp ON lp.lease_id = l.id
         JOIN contacts c ON c.id = lp.contact_id AND c.user_id = $2
        WHERE l.id = $1`,
      [leaseId, session.userId],
    );
    if (!lease) return null;
    const invoices = await many<{ id: string; paid: string; balance: string; status: string; currency: string }>(
      client,
      `SELECT id::text, paid_minor::text AS paid, balance_minor::text AS balance, status::text, currency
         FROM invoices WHERE lease_id = $1 AND status IN ('open','partially_paid')`,
      [leaseId],
    );
    const lines = invoices.length
      ? await many<{ invoice_id: string; charge_type: string; amount: string; description: string; period_start: string | null }>(
          client,
          `SELECT il.invoice_id::text, il.charge_type::text, il.amount_minor::text AS amount, il.description,
                  i.period_start::text AS period_start
             FROM invoice_lines il
             JOIN invoices i ON i.id = il.invoice_id
            WHERE il.invoice_id = ANY($1::uuid[])`,
          [invoices.map((invoice) => invoice.id)],
        )
      : [];
    const billLines = invoices.flatMap((invoice) => {
      const invoiceLines = lines
        .filter((line) => line.invoice_id === invoice.id)
        .map((line) => ({
          charge_type: line.charge_type,
          amount_minor: Number(line.amount),
          description: line.description,
          period_start: line.period_start,
        }));
      return tenantBillLines(invoiceLines, Number(invoice.paid));
    });
    const dueMinor = billLines.reduce((sum, line) => sum + line.amountMinor, 0);
    const balance = invoices.reduce((sum, invoice) => sum + Number(invoice.balance), 0);
    const paidMinor = invoices.reduce((sum, invoice) => sum + Number(invoice.paid), 0);
    // Rent and electricity are billed only after both parties sign. A pending_signature lease
    // is left out of the electricity split, so it has neither a rent row nor a new utility row.
    // Deposit and any other open charge stay on the bill so the rows match the invoice balance.
    const asRow = (line: { chargeType: string; description: string; amountMinor: number; periodStart?: string | null }) => ({
      chargeType: line.chargeType,
      description: line.description,
      amount: String(line.amountMinor),
      periodStart: line.periodStart ?? null,
    });
    const rentLines = billLines.filter((line) => line.chargeType === "rent").map(asRow);
    const depositLines = billLines.filter((line) => line.chargeType === "deposit").map(asRow);
    const utilityLines = billLines.filter((line) => line.chargeType === "utility").map(asRow);
    const otherLines = billLines
      .filter((line) => line.chargeType !== "rent" && line.chargeType !== "deposit" && line.chargeType !== "utility")
      .map(asRow);
    return { lease, dueMinor, balance, paidMinor, currency: lease.currency, rentLines, depositLines, utilityLines, otherLines };
  }), requireOrgScope(session), effectiveReadOptions(session));
}

export async function ownerPropertyNames(session: Session) {
  session = await guardEffectiveSession(session, null);
  return tx(session.userId, async (client) =>
    withEffectiveReadAuthority(client, session, null, async () => many<{ id: string; name: string }>(
      client,
      `SELECT id::text, name
         FROM properties
        WHERE archived_at IS NULL
        ORDER BY name`,
    )), requireOrgScope(session), effectiveReadOptions(session),
  );
}

export async function ownerHome(session: Session) {
  session = await guardEffectiveSession(session, null);
  return tx(session.userId, async (client) =>
    withEffectiveReadAuthority(client, session, null, async () => many<{
      lease_id: string;
      property_name: string;
      unit_label: string;
      room_label: string | null;
      tenant_name: string;
      tenant_phone: string | null;
      phone_visible: boolean;
      currency: string;
      rent: string;
      open_balance: string;
      status: string;
    }>(
      client,
      `SELECT lease_id::text, property_name, unit_label, room_label, tenant_name, tenant_phone,
              phone_visible, currency, rent_amount_minor::text AS rent, open_balance_minor::text AS open_balance,
              lease_status::text AS status
         FROM owner_lease_tenants
        ORDER BY property_name, unit_label, room_label`,
    )), requireOrgScope(session), effectiveReadOptions(session),
  );
}

export type OwnerRow = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  properties: string;
};

export async function listOwnerDirectory(session: Session) {
  session = await guardEffectiveSession(session, "props.view");
  await admitCustomRead(session, "props.view");
  return tx(session.userId, async (client) =>
    withEffectiveReadAuthority(client, session, "props.view", async () => many<OwnerRow>(
      client,
      `SELECT c.id::text, c.display_name AS name, c.email::text AS email, c.phone_e164 AS phone,
              coalesce((
                SELECT string_agg(p.name, '、' ORDER BY p.name)
                  FROM property_owners po
                  JOIN properties p ON p.id = po.property_id AND p.archived_at IS NULL
                 WHERE po.owner_contact_id = c.id
              ), '') AS properties
         FROM contacts c
        WHERE c.org_id = $1 AND c.is_owner AND c.archived_at IS NULL
        ORDER BY c.display_name`,
      [session.orgId],
    ), true), requireOrgScope(session), effectiveReadOptions(session),
  );
}

export async function ownerEditor(session: Session, id: string) {
  session = await guardEffectiveSession(session, "props.edit");
  await admitCustomRead(session, "props.edit");
  return tx(session.userId, async (client) => withEffectiveReadAuthority(client, session, "props.edit", async () => {
    const owner = await maybe<{ id: string; name: string; email: string | null; phone: string | null; user_id: string | null }>(
      client,
      `SELECT id::text, display_name AS name, email::text, phone_e164 AS phone, user_id::text AS user_id
         FROM contacts
        WHERE id = $1 AND org_id = $2 AND is_owner AND archived_at IS NULL`,
      [id, session.orgId],
    );
    if (!owner) return null;
    const linked = await many<{ property_id: string }>(
      client,
      `SELECT property_id::text FROM property_owners WHERE owner_contact_id = $1`,
      [id],
    );
    const pending = await maybe<{ id: string }>(
      client,
      `SELECT id::text FROM invitations
        WHERE org_id = $2 AND contact_id = $1 AND status = 'pending'
          AND kind IN ('owner', 'tenant') AND expires_at > now()
        LIMIT 1`,
      [id, session.orgId],
    );
    return { ...owner, propertyIds: linked.map((row) => row.property_id), invitePending: Boolean(pending) };
  }, true), requireOrgScope(session), effectiveReadOptions(session));
}

export async function propertyEditor(session: Session, id: string) {
  session = await guardEffectiveSession(session, "props.edit");
  await admitCustomRead(session, "props.edit");
  return tx(session.userId, async (client) => withEffectiveReadAuthority(client, session, "props.edit", async () => {
    const property = await maybe<{
      id: string;
      name: string;
      address: { city?: string; district?: string; street?: string; line?: string };
      country_code: string;
      owner_contact_id: string | null;
      meter_serial: string | null;
      split_method: string | null;
      rate_minor: string | null;
      bill_minor: string | null;
      usage: string | null;
    }>(
      client,
      `SELECT p.id::text, p.name, p.address, p.country_code,
              (SELECT po.owner_contact_id::text FROM property_owners po
                WHERE po.property_id = p.id AND po.is_primary LIMIT 1) AS owner_contact_id,
              m.serial_number AS meter_serial,
              m.split_method::text,
              m.rate_minor_per_unit::text AS rate_minor,
              b.total_amount_minor::text AS bill_minor,
              b.total_usage::text AS usage
         FROM properties p
         LEFT JOIN LATERAL (
           SELECT id, serial_number, split_method, rate_minor_per_unit
             FROM meters
            WHERE property_id = p.id AND utility = 'electricity' AND room_id IS NULL AND archived_at IS NULL
            ORDER BY created_at
            LIMIT 1
         ) m ON true
         LEFT JOIN LATERAL (
           SELECT total_amount_minor, total_usage
             FROM utility_bills
            WHERE meter_id = m.id
            ORDER BY period_end DESC
            LIMIT 1
         ) b ON true
        WHERE p.id = $1 AND p.org_id = $2 AND p.archived_at IS NULL`,
      [id, session.orgId],
    );
    return property;
  }, true), requireOrgScope(session), effectiveReadOptions(session));
}

export type SpaceRow = {
  kind: "room" | "whole_unit";
  id: string;
  property_id: string;
  property_name: string;
  currency: string;
  floor: string;
  room_label: string | null;
  room_type: string | null;
  area_value: string | null;
  area_unit: string | null;
  base_rent_minor: string | null;
  electricity_method: string | null;
  owner_name: string | null;
};

const SPACE_LIST_SQL = `SELECT kind, id, property_id, property_name, currency, floor, room_label, room_type,
              area_value, area_unit, base_rent_minor, electricity_method, owner_name
         FROM (
         SELECT 'room'::text AS kind, r.id::text, p.id::text AS property_id, p.name AS property_name, p.currency,
                u.label AS floor, r.label AS room_label, r.room_type::text, r.area_value::text, r.area_unit,
                r.base_rent_minor::text, r.electricity_method,
                (SELECT string_agg(c.display_name, '、' ORDER BY po.is_primary DESC, c.display_name)
                   FROM property_owners po JOIN contacts c ON c.id = po.owner_contact_id
                  WHERE po.property_id = p.id) AS owner_name,
                coalesce(p.address_display, '') AS address_display,
                coalesce(p.address::text, '') AS address_text,
                (SELECT string_agg(c.phone_e164, ' ' ORDER BY po.is_primary DESC, c.display_name)
                   FROM property_owners po JOIN contacts c ON c.id = po.owner_contact_id
                  WHERE po.property_id = p.id) AS owner_phone,
                (SELECT string_agg(c.email::text, ' ' ORDER BY po.is_primary DESC, c.display_name)
                   FROM property_owners po JOIN contacts c ON c.id = po.owner_contact_id
                  WHERE po.property_id = p.id) AS owner_email,
                p.org_id,
                p.created_at, u.label AS sort_floor, r.label AS sort_room
           FROM rooms r
           JOIN units u ON u.id = r.unit_id
           JOIN properties p ON p.id = u.property_id
          WHERE r.org_id = $1 AND r.archived_at IS NULL AND u.archived_at IS NULL AND p.archived_at IS NULL AND u.rental_mode = 'by_room'
         UNION ALL
         SELECT 'whole_unit'::text, u.id::text, p.id::text, p.name, p.currency,
                u.label, NULL::text, NULL::text, u.area_value::text, u.area_unit,
                u.base_rent_minor::text, u.electricity_method,
                (SELECT string_agg(c.display_name, '、' ORDER BY po.is_primary DESC, c.display_name)
                   FROM property_owners po JOIN contacts c ON c.id = po.owner_contact_id
                  WHERE po.property_id = p.id),
                coalesce(p.address_display, ''),
                coalesce(p.address::text, ''),
                (SELECT string_agg(c.phone_e164, ' ' ORDER BY po.is_primary DESC, c.display_name)
                   FROM property_owners po JOIN contacts c ON c.id = po.owner_contact_id
                  WHERE po.property_id = p.id),
                (SELECT string_agg(c.email::text, ' ' ORDER BY po.is_primary DESC, c.display_name)
                   FROM property_owners po JOIN contacts c ON c.id = po.owner_contact_id
                  WHERE po.property_id = p.id),
                p.org_id,
                p.created_at, u.label, ''
           FROM units u
           JOIN properties p ON p.id = u.property_id
          WHERE u.org_id = $1 AND u.archived_at IS NULL AND u.rental_mode = 'whole_unit' AND p.archived_at IS NULL
       ) spaces
       WHERE TRUE
         ${spaceSearchSql()}
       ORDER BY created_at, sort_floor, sort_room, id`;

const SPACE_LIST_ORDER = "ORDER BY created_at, sort_floor, sort_room, id";

async function querySpaces(session: Session, opts?: ListOpts) {
  const bound = bindList(session.orgId, opts);
  return tx(
    session.userId,
    (client) => loadContactList<SpaceRow>(client, session, SPACE_LIST_SQL, SPACE_LIST_ORDER, bound),
    listScope(session), effectiveReadOptions(session),
  );
}

export async function listSpaces(session: Session) {
  session = await guardEffectiveSession(session, "props.view");
  await admitCustomRead(session, "props.view");
  return (await querySpaces(session)).rows;
}

export async function searchSpaces(session: Session, raw?: { q?: string; page?: string | number; limit?: number }) {
  session = await guardEffectiveSession(session, "props.view");
  await admitCustomRead(session, "props.view");
  const parsed = parseListQuery(raw);
  const result = await querySpaces(session, { q: parsed.q, page: parsed.page, limit: raw?.limit ?? LIST_PAGE_SIZE });
  return { ...result, q: parsed.q, page: parsed.page };
}

export type SpaceEditor = {
  kind: "room" | "whole_unit";
  id: string;
  propertyId: string;
  ownerContactId: string | null;
  floor: string;
  roomLabel: string;
  roomType: string;
  area: string;
  rentMinor: string | null;
  electricityMethod: string;
  ratePerKwh: string;
  rateCapReason: string;
  taipowerKwh: string;
  taipowerAmountMinor: string | null;
  notes: string;
  currency: string;
};

export async function spaceEditor(session: Session, kind: "room" | "whole_unit", id: string) {
  session = await guardEffectiveSession(session, "props.edit");
  await admitCustomRead(session, "props.edit");
  return tx(session.userId, async (client) => withEffectiveReadAuthority(client, session, "props.edit", async () => {
    if (kind === "whole_unit") {
      return maybe<SpaceEditor>(
        client,
        `SELECT 'whole_unit'::text AS kind, u.id::text, u.property_id::text AS "propertyId",
                (SELECT po.owner_contact_id::text FROM property_owners po
                  WHERE po.property_id = u.property_id AND po.is_primary LIMIT 1) AS "ownerContactId",
                u.label AS floor, '' AS "roomLabel", '' AS "roomType",
                coalesce(u.area_value::text, '') AS area, u.base_rent_minor::text AS "rentMinor",
                coalesce(u.electricity_method, '') AS "electricityMethod",
                coalesce(u.rate_per_kwh::text, '') AS "ratePerKwh",
                coalesce(u.rate_cap_reason, '') AS "rateCapReason",
                coalesce(u.taipower_kwh::text, '') AS "taipowerKwh",
                u.taipower_amount_minor::text AS "taipowerAmountMinor",
                coalesce(u.notes, '') AS notes, p.currency
           FROM units u
           JOIN properties p ON p.id = u.property_id
          WHERE u.id = $1 AND u.org_id = $2 AND u.rental_mode = 'whole_unit' AND u.archived_at IS NULL AND p.archived_at IS NULL`,
        [id, session.orgId],
      );
    }
    return maybe<SpaceEditor>(
      client,
      `SELECT 'room'::text AS kind, r.id::text, u.property_id::text AS "propertyId",
              (SELECT po.owner_contact_id::text FROM property_owners po
                WHERE po.property_id = u.property_id AND po.is_primary LIMIT 1) AS "ownerContactId",
              u.label AS floor, r.label AS "roomLabel", r.room_type::text AS "roomType",
              coalesce(r.area_value::text, '') AS area, r.base_rent_minor::text AS "rentMinor",
              coalesce(r.electricity_method, '') AS "electricityMethod",
              coalesce(r.rate_per_kwh::text, '') AS "ratePerKwh",
              coalesce(r.rate_cap_reason, '') AS "rateCapReason",
              coalesce(r.taipower_kwh::text, '') AS "taipowerKwh",
              r.taipower_amount_minor::text AS "taipowerAmountMinor",
              coalesce(r.notes, '') AS notes, p.currency
         FROM rooms r
         JOIN units u ON u.id = r.unit_id
         JOIN properties p ON p.id = u.property_id
        WHERE r.id = $1 AND r.org_id = $2 AND r.archived_at IS NULL AND u.archived_at IS NULL AND p.archived_at IS NULL AND u.rental_mode = 'by_room'`,
      [id, session.orgId],
    );
  }, true), requireOrgScope(session), effectiveReadOptions(session));
}

export async function leasePdfSource(session: Session, id: string) {
  session = await guardEffectiveSession(session, "props.view");
  await admitCustomRead(session, "props.view");
  return tx(session.userId, async (client) =>
    withEffectiveReadAuthority(client, session, "props.view", async () => maybe<{
      id: string;
      orgId: string;
      documentSha256: string | null;
      currency: string;
      rentMinor: string;
      depositMinor: string;
      depositMonths: string | null;
      depositOverrideReason: string | null;
      dueDay: number;
      rentFrequency: string;
      startDate: string;
      endDate: string | null;
      place: string;
      addressDisplay: string;
      address: unknown;
      floor: string | null;
      roomLabel: string | null;
      partial: boolean;
      electricityMethod: string | null;
      ratePerKwh: string | null;
      bankName: string | null;
      tenant: string;
      ownerName: string | null;
    }>(
      client,
      `SELECT l.id::text AS id,
              l.org_id::text AS "orgId",
              nullif(btrim(l.document_sha256), '') AS "documentSha256",
              l.currency,
              l.rent_amount_minor::text AS "rentMinor",
              l.deposit_amount_minor::text AS "depositMinor",
              l.deposit_months::text AS "depositMonths",
              nullif(btrim(l.deposit_override_reason), '') AS "depositOverrideReason",
              l.due_day AS "dueDay",
              l.rent_frequency::text AS "rentFrequency",
              l.start_date::text AS "startDate",
              l.end_date::text AS "endDate",
              p.name || ' ' || u.label || coalesce(' ' || r.label, '') AS place,
              coalesce(p.address_display, '') AS "addressDisplay",
              p.address AS address,
              nullif(btrim(u.floor), '') AS floor,
              nullif(btrim(r.label), '') AS "roomLabel",
              (l.target_room_id IS NOT NULL) AS partial,
              CASE WHEN l.target_room_id IS NOT NULL THEN r.electricity_method ELSE u.electricity_method END AS "electricityMethod",
              CASE WHEN l.target_room_id IS NOT NULL THEN r.rate_per_kwh::text ELSE u.rate_per_kwh::text END AS "ratePerKwh",
              (
                SELECT b.bank_name
                  FROM bank_accounts b
                 WHERE b.org_id = l.org_id
                   AND b.archived_at IS NULL
                   AND b.show_to_tenants
                   AND b.currency = l.currency
                   AND (b.property_id = l.property_id OR b.property_id IS NULL)
                 ORDER BY (b.property_id = l.property_id) DESC, b.created_at
                 LIMIT 1
              ) AS "bankName",
              coalesce((
                SELECT string_agg(c.display_name, '、' ORDER BY lp.role, c.display_name)
                  FROM lease_parties lp
                  JOIN contacts c ON c.id = lp.contact_id
                 WHERE lp.lease_id = l.id
                   AND lp.role IN ('primary', 'co_tenant')
              ), '') AS tenant,
              (
                SELECT oc.display_name
                  FROM property_owners po
                  JOIN contacts oc ON oc.id = po.owner_contact_id
                 WHERE po.property_id = l.property_id AND po.is_primary
                 LIMIT 1
              ) AS "ownerName"
         FROM leases l
         JOIN properties p ON p.id = l.property_id
         JOIN units u ON u.id = l.unit_id
         LEFT JOIN rooms r ON r.id = l.target_room_id
        WHERE l.id = $1`,
      [id],
    ), true), requireOrgScope(session), effectiveReadOptions(session),
  );
}

export async function statementPdfSource(session: Session, id: string) {
  session = await guardEffectiveSession(session, "stmt.view");
  await admitCustomRead(session, "stmt.view");
  return tx(session.userId, async (client) => withEffectiveReadAuthority(client, session, "stmt.view", async () => {
    const statement = await maybe<{
      id: string;
      orgId: string;
      ownerName: string;
      periodStart: string;
      periodEnd: string;
      currency: string;
      opening: string;
      rent: string;
      other: string;
      fee: string;
      expenses: string;
      payouts: string;
      closing: string;
    }>(
      client,
      `SELECT s.id::text AS id, s.org_id::text AS "orgId", c.display_name AS "ownerName",
              s.period_start::text AS "periodStart", s.period_end::text AS "periodEnd", s.currency,
              s.opening_balance_minor::text AS opening, s.rent_received_minor::text AS rent,
              s.other_income_minor::text AS other, s.management_fee_minor::text AS fee,
              s.expenses_minor::text AS expenses, s.payouts_minor::text AS payouts,
              s.closing_balance_minor::text AS closing
         FROM owner_statements s
         JOIN contacts c ON c.id = s.owner_contact_id
        WHERE s.id = $1`,
      [id],
    );
    if (!statement) return null;
    const lines = await many<{ lineType: string; description: string | null; amount: string }>(
      client,
      `SELECT line_type AS "lineType", description, amount_minor::text AS amount
         FROM owner_statement_lines
        WHERE statement_id = $1
        ORDER BY line_type, description`,
      [id],
    );
    return { statement, lines };
  }), requireOrgScope(session), effectiveReadOptions(session));
}

export async function counts(session: Session) {
  session = await guardEffectiveSession(session, "dash.view");
  await admitCustomRead(session, "dash.view");
  if (session.kind !== "staff") return { pending: 0, tickets: 0 };
  return tx(session.userId, async (client) => withEffectiveReadAuthority(client, session, "dash.view", async () => {
    const row = await maybe<{ pending: string; tickets: string }>(
      client,
      `SELECT
         (SELECT count(*)::text FROM payments WHERE org_id = $1 AND status = 'submitted') AS pending,
         (SELECT count(*)::text FROM maintenance_tickets WHERE org_id = $1 AND status NOT IN ('resolved','closed','cancelled')) AS tickets`,
      [session.orgId],
    );
    return { pending: Number(row?.pending ?? 0), tickets: Number(row?.tickets ?? 0) };
  }), requireOrgScope(session), effectiveReadOptions(session));
}

export async function tenantDetail(session: Session, id: string) {
  session = await guardEffectiveSession(session, "props.view");
  await admitCustomRead(session, "props.view");
  return tx(
    session.userId,
    async (client) => withEffectiveReadAuthority(client, session, "props.view", async () => {
      const tenant = await maybe<{ id: string; name: string }>(
        client,
        `SELECT id::text, display_name AS name
           FROM contacts
          WHERE id = $1 AND org_id = $2 AND is_tenant AND archived_at IS NULL`,
        [id, session.orgId],
      );
      if (!tenant) return null;
      const leases = await many<{ id: string; place: string; status: string }>(
        client,
        `SELECT l.id::text, l.status::text,
                p.name || ' ' || u.label || coalesce(' ' || r.label, '') AS place
           FROM leases l
           JOIN lease_parties lp ON lp.lease_id = l.id AND lp.role = 'primary' AND lp.contact_id = $1
           JOIN properties p ON p.id = l.property_id
           JOIN units u ON u.id = l.unit_id
           LEFT JOIN rooms r ON r.id = l.target_room_id
          WHERE l.org_id = $2
          ORDER BY l.created_at DESC`,
        [id, session.orgId],
      );
      return { tenant, leases };
    }),
    { orgId: session.orgId, environment: session.environment }, effectiveReadOptions(session),
  );
}

export type TenantSignedLeasePdfSummary = {
  id: string;
  source_pdf_id: string;
  created_at: Date | string;
  size_bytes: number;
};

export const TENANT_SIGNED_PDFS_QUERY = `WITH ranked AS (
         SELECT pdf.id, pdf.id AS source_pdf_id, pdf.created_at,
                octet_length(pdf.content) AS size_bytes,
                coalesce(pdf.file_id = l.document_file_id, false) AS matches_pointer,
                bool_or(coalesce(pdf.file_id = l.document_file_id, false)) OVER () AS has_current,
                row_number() OVER (ORDER BY pdf.created_at DESC, pdf.id DESC) AS newest
           FROM lease_signed_pdfs pdf
           JOIN leases l ON l.org_id = pdf.org_id AND l.id = pdf.lease_id
          WHERE pdf.org_id = $1 AND pdf.lease_id = $2
       )
       SELECT id, source_pdf_id, created_at, size_bytes,
              (matches_pointer OR (NOT has_current AND newest = 1)) AS current
         FROM ranked
        ORDER BY current DESC, created_at DESC, id DESC`;

/**
 * All reads use the tenant's authenticated database role. RLS independently
 * checks lease-party ownership, lease organization, and the DB global/org flags.
 * App routes additionally require TENANT_SIGNED_PDF_ENABLED.
 * These queries only read; they never change signing state.
 * The download route records signed_pdf_downloaded after an authorized read
 * and successful PDF response construction. Listing PDFs does not write audit.
 */
export async function tenantSignedLeasePdfs(
  session: Session,
  leaseId: string,
): Promise<(TenantSignedLeasePdfSummary & { current: boolean })[]> {
  session = await guardEffectiveSession(session, null);
  if (session.kind !== "tenant" || !tenantSignedPdfGloballyEnabled()) return [];
  return tx(session.userId, async (client) => withEffectiveReadAuthority(client, session, null, async () => {
    const gate = await maybe<{ enabled: boolean }>(
      client,
      `SELECT app.tenant_signed_pdf_readable($1::uuid, $2::uuid) AS enabled`,
      [session.orgId, leaseId],
    );
    if (!tenantSignedPdfOn(tenantSignedPdfGloballyEnabled(), {
      tenant_signed_pdf: gate?.enabled,
    })) return [];
    return many<TenantSignedLeasePdfSummary & { current: boolean }>(
      client,
      TENANT_SIGNED_PDFS_QUERY,
      [session.orgId, leaseId],
    );
  }), { orgId: session.orgId, environment: session.environment }, effectiveReadOptions(session));
}

export async function tenantSignedLeasePdf(
  session: Session,
  leaseId: string,
  pdfId: string,
) {
  session = await guardEffectiveSession(session, null);
  if (session.kind !== "tenant" || !tenantSignedPdfGloballyEnabled()) return null;
  return tx(session.userId, async (client) =>
    withEffectiveReadAuthority(client, session, null, async () => maybe<TenantSignedLeasePdfSummary & { content: Buffer; file_name: string }>(
      client,
      `SELECT pdf.id, pdf.id AS source_pdf_id, pdf.created_at,
              octet_length(pdf.content) AS size_bytes, pdf.content,
              'signed-lease-' || pdf.id::text || '.pdf' AS file_name
         FROM lease_signed_pdfs pdf
        WHERE pdf.org_id = $1 AND pdf.lease_id = $2 AND pdf.id = $3
          AND app.tenant_signed_pdf_readable(pdf.org_id, pdf.lease_id)
          AND app.is_lease_tenant(pdf.lease_id)`,
      [session.orgId, leaseId, pdfId],
    )),
    { orgId: session.orgId, environment: session.environment }, effectiveReadOptions(session),
  );
}

import { pool, maybe, many, tx } from "./db";
import { rentUtilityDueMinor } from "./money";
import type { Session } from "./types";

export type Tryout = { property: boolean; lease: boolean; statement: boolean; repair: boolean };

const EMPTY_TRYOUT: Tryout = { property: false, lease: false, statement: false, repair: false };

export async function loadTryout(session: Session): Promise<Tryout> {
  try {
    return await tx(session.userId, async (client) => {
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
    });
  } catch {
    return EMPTY_TRYOUT;
  }
}

export async function loadFirm(session: Session) {
  return tx(session.userId, async (client) => {
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
  });
}

export async function dashboard(session: Session) {
  return tx(session.userId, async (client) => {
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
         (SELECT count(*)::text FROM rooms r JOIN units u ON u.id = r.unit_id
           WHERE r.org_id = $1 AND r.archived_at IS NULL) AS rooms,
         (SELECT count(DISTINCT target_room_id)::text FROM leases
           WHERE org_id = $1 AND status IN ('pending_signature','active') AND target_room_id IS NOT NULL) AS occupied`,
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
  });
}

export async function listProperties(session: Session) {
  return tx(session.userId, async (client) =>
    many<{
      id: string;
      name: string;
      address_display: string;
      currency: string;
      rental_mode: string;
      rooms: string;
      occupied: string;
      owner_name: string | null;
    }>(
      client,
      `SELECT p.id::text, p.name, coalesce(p.address_display,'') AS address_display, p.currency,
              p.default_rental_mode::text AS rental_mode,
              (SELECT count(*)::text FROM rooms r JOIN units u ON u.id = r.unit_id
                WHERE u.property_id = p.id AND r.archived_at IS NULL) AS rooms,
              (SELECT count(DISTINCT l.target_room_id)::text FROM leases l
                WHERE l.property_id = p.id AND l.status IN ('pending_signature','active') AND l.target_room_id IS NOT NULL) AS occupied,
              (SELECT c.display_name FROM property_owners po JOIN contacts c ON c.id = po.owner_contact_id
                WHERE po.property_id = p.id AND po.is_primary LIMIT 1) AS owner_name
         FROM properties p
        WHERE p.org_id = $1 AND p.archived_at IS NULL
        ORDER BY p.created_at`,
      [session.orgId],
    ),
  );
}

export async function propertyDetail(session: Session, id: string) {
  return tx(session.userId, async (client) => {
    const property = await maybe<{
      id: string;
      name: string;
      address_display: string;
      currency: string;
      rental_mode: string;
    }>(
      client,
      `SELECT id::text, name, coalesce(address_display,'') AS address_display, currency, default_rental_mode::text AS rental_mode
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
        WHERE u.property_id = $1 AND r.archived_at IS NULL
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
    return { property, owner, rooms, meterSerial };
  });
}

export async function listOwners(session: Session) {
  return tx(session.userId, async (client) =>
    many<{ id: string; name: string }>(
      client,
      `SELECT id::text, display_name AS name FROM contacts
        WHERE org_id = $1 AND is_owner AND archived_at IS NULL
        ORDER BY display_name`,
      [session.orgId],
    ),
  );
}

export type RoomOption = {
  id: string;
  label: string;
  unitLabel: string;
  propertyName: string;
  currency: string;
  baseRentMinor: number;
  unitRooms: { id: string; label: string }[];
};

export async function vacantRooms(session: Session): Promise<RoomOption[]> {
  return tx(session.userId, async (client) => {
    const rows = await many<{
      id: string;
      label: string;
      unit_id: string;
      unit_label: string;
      property_name: string;
      currency: string;
      base_rent_minor: string;
    }>(
      client,
      `SELECT r.id::text, r.label, u.id::text AS unit_id, u.label AS unit_label, p.name AS property_name,
              p.currency, r.base_rent_minor::text
         FROM rooms r
         JOIN units u ON u.id = r.unit_id
         JOIN properties p ON p.id = u.property_id
        WHERE r.org_id = $1 AND r.archived_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM leases l
             WHERE l.target_room_id = r.id AND l.status IN ('pending_signature','active')
          )
        ORDER BY p.created_at DESC, r.label`,
      [session.orgId],
    );
    const unitIds = [...new Set(rows.map((row) => row.unit_id))];
    const siblings = unitIds.length
      ? await many<{ id: string; unit_id: string; label: string }>(
          client,
          `SELECT id::text, unit_id::text, label FROM rooms
            WHERE unit_id = ANY($1::uuid[]) AND archived_at IS NULL ORDER BY label`,
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
      unitRooms: siblings.filter((room) => room.unit_id === row.unit_id).map((room) => ({ id: room.id, label: room.label })),
    }));
  });
}

export async function listLeases(session: Session) {
  return tx(session.userId, async (client) =>
    many<{
      id: string;
      status: string;
      esign: string;
      tenant: string;
      place: string;
      rent: string;
      deposit: string;
      currency: string;
      start_date: string;
      end_date: string;
      electricity: string;
    }>(
      client,
      `SELECT l.id::text, l.status::text, l.esign_status::text AS esign, c.display_name AS tenant,
              p.name || ' ' || u.label || coalesce(' ' || r.label, '') AS place,
              l.rent_amount_minor::text AS rent, l.deposit_amount_minor::text AS deposit, l.currency,
              l.start_date::text, l.end_date::text,
              coalesce(
                (SELECT lc.description FROM lease_charges lc
                  WHERE lc.lease_id = l.id AND lc.charge_type = 'utility' AND lc.description IS NOT NULL
                  LIMIT 1),
                CASE WHEN EXISTS (
                  SELECT 1 FROM meters m
                   WHERE m.property_id = l.property_id AND m.utility = 'electricity' AND m.archived_at IS NULL
                ) THEN 'shared' ELSE '' END
              ) AS electricity
         FROM leases l
         JOIN properties p ON p.id = l.property_id
         JOIN units u ON u.id = l.unit_id
         LEFT JOIN rooms r ON r.id = l.target_room_id
         JOIN lease_parties lp ON lp.lease_id = l.id AND lp.role = 'primary'
         JOIN contacts c ON c.id = lp.contact_id
        WHERE l.org_id = $1
        ORDER BY l.created_at DESC`,
      [session.orgId],
    ),
  );
}

export async function leaseDetail(session: Session, id: string) {
  return tx(session.userId, async (client) => {
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
      tenant: string;
      phone: string | null;
      email: string | null;
      thread_id: string | null;
    }>(
      client,
      `SELECT l.id::text, l.status::text, l.esign_status::text AS esign, l.currency,
              l.rent_amount_minor::text AS rent, l.deposit_amount_minor::text AS deposit, l.due_day,
              l.start_date::text, l.end_date::text,
              p.name || ' ' || u.label || coalesce(' ' || r.label, '') AS place,
              c.display_name AS tenant,
              CASE WHEN app.has_role(l.org_id, '{admin,manager,maintenance}') THEN c.phone_e164 END AS phone,
              c.email,
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
      ? await many<{ invoice_id: string; charge_type: string; amount: string }>(
          client,
          `SELECT invoice_id::text, charge_type::text, amount_minor::text AS amount
             FROM invoice_lines WHERE invoice_id = ANY($1::uuid[]) ORDER BY line_no`,
          [invoices.map((invoice) => invoice.id)],
        )
      : [];
    const open = invoices.filter((invoice) => invoice.status === "open" || invoice.status === "partially_paid");
    const dueMinor = open.reduce((sum, invoice) => {
      const invoiceLines = lines
        .filter((line) => line.invoice_id === invoice.id)
        .map((line) => ({ charge_type: line.charge_type, amount_minor: Number(line.amount) }));
      return sum + rentUtilityDueMinor(invoiceLines, Number(invoice.paid));
    }, 0);
    const sumType = (type: string) =>
      lines.filter((line) => line.charge_type === type).reduce((sum, line) => sum + Number(line.amount), 0);
    return {
      lease,
      signatures,
      invoices,
      lines,
      dueMinor,
      rentMinor: sumType("rent"),
      utilityMinor: sumType("utility"),
      depositMinor: sumType("deposit"),
    };
  });
}

export async function listPayments(session: Session) {
  return tx(session.userId, async (client) =>
    many<{
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
    ),
  );
}

export async function listMatches(session: Session) {
  return tx(session.userId, async (client) =>
    many<{
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
    ),
  );
}

export async function latestUnmatchedPayment(session: Session) {
  return tx(session.userId, async (client) =>
    maybe<{ paid_on: string; amount_minor: string; last5: string | null; currency: string }>(
      client,
      `SELECT paid_on::text, amount_minor::text, payer_account_last5 AS last5, currency
         FROM payments
        WHERE org_id = $1 AND bank_transaction_id IS NULL AND status IN ('submitted','confirmed')
        ORDER BY created_at DESC LIMIT 1`,
      [session.orgId],
    ),
  );
}

export async function listStatements(session: Session) {
  return tx(session.userId, async (client) =>
    many<{
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
    ),
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
  return tx(session.userId, async (client) => {
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
  });
}

export async function rentRoll(session: Session) {
  return tx(session.userId, async (client) =>
    many<{
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
         LEFT JOIN rooms r ON r.unit_id = u.id AND r.archived_at IS NULL
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
          AND (r.id IS NOT NULL OR NOT EXISTS (
            SELECT 1 FROM rooms rx WHERE rx.unit_id = u.id AND rx.archived_at IS NULL
          ))
        ORDER BY p.name, space_label`,
      [session.orgId],
    ),
  );
}

export async function statementDetail(session: Session, id: string) {
  return tx(session.userId, async (client) => {
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
  });
}

export async function listTickets(session: Session) {
  return tx(session.userId, async (client) =>
    many<{
      id: string;
      number: string;
      title: string;
      status: string;
      category: string;
      priority: string;
      place: string;
    }>(
      client,
      `SELECT t.id::text, t.ticket_number::text AS number, t.title, t.status::text, t.category::text, t.priority::text,
              p.name || coalesce(' ' || r.label, '') AS place
         FROM maintenance_tickets t
         JOIN properties p ON p.id = t.property_id
         LEFT JOIN rooms r ON r.id = t.room_id
        WHERE t.org_id = $1
        ORDER BY t.created_at DESC`,
      [session.orgId],
    ),
  );
}

export async function listThreads(session: Session) {
  return tx(session.userId, async (client) =>
    many<{ id: string; place: string; tenant: string; preview: string | null }>(
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
    ),
  );
}

export async function threadMessages(session: Session, threadId: string) {
  return tx(session.userId, async (client) =>
    many<{ id: string; body: string; at: string; mine: boolean }>(
      client,
      `SELECT id::text, body, created_at::text AS at, (sender_user_id = $2) AS mine
         FROM messages WHERE thread_id = $1 ORDER BY created_at`,
      [threadId, session.userId],
    ),
  );
}

export async function listTeam(session: Session) {
  const rows = await tx(session.userId, async (client) =>
    many<{
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
    ),
  );
  const ids = rows.map((row) => row.user_id).filter((id): id is string => Boolean(id));
  const extra = new Map<string, { mfa: boolean; last_sign_in: string | null }>();
  if (ids.length) {
    const facts = await pool.query<{ user_id: string; mfa: boolean; last_sign_in: string | null }>(
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
  return tx(session.userId, async (client) =>
    many<{
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
    ),
  );
}

export async function tenantLeaseMoney(session: Session, leaseId: string) {
  return tx(session.userId, async (client) => {
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
    }>(
      client,
      `SELECT l.id::text, l.currency, l.rent_amount_minor::text AS rent, l.deposit_amount_minor::text AS deposit,
              l.due_day, l.start_date::text, l.end_date::text, l.status::text,
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
      ? await many<{ invoice_id: string; charge_type: string; amount: string }>(
          client,
          `SELECT invoice_id::text, charge_type::text, amount_minor::text AS amount
             FROM invoice_lines WHERE invoice_id = ANY($1::uuid[])`,
          [invoices.map((invoice) => invoice.id)],
        )
      : [];
    const dueMinor = invoices.reduce((sum, invoice) => {
      const invoiceLines = lines
        .filter((line) => line.invoice_id === invoice.id)
        .map((line) => ({ charge_type: line.charge_type, amount_minor: Number(line.amount) }));
      return sum + rentUtilityDueMinor(invoiceLines, Number(invoice.paid));
    }, 0);
    const balance = invoices.reduce((sum, invoice) => sum + Number(invoice.balance), 0);
    return { lease, dueMinor, balance, currency: lease.currency };
  });
}

export async function ownerHome(session: Session) {
  return tx(session.userId, async (client) =>
    many<{
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
    ),
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
  return tx(session.userId, async (client) =>
    many<OwnerRow>(
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
    ),
  );
}

export async function ownerEditor(session: Session, id: string) {
  return tx(session.userId, async (client) => {
    const owner = await maybe<{ id: string; name: string; email: string | null; phone: string | null }>(
      client,
      `SELECT id::text, display_name AS name, email::text, phone_e164 AS phone
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
    return { ...owner, propertyIds: linked.map((row) => row.property_id) };
  });
}

export async function propertyEditor(session: Session, id: string) {
  return tx(session.userId, async (client) => {
    const property = await maybe<{
      id: string;
      name: string;
      address: { city?: string; district?: string; street?: string; line?: string };
      country_code: string;
      owner_contact_id: string | null;
    }>(
      client,
      `SELECT p.id::text, p.name, p.address, p.country_code,
              (SELECT po.owner_contact_id::text FROM property_owners po
                WHERE po.property_id = p.id AND po.is_primary LIMIT 1) AS owner_contact_id
         FROM properties p
        WHERE p.id = $1 AND p.org_id = $2 AND p.archived_at IS NULL`,
      [id, session.orgId],
    );
    return property;
  });
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

export async function listSpaces(session: Session) {
  return tx(session.userId, async (client) =>
    many<SpaceRow>(
      client,
      `SELECT * FROM (
         SELECT 'room'::text AS kind, r.id::text, p.id::text AS property_id, p.name AS property_name, p.currency,
                u.label AS floor, r.label AS room_label, r.room_type::text, r.area_value::text, r.area_unit,
                r.base_rent_minor::text, r.electricity_method,
                (SELECT string_agg(c.display_name, '、' ORDER BY po.is_primary DESC, c.display_name)
                   FROM property_owners po JOIN contacts c ON c.id = po.owner_contact_id
                  WHERE po.property_id = p.id) AS owner_name,
                p.created_at, u.label AS sort_floor, r.label AS sort_room
           FROM rooms r
           JOIN units u ON u.id = r.unit_id
           JOIN properties p ON p.id = u.property_id
          WHERE r.org_id = $1 AND r.archived_at IS NULL AND p.archived_at IS NULL
         UNION ALL
         SELECT 'whole_unit'::text, u.id::text, p.id::text, p.name, p.currency,
                u.label, NULL::text, NULL::text, u.area_value::text, u.area_unit,
                u.base_rent_minor::text, u.electricity_method,
                (SELECT string_agg(c.display_name, '、' ORDER BY po.is_primary DESC, c.display_name)
                   FROM property_owners po JOIN contacts c ON c.id = po.owner_contact_id
                  WHERE po.property_id = p.id),
                p.created_at, u.label, ''
           FROM units u
           JOIN properties p ON p.id = u.property_id
          WHERE u.org_id = $1 AND u.archived_at IS NULL AND u.rental_mode = 'whole_unit' AND p.archived_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM rooms r WHERE r.unit_id = u.id AND r.archived_at IS NULL)
       ) spaces
       ORDER BY created_at, sort_floor, sort_room`,
      [session.orgId],
    ),
  );
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
  return tx(session.userId, async (client) => {
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
          WHERE u.id = $1 AND u.org_id = $2 AND u.rental_mode = 'whole_unit' AND u.archived_at IS NULL`,
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
        WHERE r.id = $1 AND r.org_id = $2 AND r.archived_at IS NULL`,
      [id, session.orgId],
    );
  });
}

export async function counts(session: Session) {
  if (session.kind !== "staff") return { pending: 0, tickets: 0 };
  return tx(session.userId, async (client) => {
    const row = await maybe<{ pending: string; tickets: string }>(
      client,
      `SELECT
         (SELECT count(*)::text FROM payments WHERE org_id = $1 AND status = 'submitted') AS pending,
         (SELECT count(*)::text FROM maintenance_tickets WHERE org_id = $1 AND status NOT IN ('resolved','closed','cancelled')) AS tickets`,
      [session.orgId],
    );
    return { pending: Number(row?.pending ?? 0), tickets: Number(row?.tickets ?? 0) };
  });
}

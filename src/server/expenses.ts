import { guardEffectiveSession, withEffectiveAuthority } from "@/server/b017-custom-role-governance";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { maybe, many, one, tx } from "./db";
import { FlowError } from "./errors";
import { taipeiToday } from "./money";
import { assertPerm } from "./perms";
import type { Session } from "./types";
import { requireOrgScope } from "./org-guard";

/** Statuses the owner monthly statement includes. Keep this list in the SQL fragment below. */
export const STATEMENT_EXPENSE_STATUSES = ["approved", "posted"] as const;

/** Same predicate as generateStatement and the partial index. bill_to stays owner. */
export const STATEMENT_EXPENSE_SQL = "status IN ('approved','posted') AND bill_to = 'owner'";

export const EXPENSE_CATEGORIES = ["repair", "cleaning", "utility", "tax", "insurance", "other"] as const;

export const EXPENSE_STATUSES = ["draft", "submitted", "approved", "rejected", "posted", "void"] as const;

/** Repair drafts and other unposted rows staff can approve onto the books. */
export const APPROVABLE_EXPENSE_STATUSES = ["draft", "submitted", "rejected"] as const;

export function expenseCanBeApproved(status: string) {
  return (APPROVABLE_EXPENSE_STATUSES as readonly string[]).includes(status);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function expenseCountsOnStatement(status: string, billTo: string) {
  return billTo === "owner" && (STATEMENT_EXPENSE_STATUSES as readonly string[]).includes(status);
}

/**
 * A repair cost reaches the owner settlement only after the ticket is closed.
 * Expenses with no ticket are unchanged.
 */
export function repairCostOnStatement(input: {
  status: string;
  billTo: string;
  ticketId: string | null;
  ticketStatus: string | null;
}) {
  if (!expenseCountsOnStatement(input.status, input.billTo)) return false;
  if (!input.ticketId) return true;
  return input.ticketStatus === "closed";
}

/** A month is closed when its YYYY-MM is on or before the latest month_closes row. */
export function monthIsClosed(isoDate: string, closedThrough: string | null) {
  if (!closedThrough) return false;
  return isoDate.slice(0, 7) <= closedThrough.slice(0, 7);
}

/** Largest amount a form may save, in cents (10,000,000.00). */
export const MAX_EXPENSE_CENTS = 1_000_000_000;

/**
 * Form text to integer cents. At most two decimal digits.
 * Digits are concatenated, so a float is never scaled and rounded into cents.
 * Scientific notation, hex, extra decimals, zero, and amounts over the cap are NaN.
 */
export function parseAmountCents(raw: string) {
  const text = raw.replace(/,/g, "").trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return Number.NaN;
  const whole = match[1].replace(/^0+(?=\d)/, "");
  const frac = (match[2] ?? "").padEnd(2, "0");
  const digits = `${whole}${frac}`.replace(/^0+(?=\d)/, "");
  if (digits.length > String(MAX_EXPENSE_CENTS).length) return Number.NaN;
  const cents = Number(digits);
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > MAX_EXPENSE_CENTS) return Number.NaN;
  return cents;
}

/** Major-unit string for an edit field. Whole amounts stay without a decimal. */
export function majorInput(minor: string | number) {
  const value = Number(minor) / 100;
  if (!Number.isFinite(value)) return "";
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2);
}

export type ExpenseDraft = {
  propertyId: string;
  unitId?: string;
  category: string;
  /** Already integer cents, for callers that did not start from form text. */
  amountCents?: number;
  /** Form text. Parsed to cents inside normalizeExpense. */
  amountText?: string;
  incurredOn?: string;
  vendorName?: string;
  description?: string;
  receiptName?: string;
};

type NormalizedExpense = {
  propertyId: string;
  unitId: string;
  category: string;
  amount: number;
  incurredOn: string | null;
  vendorName: string;
  description: string;
  receiptName: string;
};

export function normalizeExpense(input: ExpenseDraft, allowCategory?: string): NormalizedExpense {
  const propertyId = input.propertyId.trim();
  const unitId = (input.unitId ?? "").trim();
  const category = input.category.trim();
  const vendorName = (input.vendorName ?? "").trim().slice(0, 200);
  const description = (input.description ?? "").trim().slice(0, 2000);
  const receiptName = (input.receiptName ?? "").trim().slice(0, 180);
  if (!UUID.test(propertyId)) throw new FlowError("errors.required");
  if (unitId && !UUID.test(unitId)) throw new FlowError("errors.notFound");
  const known = (EXPENSE_CATEGORIES as readonly string[]).includes(category);
  if (!category || (!known && category !== allowCategory)) throw new FlowError("errors.required");
  let incurredOn: string | null = null;
  if (input.incurredOn !== undefined) {
    const value = input.incurredOn.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new FlowError("errors.required");
    incurredOn = value;
  }
  const amount = input.amountText !== undefined ? parseAmountCents(input.amountText) : input.amountCents;
  if (amount === undefined || !Number.isInteger(amount) || amount <= 0 || amount > MAX_EXPENSE_CENTS) {
    throw new FlowError("errors.expenseAmount");
  }
  return { propertyId, unitId, category, amount, incurredOn, vendorName, description, receiptName };
}

export type ExpenseListRow = {
  id: string;
  property_id: string;
  property_name: string;
  unit_id: string | null;
  unit_label: string | null;
  category: string;
  description: string;
  currency: string;
  amount_minor: string;
  incurred_on: string;
  status: string;
  bill_to: string;
  vendor_name: string | null;
  receipt_name: string | null;
  ticket_id: string | null;
  ticket_number: string | null;
  ticket_status: string | null;
  included: boolean;
};

export type ExpenseDetail = ExpenseListRow & {
  on_issued: boolean;
  month_closed: boolean;
};

type ChoiceProperty = { id: string; name: string; archiveState: "active" | "archived" };
type ChoiceUnit = { id: string; property_id: string; label: string; property_name: string; archiveState: "active" | "archived" | "inherited" };
type ChoiceVendor = { id: string; name: string };

function day(value: string) {
  return value.slice(0, 10);
}

function asIncluded(row: { status: string; bill_to: string; ticket_id: string | null; ticket_status: string | null }) {
  return repairCostOnStatement({
    status: row.status,
    billTo: row.bill_to,
    ticketId: row.ticket_id,
    ticketStatus: row.ticket_status,
  });
}

async function setReason(client: Client, reason: string) {
  await client.query(`SELECT set_config('app.change_reason', $1, true)`, [reason.slice(0, 500)]);
}

async function closedThrough(client: Client, orgId: string) {
  const row = await maybe<{ m: string | null }>(
    client,
    `SELECT max(period_month)::text AS m FROM month_closes WHERE org_id = $1`,
    [orgId],
  );
  return row?.m ? day(row.m) : null;
}

async function loadProperty(client: Client, orgId: string, propertyId: string, allowArchived = false) {
  const row = await maybe<{ id: string; currency: string }>(
    client,
    `SELECT id::text, currency FROM properties WHERE id = $1 AND org_id = $2 AND (archived_at IS NULL OR $3::boolean)`,
    [propertyId, orgId, allowArchived],
  );
  if (!row) throw new FlowError("errors.notFound");
  return row;
}

async function loadUnit(client: Client, orgId: string, propertyId: string, unitId: string, allowArchived = false) {
  if (!unitId) return null;
  const row = await maybe<{ id: string }>(
    client,
    `SELECT id::text FROM units
      WHERE id = $1 AND org_id = $2 AND property_id = $3 AND (archived_at IS NULL OR $4::boolean)`,
    [unitId, orgId, propertyId, allowArchived],
  );
  if (!row) throw new FlowError("errors.notFound");
  return row.id;
}

async function vendorIdFor(client: Client, orgId: string, name: string) {
  if (!name) return null;
  const existing = await maybe<{ id: string }>(
    client,
    `SELECT id::text FROM contacts
      WHERE org_id = $1 AND is_vendor AND archived_at IS NULL AND display_name = $2
      ORDER BY created_at
      LIMIT 1`,
    [orgId, name],
  );
  if (existing) return existing.id;
  const created = await one<{ id: string }>(
    client,
    `INSERT INTO contacts (org_id, is_vendor, display_name) VALUES ($1, true, $2) RETURNING id::text`,
    [orgId, name],
  );
  return created.id;
}

async function insertReceipt(client: Client, session: Session, name: string) {
  const file = await one<{ id: string }>(
    client,
    `INSERT INTO files (org_id, storage_bucket, storage_path, file_name, mime_type, size_bytes, uploaded_by)
     VALUES ($1, 'receipts', $2, $3, 'text/plain', $4, $5) RETURNING id::text`,
    [session.orgId, `demo/${randomUUID()}.txt`, name, Buffer.byteLength(name), session.userId],
  );
  return file.id;
}

async function firstOpenDay(client: Client, orgId: string) {
  const closed = await closedThrough(client, orgId);
  const today = taipeiToday();
  if (!closed || today.slice(0, 7) > closed.slice(0, 7)) return today;
  const [year, month] = closed.slice(0, 7).split("-").map(Number);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;
}

/** Owner-billed expenses only. Posts expense debit and owner_payable credit. */
async function postLedger(
  client: Client,
  session: Session,
  row: { expenseId: string; propertyId: string; currency: string; incurred: string; memo: string; amount: number },
) {
  const txn = await one<{ id: string }>(
    client,
    `INSERT INTO ledger_transactions (
       org_id, property_id, kind, currency, effective_date, description, source_table, source_id, created_by
     ) VALUES ($1,$2,'expense',$3,$4,$5,'expenses',$6,$7) RETURNING id::text`,
    [session.orgId, row.propertyId, row.currency, row.incurred, row.memo, row.expenseId, session.userId],
  );
  await client.query(
    `INSERT INTO ledger_entries (org_id, transaction_id, account, amount_minor, currency, property_id, memo)
     VALUES ($1,$2,'expense',$3,$4,$5,$6), ($1,$2,'owner_payable',$7,$4,$5,$6)`,
    [session.orgId, txn.id, row.amount, row.currency, row.propertyId, row.memo, -row.amount],
  );
  await client.query(`UPDATE expenses SET ledger_transaction_id = $2 WHERE id = $1 AND org_id = $3`, [
    row.expenseId,
    txn.id,
    session.orgId,
  ]);
}

async function onIssuedStatement(client: Client, orgId: string, expenseId: string) {
  const row = await maybe<{ linked: boolean }>(
    client,
    `SELECT EXISTS (
       SELECT 1 FROM owner_statement_lines l
       JOIN owner_statements s ON s.id = l.statement_id
       WHERE l.expense_id = $1 AND s.org_id = $2 AND s.status <> 'void'
     ) AS linked`,
    [expenseId, orgId],
  );
  return Boolean(row?.linked);
}

const LIST_SQL = `SELECT e.id::text, e.property_id::text, p.name AS property_name,
            e.unit_id::text,
            CASE
              WHEN u.label IS NOT NULL AND rm.label IS NOT NULL THEN u.label || ' · ' || rm.label
              ELSE coalesce(u.label, rm.label)
            END AS unit_label,
            e.category, coalesce(e.description, '') AS description,
            e.currency, e.amount_minor::text, e.incurred_on::text, e.status::text, e.bill_to::text,
            c.display_name AS vendor_name, f.file_name AS receipt_name,
            e.ticket_id::text, t.ticket_number::text AS ticket_number, t.status::text AS ticket_status
       FROM expenses e
       JOIN properties p ON p.id = e.property_id
       LEFT JOIN units u ON u.id = e.unit_id
       LEFT JOIN contacts c ON c.id = e.vendor_contact_id
       LEFT JOIN files f ON f.id = e.receipt_file_id
       LEFT JOIN maintenance_tickets t ON t.id = e.ticket_id AND t.org_id = e.org_id
       LEFT JOIN rooms rm ON rm.id = t.room_id`;

function mapRow(row: Omit<ExpenseListRow, "included" | "incurred_on"> & { incurred_on: string }): ExpenseListRow {
  const incurred_on = day(row.incurred_on);
  return {
    ...row,
    incurred_on,
    included: asIncluded({
      status: row.status,
      bill_to: row.bill_to,
      ticket_id: row.ticket_id,
      ticket_status: row.ticket_status,
    }),
  };
}

export async function expenseFormOptions(session: Session, expenseId?: string) {
  session = await guardEffectiveSession(session, "exp.add");
  assertPerm(session, "exp.add");
  if (expenseId !== undefined && !UUID.test(expenseId)) throw new FlowError("errors.notFound");
  return tx(session.userId, async (client) => withEffectiveAuthority(client, session, "exp.add", async () => {
    const stored = expenseId ? await maybe<{ property_id: string; unit_id: string | null }>(client,
      `SELECT property_id::text, unit_id::text FROM expenses WHERE org_id = $1 AND id = $2`, [session.orgId, expenseId]) : null;
    if (expenseId && !stored) throw new FlowError("errors.notFound");
    const properties = await many<ChoiceProperty>(
      client,
      `SELECT id::text, name, CASE WHEN archived_at IS NULL THEN 'active' ELSE 'archived' END AS "archiveState" FROM properties WHERE org_id = $1 AND (archived_at IS NULL OR id = $2::uuid) ORDER BY name`,
      [session.orgId, stored?.property_id ?? null],
    );
    const units = await many<ChoiceUnit>(
      client,
      `SELECT u.id::text, u.property_id::text, u.label, p.name AS property_name,
              CASE WHEN u.archived_at IS NOT NULL THEN 'archived' WHEN p.archived_at IS NOT NULL THEN 'inherited' ELSE 'active' END AS "archiveState"
         FROM units u
         JOIN properties p ON p.id = u.property_id AND p.org_id = u.org_id
        WHERE u.org_id = $1 AND ((u.archived_at IS NULL AND p.archived_at IS NULL) OR (u.id = $2::uuid AND u.property_id = $3::uuid))
        ORDER BY p.name, u.label`,
      [session.orgId, stored?.unit_id ?? null, stored?.property_id ?? null],
    );
    const vendors = await many<ChoiceVendor>(
      client,
      `SELECT id::text, display_name AS name FROM contacts
        WHERE org_id = $1 AND is_vendor AND archived_at IS NULL
        ORDER BY display_name`,
      [session.orgId],
    );
    return { properties, units, vendors };
  }), requireOrgScope(session));
}

export async function listExpenses(
  session: Session,
  filters: { propertyId?: string; unitId?: string; status?: string } = {},
) {
  session = await guardEffectiveSession(session, "exp.add");
  assertPerm(session, "exp.add");
  const propertyId = filters.propertyId && UUID.test(filters.propertyId) ? filters.propertyId : null;
  const unitId = filters.unitId && UUID.test(filters.unitId) ? filters.unitId : null;
  const status = (EXPENSE_STATUSES as readonly string[]).includes(filters.status ?? "") ? filters.status : null;
  return tx(session.userId, async (client) => withEffectiveAuthority(client, session, "exp.add", async () => {
    const rows = await many<Omit<ExpenseListRow, "included">>(
      client,
      `${LIST_SQL}
        WHERE e.org_id = $1
          AND ($2::uuid IS NULL OR e.property_id = $2)
          AND ($3::uuid IS NULL OR e.unit_id = $3)
          AND ($4::text IS NULL OR e.status::text = $4)
        ORDER BY e.incurred_on DESC, e.created_at DESC`,
      [session.orgId, propertyId, unitId, status],
    );
    return rows.map((row) => mapRow(row));
  }), requireOrgScope(session));
}

export async function getExpense(session: Session, expenseId: string): Promise<ExpenseDetail | null> {
  session = await guardEffectiveSession(session, "exp.add");
  assertPerm(session, "exp.add");
  if (!UUID.test(expenseId)) return null;
  return tx(session.userId, async (client) => withEffectiveAuthority(client, session, "exp.add", async () => {
    const row = await maybe<Omit<ExpenseListRow, "included">>(
      client,
      `${LIST_SQL} WHERE e.org_id = $1 AND e.id = $2`,
      [session.orgId, expenseId],
    );
    if (!row) return null;
    const mapped = mapRow(row);
    const closed = await closedThrough(client, session.orgId);
    return {
      ...mapped,
      on_issued: await onIssuedStatement(client, session.orgId, expenseId),
      month_closed: monthIsClosed(mapped.incurred_on, closed),
    };
  }), requireOrgScope(session));
}

export async function createExpense(session: Session, input: ExpenseDraft) {
  session = await guardEffectiveSession(session, "exp.add");
  assertPerm(session, "exp.add");
  const fields = normalizeExpense(input);
  return tx(session.userId, async (client) => withEffectiveAuthority(client, session, "exp.add", async () => {
    await setReason(client, "expense_create");
    const property = await loadProperty(client, session.orgId, fields.propertyId);
    const unitId = await loadUnit(client, session.orgId, fields.propertyId, fields.unitId);
    const incurred = fields.incurredOn ?? (await firstOpenDay(client, session.orgId));
    const closed = await closedThrough(client, session.orgId);
    if (monthIsClosed(incurred, closed)) throw new FlowError("errors.monthClosed");
    const vendorId = await vendorIdFor(client, session.orgId, fields.vendorName);
    const receiptId = fields.receiptName ? await insertReceipt(client, session, fields.receiptName) : null;
    const memo = fields.description || fields.category;
    const expense = await one<{ id: string }>(
      client,
      `INSERT INTO expenses (
         org_id, property_id, unit_id, vendor_contact_id, category, description, currency, amount_minor,
         incurred_on, paid_by, bill_to, receipt_file_id, status, approved_by, approved_at, created_by
       ) VALUES (
         $1,$2,$3,$4,$5,NULLIF($6, ''),$7,$8,$9,'manager_firm','owner',$10,'posted',$11,now(),$11
       ) RETURNING id::text`,
      [
        session.orgId,
        fields.propertyId,
        unitId,
        vendorId,
        fields.category,
        fields.description,
        property.currency,
        fields.amount,
        incurred,
        receiptId,
        session.userId,
      ],
    );
    await postLedger(client, session, {
      expenseId: expense.id,
      propertyId: fields.propertyId,
      currency: property.currency,
      incurred,
      memo,
      amount: fields.amount,
    });
    return { expenseId: expense.id, incurred };
  }), requireOrgScope(session));
}

type StoredExpense = {
  id: string;
  property_id: string;
  unit_id: string | null;
  status: string;
  amount_minor: string;
  incurred_on: string;
  ledger_transaction_id: string | null;
  category: string;
  bill_to: string;
  currency: string;
  description: string | null;
  ticket_id: string | null;
};

async function loadStored(client: Client, orgId: string, expenseId: string) {
  const row = await maybe<StoredExpense>(
    client,
    `SELECT id::text, property_id::text, unit_id::text, status::text, amount_minor::text, incurred_on::text,
            ledger_transaction_id::text, category, bill_to::text, currency, description, ticket_id::text
       FROM expenses WHERE id = $1 AND org_id = $2
       FOR UPDATE`,
    [expenseId, orgId],
  );
  if (!row) throw new FlowError("errors.notFound");
  return { ...row, incurred_on: day(row.incurred_on) };
}

export async function updateExpense(session: Session, expenseId: string, input: ExpenseDraft) {
  session = await guardEffectiveSession(session, "exp.add");
  assertPerm(session, "exp.add");
  if (!UUID.test(expenseId)) throw new FlowError("errors.notFound");
  return tx(session.userId, async (client) => withEffectiveAuthority(client, session, "exp.add", async () => {
    const current = await loadStored(client, session.orgId, expenseId);
    if (current.status === "void") throw new FlowError("errors.expenseVoid");
    const fields = normalizeExpense(input, current.category);
    await setReason(client, "expense_update");
    const closed = await closedThrough(client, session.orgId);
    if (monthIsClosed(current.incurred_on, closed)) throw new FlowError("errors.monthClosed");
    const incurred = fields.incurredOn ?? current.incurred_on;
    if (monthIsClosed(incurred, closed)) throw new FlowError("errors.monthClosed");
    const sameProperty = fields.propertyId === current.property_id;
    const sameTarget = sameProperty && (fields.unitId || null) === current.unit_id;
    const property = await loadProperty(client, session.orgId, fields.propertyId, sameTarget);
    const unitId = await loadUnit(client, session.orgId, fields.propertyId, fields.unitId, sameTarget);
    if (sameProperty) property.currency = current.currency;
    const financial =
      fields.amount !== Number(current.amount_minor) ||
      incurred !== current.incurred_on ||
      fields.propertyId !== current.property_id;
    if (financial && (await onIssuedStatement(client, session.orgId, expenseId))) {
      throw new FlowError("errors.expenseLocked");
    }
    const vendorId = await vendorIdFor(client, session.orgId, fields.vendorName);
    const receiptId = fields.receiptName ? await insertReceipt(client, session, fields.receiptName) : null;
    const ownerLedger = current.bill_to === "owner" && (current.status === "posted" || Boolean(current.ledger_transaction_id));
    if (financial && ownerLedger && current.ledger_transaction_id) {
      const reversed = await maybe<{ id: string }>(
        client,
        `SELECT id::text FROM ledger_transactions WHERE reverses_transaction_id = $1 LIMIT 1`,
        [current.ledger_transaction_id],
      );
      if (!reversed) await client.query(`SELECT post_reversal($1::uuid, $2)`, [current.ledger_transaction_id, "expense_update"]);
    }
    const updated = await client.query(
      `UPDATE expenses SET
         property_id = $2,
         unit_id = $3,
         vendor_contact_id = $4,
         category = $5,
         description = NULLIF($6, ''),
         currency = $7,
         amount_minor = $8,
         incurred_on = $9,
         receipt_file_id = COALESCE($10::uuid, receipt_file_id)
       WHERE id = $1 AND org_id = $11 AND status <> 'void'`,
      [
        expenseId,
        fields.propertyId,
        unitId,
        vendorId,
        fields.category,
        fields.description,
        property.currency,
        fields.amount,
        incurred,
        receiptId,
        session.orgId,
      ],
    );
    if (updated.rowCount !== 1) throw new FlowError("errors.expenseVoid");
    if (financial && ownerLedger) {
      await postLedger(client, session, {
        expenseId,
        propertyId: fields.propertyId,
        currency: property.currency,
        incurred,
        memo: fields.description || fields.category,
        amount: fields.amount,
      });
    }
    return { expenseId };
  }), { orgId: session.orgId, environment: session.environment });
}

export async function voidExpense(session: Session, expenseId: string, reason: string) {
  session = await guardEffectiveSession(session, "exp.add");
  assertPerm(session, "exp.add");
  const note = reason.trim();
  if (!UUID.test(expenseId)) throw new FlowError("errors.notFound");
  if (!note) throw new FlowError("errors.required");
  await tx(session.userId, async (client) => withEffectiveAuthority(client, session, "exp.add", async () => {
    const current = await loadStored(client, session.orgId, expenseId);
    if (current.status === "void") throw new FlowError("errors.expenseVoid");
    if (await onIssuedStatement(client, session.orgId, expenseId)) throw new FlowError("errors.expenseLocked");
    const closed = await closedThrough(client, session.orgId);
    if (monthIsClosed(current.incurred_on, closed)) throw new FlowError("errors.monthClosed");
    await setReason(client, note);
    if (current.bill_to === "owner" && current.ledger_transaction_id) {
      const reversed = await maybe<{ id: string }>(
        client,
        `SELECT id::text FROM ledger_transactions WHERE reverses_transaction_id = $1 LIMIT 1`,
        [current.ledger_transaction_id],
      );
      if (!reversed) await client.query(`SELECT post_reversal($1::uuid, $2)`, [current.ledger_transaction_id, note]);
    }
    const updated = await client.query(
      `UPDATE expenses SET status = 'void', ticket_id = NULL WHERE id = $1 AND org_id = $2 AND status <> 'void'`,
      [expenseId, session.orgId],
    );
    if (updated.rowCount !== 1) throw new FlowError("errors.expenseVoid");
    await releaseRepairLink(client, session.orgId, expenseId, current.ticket_id);
  }), { orgId: session.orgId, environment: session.environment });
}

/** Drop this row's repair link and point the ticket at another open expense, if that column exists. */
async function releaseRepairLink(client: Client, orgId: string, expenseId: string, ticketId: string | null) {
  if (!ticketId) return;
  const column = await maybe<{ ok: boolean }>(
    client,
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'maintenance_tickets' AND column_name = 'expense_id'
     ) AS ok`,
  );
  if (!column?.ok) return;
  const next = await maybe<{ id: string }>(
    client,
    `SELECT id::text FROM expenses
      WHERE org_id = $1 AND ticket_id = $2 AND id <> $3 AND status <> 'void'
      ORDER BY created_at DESC
      LIMIT 1`,
    [orgId, ticketId, expenseId],
  );
  await client.query(`UPDATE maintenance_tickets SET expense_id = $3::uuid WHERE org_id = $1 AND expense_id = $2`, [
    orgId,
    expenseId,
    next?.id ?? null,
  ]);
}

/**
 * Posted owner repair from a confirmed vendor cost.
 * Same shape as a staff expense: bill_to owner, status posted, ledger entry.
 * A closed month moves the date to the first open day, matching other repairs.
 */
export async function insertPostedRepairExpense(
  client: Client,
  session: Session,
  input: {
    propertyId: string;
    unitId: string | null;
    ticketId: string;
    vendorName: string;
    description: string;
    currency: string;
    amountCents: number;
    incurredOn: string;
  },
) {
  session = await guardEffectiveSession(session, "exp.add");
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0 || input.amountCents > MAX_EXPENSE_CENTS) {
    throw new FlowError("errors.expenseAmount");
  }
  const closed = await closedThrough(client, session.orgId);
  const incurred = monthIsClosed(input.incurredOn, closed) ? await firstOpenDay(client, session.orgId) : input.incurredOn;
  if (monthIsClosed(incurred, closed)) throw new FlowError("errors.monthClosed");
  await setReason(client, "repair_vendor_confirm");
  const vendorId = await vendorIdFor(client, session.orgId, input.vendorName);
  const description = input.description.trim().slice(0, 2000);
  const expense = await one<{ id: string }>(
    client,
    `INSERT INTO expenses (
       org_id, property_id, unit_id, ticket_id, vendor_contact_id,
       category, description, currency, amount_minor, incurred_on,
       paid_by, bill_to, status, approved_by, approved_at, created_by
     ) VALUES (
       $1,$2,$3,$4,$5,
       'repair', NULLIF($6, ''), $7, $8, $9::date,
       'manager_firm', 'owner', 'posted', $10, now(), $10
     ) RETURNING id::text`,
    [
      session.orgId,
      input.propertyId,
      input.unitId,
      input.ticketId,
      vendorId,
      description,
      input.currency.trim(),
      input.amountCents,
      incurred,
      session.userId,
    ],
  );
  await postLedger(client, session, {
    expenseId: expense.id,
    propertyId: input.propertyId,
    currency: input.currency.trim(),
    incurred,
    memo: description || "repair",
    amount: input.amountCents,
  });
  return { expenseId: expense.id, incurred };
}

/**
 * Move a repair draft (or a submitted/rejected row) to posted.
 * Owner-billed rows get a ledger entry so they match a new staff expense.
 * ticket_id is left as the repair recorded it.
 */
export async function approveExpense(session: Session, expenseId: string) {
  session = await guardEffectiveSession(session, "exp.add");
  assertPerm(session, "exp.add");
  if (!UUID.test(expenseId)) throw new FlowError("errors.notFound");
  return tx(session.userId, async (client) => withEffectiveAuthority(client, session, "exp.add", async () => {
    const current = await loadStored(client, session.orgId, expenseId);
    if (current.status === "void") throw new FlowError("errors.expenseVoid");
    if (!expenseCanBeApproved(current.status)) throw new FlowError("errors.expenseState");
    const closed = await closedThrough(client, session.orgId);
    if (monthIsClosed(current.incurred_on, closed)) throw new FlowError("errors.monthClosed");
    await setReason(client, "expense_approve");
    const updated = await client.query(
      `UPDATE expenses
          SET status = 'posted', approved_by = $3, approved_at = now()
        WHERE id = $1 AND org_id = $2
          AND status = ANY($4::expense_status[])`,
      [expenseId, session.orgId, session.userId, APPROVABLE_EXPENSE_STATUSES],
    );
    if (updated.rowCount !== 1) throw new FlowError("errors.expenseState");
    if (current.bill_to === "owner" && !current.ledger_transaction_id) {
      await postLedger(client, session, {
        expenseId,
        propertyId: current.property_id,
        currency: current.currency.trim(),
        incurred: current.incurred_on,
        memo: current.description?.trim() || current.category,
        amount: Number(current.amount_minor),
      });
    }
    return { expenseId, ticketId: current.ticket_id };
  }), requireOrgScope(session));
}

/** Statements shortcut: receipt required, category repair, date is the first open day. */
export async function addExpense(
  session: Session,
  input: { propertyId: string; description: string; amountText: string; receiptName: string },
) {
  session = await guardEffectiveSession(session, "exp.add");
  assertPerm(session, "exp.add");
  const description = input.description.trim();
  const receiptName = input.receiptName.trim();
  const amountText = input.amountText.trim();
  if (!description || !receiptName || !amountText) throw new FlowError("errors.required");
  return createExpense(session, {
    propertyId: input.propertyId,
    category: "repair",
    description,
    amountText,
    receiptName,
  });
}

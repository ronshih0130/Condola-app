import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { maybe, many, one, tx } from "./db";
import { FlowError } from "./errors";
import { taipeiToday, toMinor } from "./money";
import { assertPerm } from "./perms";
import type { Session } from "./types";

/** Statuses the owner monthly statement includes. Keep this list in the SQL fragment below. */
export const STATEMENT_EXPENSE_STATUSES = ["approved", "posted"] as const;

/** Same predicate as generateStatement and the partial index. bill_to stays owner. */
export const STATEMENT_EXPENSE_SQL = "status IN ('approved','posted') AND bill_to = 'owner'";

export const EXPENSE_CATEGORIES = ["repair", "cleaning", "utility", "tax", "insurance", "other"] as const;

export const EXPENSE_STATUSES = ["draft", "submitted", "approved", "rejected", "posted", "void"] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function expenseCountsOnStatement(status: string, billTo: string) {
  return billTo === "owner" && (STATEMENT_EXPENSE_STATUSES as readonly string[]).includes(status);
}

/** A month is closed when its YYYY-MM is on or before the latest month_closes row. */
export function monthIsClosed(isoDate: string, closedThrough: string | null) {
  if (!closedThrough) return false;
  return isoDate.slice(0, 7) <= closedThrough.slice(0, 7);
}

export function parseAmountMajor(raw: string) {
  return Number(raw.replace(/,/g, "").trim());
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
  amountMajor: number;
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
  const amount = toMinor(input.amountMajor);
  if (!Number.isFinite(amount) || amount <= 0) throw new FlowError("errors.expenseAmount");
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
  included: boolean;
};

export type ExpenseDetail = ExpenseListRow & {
  on_issued: boolean;
  month_closed: boolean;
};

type ChoiceProperty = { id: string; name: string };
type ChoiceUnit = { id: string; property_id: string; label: string; property_name: string };
type ChoiceVendor = { id: string; name: string };

function day(value: string) {
  return value.slice(0, 10);
}

function asIncluded(status: string, billTo: string) {
  return expenseCountsOnStatement(status, billTo);
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

async function loadProperty(client: Client, orgId: string, propertyId: string) {
  const row = await maybe<{ id: string; currency: string }>(
    client,
    `SELECT id::text, currency FROM properties WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`,
    [propertyId, orgId],
  );
  if (!row) throw new FlowError("errors.notFound");
  return row;
}

async function loadUnit(client: Client, orgId: string, propertyId: string, unitId: string) {
  if (!unitId) return null;
  const row = await maybe<{ id: string }>(
    client,
    `SELECT id::text FROM units
      WHERE id = $1 AND org_id = $2 AND property_id = $3 AND archived_at IS NULL`,
    [unitId, orgId, propertyId],
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
            e.unit_id::text, u.label AS unit_label, e.category, coalesce(e.description, '') AS description,
            e.currency, e.amount_minor::text, e.incurred_on::text, e.status::text, e.bill_to::text,
            c.display_name AS vendor_name, f.file_name AS receipt_name
       FROM expenses e
       JOIN properties p ON p.id = e.property_id
       LEFT JOIN units u ON u.id = e.unit_id
       LEFT JOIN contacts c ON c.id = e.vendor_contact_id
       LEFT JOIN files f ON f.id = e.receipt_file_id`;

function mapRow(row: Omit<ExpenseListRow, "included" | "incurred_on"> & { incurred_on: string }): ExpenseListRow {
  const incurred_on = day(row.incurred_on);
  return { ...row, incurred_on, included: asIncluded(row.status, row.bill_to) };
}

export async function expenseFormOptions(session: Session) {
  assertPerm(session, "exp.add");
  return tx(session.userId, async (client) => {
    const properties = await many<ChoiceProperty>(
      client,
      `SELECT id::text, name FROM properties WHERE org_id = $1 AND archived_at IS NULL ORDER BY name`,
      [session.orgId],
    );
    const units = await many<ChoiceUnit>(
      client,
      `SELECT u.id::text, u.property_id::text, u.label, p.name AS property_name
         FROM units u
         JOIN properties p ON p.id = u.property_id
        WHERE u.org_id = $1 AND u.archived_at IS NULL AND p.archived_at IS NULL
        ORDER BY p.name, u.label`,
      [session.orgId],
    );
    const vendors = await many<ChoiceVendor>(
      client,
      `SELECT id::text, display_name AS name FROM contacts
        WHERE org_id = $1 AND is_vendor AND archived_at IS NULL
        ORDER BY display_name`,
      [session.orgId],
    );
    return { properties, units, vendors };
  });
}

export async function listExpenses(
  session: Session,
  filters: { propertyId?: string; unitId?: string; status?: string } = {},
) {
  assertPerm(session, "exp.add");
  const propertyId = filters.propertyId && UUID.test(filters.propertyId) ? filters.propertyId : null;
  const unitId = filters.unitId && UUID.test(filters.unitId) ? filters.unitId : null;
  const status = (EXPENSE_STATUSES as readonly string[]).includes(filters.status ?? "") ? filters.status : null;
  return tx(session.userId, async (client) => {
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
  });
}

export async function getExpense(session: Session, expenseId: string): Promise<ExpenseDetail | null> {
  assertPerm(session, "exp.add");
  if (!UUID.test(expenseId)) return null;
  return tx(session.userId, async (client) => {
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
  });
}

export async function createExpense(session: Session, input: ExpenseDraft) {
  assertPerm(session, "exp.add");
  const fields = normalizeExpense(input);
  return tx(session.userId, async (client) => {
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
  });
}

type StoredExpense = {
  id: string;
  property_id: string;
  status: string;
  amount_minor: string;
  incurred_on: string;
  ledger_transaction_id: string | null;
  category: string;
};

async function loadStored(client: Client, orgId: string, expenseId: string) {
  const row = await maybe<StoredExpense>(
    client,
    `SELECT id::text, property_id::text, status::text, amount_minor::text, incurred_on::text,
            ledger_transaction_id::text, category
       FROM expenses WHERE id = $1 AND org_id = $2`,
    [expenseId, orgId],
  );
  if (!row) throw new FlowError("errors.notFound");
  return { ...row, incurred_on: day(row.incurred_on) };
}

export async function updateExpense(session: Session, expenseId: string, input: ExpenseDraft) {
  assertPerm(session, "exp.add");
  if (!UUID.test(expenseId)) throw new FlowError("errors.notFound");
  return tx(session.userId, async (client) => {
    const current = await loadStored(client, session.orgId, expenseId);
    if (current.status === "void") throw new FlowError("errors.expenseVoid");
    const fields = normalizeExpense(input, current.category);
    await setReason(client, "expense_update");
    const closed = await closedThrough(client, session.orgId);
    if (monthIsClosed(current.incurred_on, closed)) throw new FlowError("errors.monthClosed");
    const incurred = fields.incurredOn ?? current.incurred_on;
    if (monthIsClosed(incurred, closed)) throw new FlowError("errors.monthClosed");
    const property = await loadProperty(client, session.orgId, fields.propertyId);
    const unitId = await loadUnit(client, session.orgId, fields.propertyId, fields.unitId);
    const financial =
      fields.amount !== Number(current.amount_minor) ||
      incurred !== current.incurred_on ||
      fields.propertyId !== current.property_id;
    if (financial && (await onIssuedStatement(client, session.orgId, expenseId))) {
      throw new FlowError("errors.expenseLocked");
    }
    const vendorId = await vendorIdFor(client, session.orgId, fields.vendorName);
    const receiptId = fields.receiptName ? await insertReceipt(client, session, fields.receiptName) : null;
    if (financial && current.ledger_transaction_id) {
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
    if (financial && (current.status === "posted" || current.ledger_transaction_id)) {
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
  });
}

export async function voidExpense(session: Session, expenseId: string, reason: string) {
  assertPerm(session, "exp.add");
  const note = reason.trim();
  if (!UUID.test(expenseId)) throw new FlowError("errors.notFound");
  if (!note) throw new FlowError("errors.required");
  await tx(session.userId, async (client) => {
    const current = await loadStored(client, session.orgId, expenseId);
    if (current.status === "void") throw new FlowError("errors.expenseVoid");
    const closed = await closedThrough(client, session.orgId);
    if (monthIsClosed(current.incurred_on, closed)) throw new FlowError("errors.monthClosed");
    await setReason(client, note);
    if (current.ledger_transaction_id) {
      const reversed = await maybe<{ id: string }>(
        client,
        `SELECT id::text FROM ledger_transactions WHERE reverses_transaction_id = $1 LIMIT 1`,
        [current.ledger_transaction_id],
      );
      if (!reversed) await client.query(`SELECT post_reversal($1::uuid, $2)`, [current.ledger_transaction_id, note]);
    }
    const updated = await client.query(
      `UPDATE expenses SET status = 'void' WHERE id = $1 AND org_id = $2 AND status <> 'void'`,
      [expenseId, session.orgId],
    );
    if (updated.rowCount !== 1) throw new FlowError("errors.expenseVoid");
  });
}

/** Statements shortcut: receipt required, category repair, date is the first open day. */
export async function addExpense(
  session: Session,
  input: { propertyId: string; description: string; amountMajor: number; receiptName: string },
) {
  assertPerm(session, "exp.add");
  const description = input.description.trim();
  const receiptName = input.receiptName.trim();
  if (!description || !receiptName || !(toMinor(input.amountMajor) > 0)) throw new FlowError("errors.required");
  return createExpense(session, {
    propertyId: input.propertyId,
    category: "repair",
    description,
    amountMajor: input.amountMajor,
    receiptName,
  });
}

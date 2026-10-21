import type { Client } from "pg";
import { maybe, one } from "./db";
import { FlowError } from "./errors";
import type { Session } from "./types";

/** Owner monthly statement line for electricity that no tenant is billed. */
export const VACANT_ELECTRICITY_DESCRIPTION = "電費（空房）";

/** Master-meter kWh minus room meters. Owner only; never split onto tenants. */
export const PUBLIC_ELECTRICITY_DESCRIPTION = "公共用電";

/**
 * Bill amount minus rate × total kWh.
 * Positive charges the owner. Negative is stored and shown as a credit on the owner report.
 */
export const BILL_GAP_DESCRIPTION = "電費（帳單差額）";

const SIGNED_OWNER_DESCRIPTIONS = new Set<string>([PUBLIC_ELECTRICITY_DESCRIPTION, BILL_GAP_DESCRIPTION]);

/**
 * One live owner expense per allocation run.
 * Vacant rooms keep their share of an even split (and their own submeter kWh).
 * That money is not moved onto the occupied tenants.
 */
export async function syncVacantOwnerExpense(
  client: Client,
  session: Session,
  input: {
    runId: string;
    propertyId: string;
    unitId: string;
    currency: string;
    incurredOn: string;
    amountMinor: number;
    description?: string;
  },
) {
  const description = input.description ?? VACANT_ELECTRICITY_DESCRIPTION;
  const amount = input.amountMinor;
  if (!Number.isSafeInteger(amount)) throw new FlowError("errors.amount");
  if (amount < 0 && !SIGNED_OWNER_DESCRIPTIONS.has(description)) throw new FlowError("errors.amount");
  const existing = await maybe<{
    id: string;
    amount_minor: string;
    incurred_on: string;
    ledger_transaction_id: string | null;
    status: string;
  }>(
    client,
    `SELECT id::text, amount_minor::text, incurred_on::text, ledger_transaction_id::text, status::text
       FROM expenses
      WHERE org_id = $1 AND utility_run_id = $2 AND description = $3 AND status <> 'void'
      FOR UPDATE`,
    [session.orgId, input.runId, description],
  );
  if (amount === 0) {
    if (!existing) return { changed: false };
    await voidOwnerExpense(client, session.orgId, existing, "作廢空房電費");
    return { changed: true };
  }
  if (
    existing &&
    existing.status === "posted" &&
    Number(existing.amount_minor) === amount &&
    existing.incurred_on.slice(0, 10) === input.incurredOn
  ) {
    return { changed: false };
  }
  await client.query(`SELECT set_config('app.change_reason', $1, true)`, ["空房電費"]);
  const currency = input.currency.trim();
  if (existing) {
    if (existing.ledger_transaction_id) await reverseExpenseLedger(client, existing.ledger_transaction_id, "更正空房電費");
    await client.query(
      `UPDATE expenses
          SET amount_minor = $2,
              incurred_on = $3::date,
              description = $4,
              currency = $5,
              property_id = $6,
              unit_id = $7,
              ledger_transaction_id = NULL,
              status = 'posted',
              category = 'utility',
              bill_to = 'owner',
              paid_by = 'manager_firm'
        WHERE id = $1 AND org_id = $8 AND status <> 'void'`,
      [existing.id, amount, input.incurredOn, description, currency, input.propertyId, input.unitId, session.orgId],
    );
    await postExpenseLedger(client, session, {
      expenseId: existing.id,
      propertyId: input.propertyId,
      currency,
      incurred: input.incurredOn,
      amount,
      description,
    });
    return { changed: true };
  }
  const expense = await one<{ id: string }>(
    client,
    `INSERT INTO expenses (
       org_id, property_id, unit_id, category, description, currency, amount_minor,
       incurred_on, paid_by, bill_to, status, approved_by, approved_at, created_by, utility_run_id
     ) VALUES (
       $1,$2,$3,'utility',$4,$5,$6,$7::date,'manager_firm','owner','posted',$8,now(),$8,$9
     ) RETURNING id::text`,
    [
      session.orgId,
      input.propertyId,
      input.unitId,
      description,
      currency,
      amount,
      input.incurredOn,
      session.userId,
      input.runId,
    ],
  );
  await postExpenseLedger(client, session, {
    expenseId: expense.id,
    propertyId: input.propertyId,
    currency,
    incurred: input.incurredOn,
    amount,
    description,
  });
  return { changed: true };
}

async function reverseExpenseLedger(client: Client, ledgerId: string, reason: string) {
  const reversed = await maybe<{ id: string }>(
    client,
    `SELECT id::text FROM ledger_transactions WHERE reverses_transaction_id = $1 LIMIT 1`,
    [ledgerId],
  );
  if (!reversed) await client.query(`SELECT post_reversal($1::uuid, $2)`, [ledgerId, reason]);
}

async function voidOwnerExpense(
  client: Client,
  orgId: string,
  expense: { id: string; ledger_transaction_id: string | null },
  reason: string,
) {
  await client.query(`SELECT set_config('app.change_reason', $1, true)`, [reason]);
  if (expense.ledger_transaction_id) await reverseExpenseLedger(client, expense.ledger_transaction_id, reason);
  await client.query(`UPDATE expenses SET status = 'void' WHERE id = $1 AND org_id = $2 AND status <> 'void'`, [
    expense.id,
    orgId,
  ]);
}

/** Same shape as a staff expense: expense debit, owner payable credit. */
async function postExpenseLedger(
  client: Client,
  session: Session,
  row: { expenseId: string; propertyId: string; currency: string; incurred: string; amount: number; description: string },
) {
  const txn = await one<{ id: string }>(
    client,
    `INSERT INTO ledger_transactions (
       org_id, property_id, kind, currency, effective_date, description, source_table, source_id, created_by
     ) VALUES ($1,$2,'expense',$3,$4,$5,'expenses',$6,$7) RETURNING id::text`,
    [session.orgId, row.propertyId, row.currency, row.incurred, row.description, row.expenseId, session.userId],
  );
  await client.query(
    `INSERT INTO ledger_entries (org_id, transaction_id, account, amount_minor, currency, property_id, memo)
     VALUES ($1,$2,'expense',$3,$4,$5,$6), ($1,$2,'owner_payable',$7,$4,$5,$6)`,
    [session.orgId, txn.id, row.amount, row.currency, row.propertyId, row.description, -row.amount],
  );
  await client.query(`UPDATE expenses SET ledger_transaction_id = $2 WHERE id = $1 AND org_id = $3`, [
    row.expenseId,
    txn.id,
    session.orgId,
  ]);
}

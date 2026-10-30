import type { Client } from "pg";
import { maybe, many, one } from "./db";
import { FlowError } from "./errors";
import { firstInvoicePlan } from "./first-invoice-plan";
import { nextInvoiceNumber } from "./invoice-number";

export type FirstPeriodLeaseSource = { first_period_basis: unknown; rent_amount_minor: string; currency: string; start_date: string; end_date: string | null; rent_frequency: string; prorate_first_period: boolean };
export function validateFirstPeriodSource(lease: FirstPeriodLeaseSource, checkEnd: boolean) {
  if (lease.first_period_basis === null) return;
  if (!lease.first_period_basis || typeof lease.first_period_basis !== "object" || Array.isArray(lease.first_period_basis)) throw new FlowError("errors.staleLease");
  const basis = lease.first_period_basis as Record<string, unknown>;
  if (basis.monthlyRentMinor !== Number(lease.rent_amount_minor) || basis.currency !== lease.currency.trim() ||
      basis.startDate !== lease.start_date || basis.rentFrequency !== lease.rent_frequency ||
      basis.prorateFirstPeriod !== lease.prorate_first_period || (checkEnd && basis.endDate !== lease.end_date)) throw new FlowError("errors.staleLease");
  try { firstInvoicePlan({ rentMinor: 0, depositMinor: 0, utility: null, basis }); }
  catch { throw new FlowError("errors.staleLease"); }
}


export async function ensureThread(client: Client, leaseId: string) {
  const existing = await maybe<{ id: string }>(
    client,
    `SELECT id FROM message_threads WHERE lease_id = $1 AND kind = 'lease'`,
    [leaseId],
  );
  if (existing) return existing.id;
  const lease = await one<{ org_id: string; property_id: string }>(
    client,
    `SELECT org_id, property_id FROM leases WHERE id = $1`,
    [leaseId],
  );
  const thread = await one<{ id: string }>(
    client,
    `INSERT INTO message_threads (org_id, kind, lease_id, property_id) VALUES ($1,'lease',$2,$3) RETURNING id`,
    [lease.org_id, leaseId, lease.property_id],
  );
  const contacts = await many<{ id: string }>(client, `SELECT contact_id AS id FROM lease_parties WHERE lease_id = $1`, [leaseId]);
  for (const contact of contacts) {
    await client.query(
      `INSERT INTO thread_participants (org_id, thread_id, contact_id) VALUES ($1,$2,$3)`,
      [lease.org_id, thread.id, contact.id],
    );
  }
  const members = await many<{ id: string }>(
    client,
    `SELECT id FROM org_members WHERE org_id = $1 AND status = 'active' AND role IN ('admin','manager')`,
    [lease.org_id],
  );
  for (const member of members) {
    await client.query(
      `INSERT INTO thread_participants (org_id, thread_id, member_id) VALUES ($1,$2,$3)`,
      [lease.org_id, thread.id, member.id],
    );
  }
  return thread.id;
}

export async function issueMoveInInvoice(client: Client, leaseId: string, actualActor?: string) {
  const existing = await maybe<{ id: string }>(
    client,
    `SELECT id FROM invoices WHERE lease_id = $1 AND source = 'move_in' AND status <> 'void' LIMIT 1`,
    [leaseId],
  );
  if (existing) return existing.id;
  const lease = await one<{
    property_id: string;
    org_id: string;
    currency: string;
    rent_amount_minor: string;
    deposit_amount_minor: string;
    start_date: string;
    end_date: string;
    rent_frequency: string;
    prorate_first_period: boolean;
    first_period_basis: unknown;
  }>(
    client,
    `SELECT property_id::text, org_id::text, currency, rent_amount_minor::text, deposit_amount_minor::text, start_date::text, end_date::text,
            rent_frequency::text, prorate_first_period, first_period_basis
       FROM leases WHERE id = $1`,
    [leaseId],
  );
  const party = await one<{ contact_id: string }>(
    client,
    `SELECT contact_id FROM lease_parties WHERE lease_id = $1 AND role = 'primary' LIMIT 1`,
    [leaseId],
  );
  // A confirmed electricity split already has its own invoice line. Attaching that
  // allocation again violates invoice_lines_alloc_uniq and rolls the countersign back.
  const allocation = await maybe<{ id: string; amount_minor: string }>(
    client,
    `SELECT l.id, l.amount_minor::text
       FROM utility_allocation_lines l
      WHERE l.lease_id = $1 AND l.amount_minor > 0
        AND l.posted_invoice_line_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM invoice_lines il WHERE il.allocation_line_id = l.id
        )
      ORDER BY l.amount_minor DESC
      LIMIT 1`,
    [leaseId],
  );
  const approver = await maybe<{ user_id: string }>(
    client,
    `SELECT m.user_id FROM lease_signatures s JOIN org_members m ON m.id = s.member_id
      WHERE s.lease_id = $1 AND s.signer_role = 'manager' LIMIT 1`,
    [leaseId],
  );
  const actor =
    actualActor ?? approver?.user_id ??
    (await one<{ id: string }>(client, `SELECT auth.uid() AS id`)).id;
  validateFirstPeriodSource(lease, false);
  const plan = firstInvoicePlan({ rentMinor: Number(lease.rent_amount_minor), depositMinor: Number(lease.deposit_amount_minor),
    utility: allocation ? { id: allocation.id, amountMinor: Number(allocation.amount_minor) } : null,
    basis: lease.first_period_basis });
  const number = await nextInvoiceNumber(client, lease.org_id);
  const invoice = await one<{ id: string }>(
    client,
    `INSERT INTO invoices (
       org_id, property_id, lease_id, bill_to_contact_id, invoice_number, currency, issue_date, due_date,
       period_start, period_end, status, source, created_by, einvoice_status
     ) VALUES ($1,$2,$3,$4,$5,$6,current_date, current_date + 7, $7, $8, 'open', 'move_in', $9, 'not_applicable')
     RETURNING id`,
    [lease.org_id, lease.property_id, leaseId, party.contact_id, number, lease.currency,
      plan.calculation?.periodStart ?? lease.start_date, plan.calculation?.periodEnd ?? lease.end_date, actor],
  );
  const lines = plan.lines;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    await client.query(
      `INSERT INTO invoice_lines (org_id, invoice_id, line_no, charge_type, description, quantity, unit_amount_minor, amount_minor, allocation_line_id, service_period)
       VALUES ($1,$2,$3,$4::charge_type,$5,1,$6,$7,$8,CASE WHEN $9::date IS NULL THEN NULL ELSE daterange($9::date,$10::date,'[]') END)`,
      [lease.org_id, invoice.id, index + 1, line.type, line.type, line.amount, line.amount, line.allocationId,
        line.type === "rent" ? plan.calculation?.periodStart ?? null : null,
        line.type === "rent" ? plan.calculation?.periodEnd ?? null : null],
    );
  }
  const total = plan.totalMinor;
  // A zero first invoice remains an explicit source record; it has no posting.
  if (total === 0) return invoice.id;
  const txn = await one<{ id: string }>(
    client,
    `INSERT INTO ledger_transactions (org_id, property_id, lease_id, kind, currency, effective_date, description, source_table, source_id, created_by)
     VALUES ($1,$2,$3,'invoice',$4,current_date,$5,'invoices',$6,$7) RETURNING id`,
    [lease.org_id, lease.property_id, leaseId, lease.currency, number, invoice.id, actor],
  );
  await client.query(
    `INSERT INTO ledger_entries (org_id, transaction_id, account, amount_minor, currency, contact_id, property_id, lease_id, invoice_id, memo)
     VALUES ($1,$2,'tenant_receivable',$3,$4,$5,$6,$7,$8,'invoice')`,
    [lease.org_id, txn.id, total, lease.currency, party.contact_id, lease.property_id, leaseId, invoice.id],
  );
  for (const line of lines) {
    if (line.amount === 0) continue;
    const account = line.type === "rent" ? "rental_income" : line.type === "deposit" ? "deposits_held" : "other_income";
    await client.query(
      `INSERT INTO ledger_entries (org_id, transaction_id, account, amount_minor, currency, contact_id, property_id, lease_id, invoice_id, memo)
       VALUES ($1,$2,$3::ledger_account,$4,$5,$6,$7,$8,$9,$10)`,
      [lease.org_id, txn.id, account, -line.amount, lease.currency, party.contact_id, lease.property_id, leaseId, invoice.id, line.type],
    );
  }
  await client.query(`UPDATE invoices SET ledger_transaction_id = $2 WHERE id = $1`, [invoice.id, txn.id]);
  if (allocation) {
    await client.query(
      `UPDATE utility_allocation_runs
          SET status = 'posted', approved_by = $2, approved_at = now()
        WHERE id = (SELECT run_id FROM utility_allocation_lines WHERE id = $1)`,
      [allocation.id, actor],
    );
  }
  return invoice.id;
}


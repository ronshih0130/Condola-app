import type { Client } from "pg";
import { makeT, type Locale } from "@/i18n";
import { writePdfDownload } from "./audit";
import { maybe, many, tx } from "./db";
import { FlowError } from "./errors";
import { STATEMENT_EXPENSE_SQL } from "./expenses";
import { buildStatementPdf, type StatementPdfSource } from "./pdf-docs";
import { assertPerm, can } from "./perms";
import type { CalendarMode, Session } from "./types";
import {
  attributeMinor,
  closingBalance,
  defaultPaidOn,
  isSettlementMethod,
  monthWindow,
  parseAmountToMinor,
  parseCivilDate,
  parseMonth,
  projectMonth,
  rentSettlementEnabled,
  type ChargeMinor,
  type FeeRuleExact,
  type MonthSettlement,
} from "./rent-settlement-math";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NO_FEE: FeeRuleExact = { kind: "none", hybridMode: null, percentBp: BigInt(0), fixedMinor: BigInt(0), minimumMinor: BigInt(0) };

const PRIMARY_OWNER = `
  po.org_id = $1
  AND po.is_primary
  AND po.effective_from <= $3::date
  AND (po.effective_to IS NULL OR po.effective_to >= $2::date)
  AND po.id = (
    SELECT po2.id
      FROM property_owners po2
     WHERE po2.org_id = po.org_id
       AND po2.property_id = po.property_id
       AND po2.is_primary
       AND po2.effective_from <= $3::date
       AND (po2.effective_to IS NULL OR po2.effective_to >= $2::date)
     ORDER BY po2.effective_from DESC, po2.id
     LIMIT 1
  )`;

export type OpenBill = {
  id: string;
  number: string;
  currency: string;
  balanceMinor: bigint;
  paidMinor: bigint;
  dueOn: string;
  tenant: string;
  property: string;
  owner: string;
};

export type RecordedPayment = {
  id: string;
  currency: string;
  amountMinor: bigint;
  paidOn: string;
  method: string;
  status: string;
  tenant: string;
  invoiceNumber: string;
};

export type OwnerSettlementRow = MonthSettlement & {
  ownerId: string;
  ownerName: string;
  currency: string;
  month: string;
  openingMinor: bigint;
  firmMinor: bigint;
  payoutMinor: bigint;
};

/** Settlement PDF: closing is opening + firm-handled rent − fee − expenses − payouts. */
export function settlementPdfSource(input: {
  ownerId: string;
  orgId: string;
  ownerName: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  openingMinor: number;
  rentMinor: number;
  otherMinor: number;
  feeMinor: number;
  expenseMinor: number;
  firmMinor: number;
  payoutMinor: number;
}): StatementPdfSource {
  const closing = Number(
    closingBalance(
      BigInt(input.openingMinor),
      BigInt(input.firmMinor),
      BigInt(input.feeMinor + input.expenseMinor),
      BigInt(input.payoutMinor),
    ),
  );
  return {
    id: input.ownerId,
    orgId: input.orgId,
    ownerName: input.ownerName,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    currency: input.currency,
    opening: input.openingMinor,
    rent: input.rentMinor,
    other: input.otherMinor,
    fee: input.feeMinor,
    expenses: input.expenseMinor,
    payouts: input.payoutMinor,
    closing,
    firm: input.firmMinor,
    lines: [],
    addresses: [],
    audience: "staff",
  };
}

export type SettlementPage = {
  month: string;
  paidOn: string;
  bills: OpenBill[];
  payments: RecordedPayment[];
  owners: OwnerSettlementRow[];
};

type GateRow = { plan_tier: string; environment: string; feature_flags: unknown };

function scope(session: Session) {
  return { orgId: session.orgId, environment: session.environment };
}

async function gateOpen(client: Client, orgId: string) {
  const row = await maybe<GateRow>(
    client,
    `SELECT plan_tier::text, environment::text, feature_flags FROM organizations WHERE id = $1`,
    [orgId],
  );
  if (!row) return false;
  return rentSettlementEnabled({
    environment: row.environment,
    planTier: row.plan_tier,
    featureFlags: row.feature_flags,
  });
}

async function noteChange(client: Client, reason: string) {
  const trimmed = reason.trim().slice(0, 500);
  if (!trimmed) throw new FlowError("errors.required");
  await client.query(`SELECT set_config('app.change_reason', $1, true)`, [trimmed]);
}

function asLines(value: unknown): ChargeMinor[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) return [];
  return parsed.map((line) => {
    const row = line as { charge_type?: string; amount_minor?: string | number; description?: string };
    return {
      charge_type: String(row.charge_type ?? ""),
      amount_minor: BigInt(String(row.amount_minor ?? "0")),
      description: String(row.description ?? ""),
    };
  });
}

async function postPaymentLedger(
  client: Client,
  payment: {
    id: string;
    orgId: string;
    propertyId: string;
    leaseId: string;
    currency: string;
    amountMinor: bigint;
    paidOn: string;
    payerId: string | null;
    userId: string;
  },
) {
  const txn = await maybe<{ id: string }>(
    client,
    `INSERT INTO ledger_transactions (
       org_id, property_id, lease_id, kind, currency, effective_date, description, source_table, source_id, created_by
     ) VALUES ($1,$2,$3,'payment',$4,$5::date,'payment','payments',$6,$7)
     RETURNING id::text`,
    [payment.orgId, payment.propertyId, payment.leaseId, payment.currency, payment.paidOn, payment.id, payment.userId],
  );
  if (!txn) throw new FlowError("errors.ledger");
  await client.query(
    `INSERT INTO ledger_entries (org_id, transaction_id, account, amount_minor, currency, contact_id, property_id, lease_id, memo)
     VALUES ($1,$2,'cash_clearing',$3,$4,$5,$6,$7,'payment'),
            ($1,$2,'tenant_receivable',$8,$4,$5,$6,$7,'payment')`,
    [
      payment.orgId,
      txn.id,
      payment.amountMinor.toString(),
      payment.currency,
      payment.payerId,
      payment.propertyId,
      payment.leaseId,
      (-payment.amountMinor).toString(),
    ],
  );
  await client.query(`UPDATE payments SET ledger_transaction_id = $2 WHERE id = $1 AND org_id = $3`, [
    payment.id,
    txn.id,
    payment.orgId,
  ]);
}

async function insertCorrection(
  client: Client,
  row: {
    orgId: string;
    paymentId: string;
    replacesPaymentId: string | null;
    kind: "record" | "correct" | "reverse";
    reason: string;
    beforeAmount: bigint | null;
    afterAmount: bigint | null;
    beforePaidOn: string | null;
    afterPaidOn: string | null;
    beforeMethod: string | null;
    afterMethod: string | null;
    userId: string;
  },
) {
  await client.query(
    `INSERT INTO payment_corrections (
       org_id, payment_id, replaces_payment_id, kind, reason,
       before_amount_minor, after_amount_minor, before_paid_on, after_paid_on,
       before_method, after_method, created_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      row.orgId,
      row.paymentId,
      row.replacesPaymentId,
      row.kind,
      row.reason.trim().slice(0, 500),
      row.beforeAmount?.toString() ?? null,
      row.afterAmount?.toString() ?? null,
      row.beforePaidOn,
      row.afterPaidOn,
      row.beforeMethod,
      row.afterMethod,
      row.userId,
    ],
  );
}

type InvoiceRow = {
  id: string;
  property_id: string;
  lease_id: string;
  bill_to: string | null;
  currency: string;
  balance_minor: string;
  status: string;
};

async function lockInvoice(client: Client, orgId: string, invoiceId: string) {
  return maybe<InvoiceRow>(
    client,
    `SELECT id::text, property_id::text, lease_id::text, bill_to_contact_id::text AS bill_to,
            currency, balance_minor::text, status::text
       FROM invoices
      WHERE id = $1 AND org_id = $2
      FOR UPDATE`,
    [invoiceId, orgId],
  );
}

async function payerFor(client: Client, orgId: string, invoice: InvoiceRow) {
  if (invoice.bill_to) return invoice.bill_to;
  const party = await maybe<{ id: string }>(
    client,
    `SELECT contact_id::text AS id FROM lease_parties
      WHERE lease_id = $1 AND org_id = $2 AND role = 'primary'
      LIMIT 1`,
    [invoice.lease_id, orgId],
  );
  return party?.id ?? null;
}

export async function loadRentSettlement(session: Session, monthInput: string | undefined, today: string): Promise<SettlementPage | null> {
  if (session.kind !== "staff") return null;
  const month = parseMonth(monthInput, today);
  const bounds = monthWindow(month);
  return tx(session.userId, async (client) => {
    if (!(await gateOpen(client, session.orgId))) return null;
    const bills = await many<{
      id: string;
      invoice_number: string;
      currency: string;
      balance_minor: string;
      paid_minor: string;
      due_date: string;
      tenant: string;
      property: string;
      owner: string;
    }>(
      client,
      `SELECT DISTINCT ON (i.id)
              i.id::text, i.invoice_number, i.currency, i.balance_minor::text, i.paid_minor::text, i.due_date::text,
              coalesce(c.display_name, '') AS tenant, p.name AS property, coalesce(oc.display_name, '') AS owner
         FROM invoices i
         JOIN properties p ON p.id = i.property_id AND p.org_id = i.org_id
         LEFT JOIN contacts c ON c.id = i.bill_to_contact_id AND c.org_id = i.org_id
         LEFT JOIN property_owners po ON po.property_id = i.property_id AND po.org_id = i.org_id AND po.is_primary
         LEFT JOIN contacts oc ON oc.id = po.owner_contact_id AND oc.org_id = i.org_id
        WHERE i.org_id = $1
          AND i.status IN ('open', 'partially_paid')
          AND i.balance_minor > 0
        ORDER BY i.id, i.due_date, i.invoice_number`,
      [session.orgId],
    );
    const payments = await many<{
      id: string;
      currency: string;
      amount_minor: string;
      paid_on: string;
      method: string;
      status: string;
      tenant: string;
      invoice_number: string;
    }>(
      client,
      `SELECT DISTINCT ON (pay.id)
              pay.id::text, pay.currency, pay.amount_minor::text, pay.paid_on::text, pay.method::text, pay.status::text,
              coalesce(c.display_name, '') AS tenant, coalesce(i.invoice_number, '') AS invoice_number
         FROM payments pay
         LEFT JOIN contacts c ON c.id = pay.payer_contact_id AND c.org_id = pay.org_id
         LEFT JOIN payment_allocations a ON a.payment_id = pay.id AND a.org_id = pay.org_id
         LEFT JOIN invoices i ON i.id = a.invoice_id AND i.org_id = pay.org_id
        WHERE pay.org_id = $1
          AND pay.paid_on BETWEEN $2::date AND $3::date
          AND pay.status IN ('confirmed', 'reversed')
          AND (
            EXISTS (SELECT 1 FROM payment_corrections pc WHERE pc.org_id = pay.org_id AND pc.payment_id = pay.id)
            OR EXISTS (
              SELECT 1 FROM payment_corrections pc
               WHERE pc.org_id = pay.org_id AND pc.replaces_payment_id = pay.id
            )
          )
        ORDER BY pay.id`,
      [session.orgId, bounds.start, bounds.end],
    );
    const owners = await ownerRows(client, session.orgId, month, bounds);
    return {
      month,
      paidOn: defaultPaidOn(month, today),
      bills: bills
        .map((row) => ({
          id: row.id,
          number: row.invoice_number,
          currency: row.currency.trim(),
          balanceMinor: BigInt(row.balance_minor),
          paidMinor: BigInt(row.paid_minor),
          dueOn: row.due_date.slice(0, 10),
          tenant: row.tenant,
          property: row.property,
          owner: row.owner,
        }))
        .sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.number.localeCompare(b.number)),
      payments: payments
        .map((row) => ({
          id: row.id,
          currency: row.currency.trim(),
          amountMinor: BigInt(row.amount_minor),
          paidOn: row.paid_on.slice(0, 10),
          method: row.method,
          status: row.status,
          tenant: row.tenant,
          invoiceNumber: row.invoice_number,
        }))
        .sort((a, b) => a.paidOn.localeCompare(b.paidOn) || a.invoiceNumber.localeCompare(b.invoiceNumber)),
      owners,
    };
  }, scope(session));
}

async function ownerRows(
  client: Client,
  orgId: string,
  month: string,
  bounds: { start: string; end: string },
): Promise<OwnerSettlementRow[]> {
  const owners = await many<{ owner_id: string; owner_name: string; currency: string }>(
    client,
    `SELECT DISTINCT po.owner_contact_id::text AS owner_id, oc.display_name AS owner_name, btrim(p.currency) AS currency
       FROM property_owners po
       JOIN contacts oc ON oc.id = po.owner_contact_id AND oc.org_id = po.org_id
       JOIN properties p ON p.id = po.property_id AND p.org_id = po.org_id
      WHERE ${PRIMARY_OWNER}
      ORDER BY owner_name, currency`,
    [orgId, bounds.start, bounds.end],
  );
  const allocations = await many<{
    owner_id: string;
    currency: string;
    paid_minor: string;
    paid_on: string;
    status: string;
    payee: string | null;
    lines: unknown;
  }>(
    client,
    `SELECT po.owner_contact_id::text AS owner_id, btrim(pay.currency) AS currency,
            a.amount_minor::text AS paid_minor, pay.paid_on::text, pay.status::text, pay.payee,
            coalesce((
              SELECT jsonb_agg(jsonb_build_object(
                       'charge_type', il.charge_type::text,
                       'amount_minor', il.amount_minor::text,
                       'description', il.description
                     ) ORDER BY il.line_no)
                FROM invoice_lines il
               WHERE il.invoice_id = a.invoice_id AND il.org_id = pay.org_id
            ), '[]'::jsonb) AS lines
       FROM payments pay
       JOIN leases l ON l.id = pay.lease_id AND l.org_id = pay.org_id
       JOIN property_owners po ON po.property_id = l.property_id
       JOIN payment_allocations a ON a.payment_id = pay.id AND a.org_id = pay.org_id
      WHERE pay.org_id = $1
        AND pay.status = 'confirmed'
        AND pay.paid_on BETWEEN $2::date AND $3::date
        AND ${PRIMARY_OWNER}`,
    [orgId, bounds.start, bounds.end],
  );
  const expenses = await many<{ owner_id: string; currency: string; amount_minor: string }>(
    client,
    `SELECT po.owner_contact_id::text AS owner_id, btrim(e.currency) AS currency,
            coalesce(sum(e.amount_minor), 0)::text AS amount_minor
       FROM expenses e
       JOIN property_owners po ON po.property_id = e.property_id
      WHERE e.org_id = $1
        AND e.incurred_on BETWEEN $2::date AND $3::date
        AND ${STATEMENT_EXPENSE_SQL}
        AND ${PRIMARY_OWNER}
      GROUP BY po.owner_contact_id, btrim(e.currency)`,
    [orgId, bounds.start, bounds.end],
  );
  const rules = await many<{
    owner_id: string;
    currency: string;
    kind: string;
    hybrid_mode: string | null;
    percent_bp: number | null;
    fixed_amount_minor: string | null;
    minimum_minor: string | null;
  }>(
    client,
    `SELECT ma.owner_contact_id::text AS owner_id, btrim(fr.currency) AS currency, fr.kind::text,
            fr.hybrid_mode::text, fr.percent_bp, fr.fixed_amount_minor::text, fr.minimum_minor::text
       FROM management_agreements ma
       JOIN fee_rules fr ON fr.id = ma.fee_rule_id AND fr.org_id = ma.org_id
      WHERE ma.org_id = $1
        AND ma.effective_from <= $2::date
        AND (ma.effective_to IS NULL OR ma.effective_to > $2::date)
      ORDER BY ma.owner_contact_id, btrim(fr.currency), ma.property_id NULLS LAST, ma.effective_from DESC`,
    [orgId, bounds.end],
  );
  const ruleByKey = new Map<string, FeeRuleExact>();
  for (const rule of rules) {
    const key = `${rule.owner_id}:${rule.currency}`;
    if (ruleByKey.has(key)) continue;
    ruleByKey.set(key, {
      kind: rule.kind,
      hybridMode: rule.hybrid_mode,
      percentBp: BigInt(rule.percent_bp ?? 0),
      fixedMinor: BigInt(rule.fixed_amount_minor ?? 0),
      minimumMinor: BigInt(rule.minimum_minor ?? 0),
    });
  }
  const grouped = new Map<string, { rent: bigint; utility: bigint; other: bigint; firm: bigint }>();
  for (const row of allocations) {
    const key = `${row.owner_id}:${row.currency}`;
    const bucket = grouped.get(key) ?? { rent: BigInt(0), utility: BigInt(0), other: BigInt(0), firm: BigInt(0) };
    const split = attributeMinor(asLines(row.lines), BigInt(row.paid_minor));
    bucket.rent += split.rent;
    bucket.utility += split.utility;
    bucket.other += split.other;
    if (row.payee === "firm") bucket.firm += split.rent;
    grouped.set(key, bucket);
  }
  const expenseByKey = new Map(expenses.map((row) => [`${row.owner_id}:${row.currency}`, BigInt(row.amount_minor)]));
  const openings = await many<{ owner_id: string; currency: string; opening: string }>(
    client,
    `SELECT DISTINCT ON (s.owner_contact_id, btrim(s.currency))
            s.owner_contact_id::text AS owner_id, btrim(s.currency) AS currency,
            s.closing_balance_minor::text AS opening
       FROM owner_statements s
      WHERE s.org_id = $1 AND s.status = 'issued' AND s.period_end < $2::date
      ORDER BY s.owner_contact_id, btrim(s.currency), s.period_end DESC`,
    [orgId, bounds.start],
  );
  const payouts = await many<{ owner_id: string; currency: string; amount_minor: string }>(
    client,
    `SELECT owner_contact_id::text AS owner_id, btrim(currency) AS currency,
            coalesce(sum(amount_minor), 0)::text AS amount_minor
       FROM owner_payouts
      WHERE org_id = $1 AND period_start = $2::date
      GROUP BY owner_contact_id, btrim(currency)`,
    [orgId, bounds.start],
  );
  const openingByKey = new Map(openings.map((row) => [`${row.owner_id}:${row.currency}`, BigInt(row.opening)]));
  const payoutByKey = new Map(payouts.map((row) => [`${row.owner_id}:${row.currency}`, BigInt(row.amount_minor)]));
  return owners.map((owner) => {
    const key = `${owner.owner_id}:${owner.currency}`;
    const bucket = grouped.get(key) ?? { rent: BigInt(0), utility: BigInt(0), other: BigInt(0), firm: BigInt(0) };
    const figures = projectMonth(
      [
        {
          status: "confirmed",
          paidOn: bounds.start,
          rentMinor: bucket.rent,
          utilityMinor: bucket.utility,
          otherMinor: bucket.other,
          depositMinor: BigInt(0),
        },
      ],
      month,
      ruleByKey.get(key) ?? NO_FEE,
      expenseByKey.get(key) ?? BigInt(0),
    );
    return {
      ownerId: owner.owner_id,
      ownerName: owner.owner_name,
      currency: owner.currency,
      month,
      ...figures,
      openingMinor: openingByKey.get(key) ?? BigInt(0),
      firmMinor: bucket.firm,
      payoutMinor: payoutByKey.get(key) ?? BigInt(0),
    };
  });
}

export async function recordBillPayment(
  session: Session,
  input: { invoiceId: string; amount: string; paidOn: string; method: string; reason: string },
) {
  assertPerm(session, "pay.record");
  if (!UUID.test(input.invoiceId)) throw new FlowError("errors.notFound");
  const paidOn = parseCivilDate(input.paidOn);
  if (!paidOn) throw new FlowError("errors.date");
  if (!isSettlementMethod(input.method)) throw new FlowError("errors.required");
  return tx(session.userId, async (client) => {
    if (!(await gateOpen(client, session.orgId))) throw new FlowError("errors.forbidden");
    const invoice = await lockInvoice(client, session.orgId, input.invoiceId);
    if (!invoice || (invoice.status !== "open" && invoice.status !== "partially_paid")) throw new FlowError("errors.notFound");
    const amount = parseAmountToMinor(input.amount, invoice.currency);
    if (amount == null) throw new FlowError("errors.amount");
    if (amount > BigInt(invoice.balance_minor)) throw new FlowError("errors.amountTooHigh");
    await noteChange(client, input.reason);
    const payerId = await payerFor(client, session.orgId, invoice);
    const payment = await maybe<{ id: string }>(
      client,
      `INSERT INTO payments (
         org_id, property_id, lease_id, payer_contact_id, currency, amount_minor, paid_on, method,
         status, source, submitted_by, confirmed_by, confirmed_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7::date,$8::payment_method,'confirmed','manager_entry',$9,$9,now()
       ) RETURNING id::text`,
      [
        session.orgId,
        invoice.property_id,
        invoice.lease_id,
        payerId,
        invoice.currency,
        amount.toString(),
        paidOn,
        input.method,
        session.userId,
      ],
    );
    if (!payment) throw new FlowError("errors.generic");
    await client.query(
      `INSERT INTO payment_allocations (org_id, payment_id, invoice_id, amount_minor, created_by)
       VALUES ($1,$2,$3,$4,$5)`,
      [session.orgId, payment.id, invoice.id, amount.toString(), session.userId],
    );
    await postPaymentLedger(client, {
      id: payment.id,
      orgId: session.orgId,
      propertyId: invoice.property_id,
      leaseId: invoice.lease_id,
      currency: invoice.currency,
      amountMinor: amount,
      paidOn,
      payerId,
      userId: session.userId,
    });
    await insertCorrection(client, {
      orgId: session.orgId,
      paymentId: payment.id,
      replacesPaymentId: null,
      kind: "record",
      reason: input.reason,
      beforeAmount: null,
      afterAmount: amount,
      beforePaidOn: null,
      afterPaidOn: paidOn,
      beforeMethod: null,
      afterMethod: input.method,
      userId: session.userId,
    });
    return { paymentId: payment.id };
  }, scope(session));
}

export async function correctBillPayment(
  session: Session,
  input: { paymentId: string; amount: string; paidOn: string; method: string; reason: string },
) {
  assertPerm(session, "pay.record");
  if (!UUID.test(input.paymentId)) throw new FlowError("errors.notFound");
  const paidOn = parseCivilDate(input.paidOn);
  if (!paidOn) throw new FlowError("errors.date");
  if (!isSettlementMethod(input.method)) throw new FlowError("errors.required");
  const reason = input.reason.trim();
  if (!reason) throw new FlowError("errors.required");
  return tx(session.userId, async (client) => {
    if (!(await gateOpen(client, session.orgId))) throw new FlowError("errors.forbidden");
    const payment = await maybe<{
      id: string;
      status: string;
      ledger_transaction_id: string | null;
      amount_minor: string;
      paid_on: string;
      method: string;
      currency: string;
      property_id: string;
      lease_id: string;
      payer_contact_id: string | null;
    }>(
      client,
      `SELECT id::text, status::text, ledger_transaction_id::text, amount_minor::text, paid_on::text, method::text,
              currency, property_id::text, lease_id::text, payer_contact_id::text
         FROM payments
        WHERE id = $1 AND org_id = $2
        FOR UPDATE`,
      [input.paymentId, session.orgId],
    );
    if (!payment || payment.status !== "confirmed" || !payment.ledger_transaction_id) throw new FlowError("errors.paymentState");
    const allocations = await many<{ invoice_id: string; amount_minor: string }>(
      client,
      `SELECT invoice_id::text, amount_minor::text FROM payment_allocations WHERE payment_id = $1 AND org_id = $2`,
      [payment.id, session.orgId],
    );
    if (allocations.length !== 1) throw new FlowError("errors.paymentState");
    const invoice = await lockInvoice(client, session.orgId, allocations[0].invoice_id);
    if (!invoice) throw new FlowError("errors.notFound");
    const amount = parseAmountToMinor(input.amount, payment.currency);
    if (amount == null) throw new FlowError("errors.amount");
    const same =
      amount === BigInt(payment.amount_minor) && paidOn === payment.paid_on.slice(0, 10) && input.method === payment.method;
    if (same) throw new FlowError("errors.paymentState");
    await noteChange(client, reason);
    await client.query(`SELECT post_reversal($1::uuid, $2)`, [payment.ledger_transaction_id, reason]);
    const reversed = await client.query(
      `UPDATE payments SET status = 'reversed' WHERE id = $1 AND org_id = $2 AND status = 'confirmed'`,
      [payment.id, session.orgId],
    );
    if (reversed.rowCount !== 1) throw new FlowError("errors.paymentState");
    const refreshed = await lockInvoice(client, session.orgId, invoice.id);
    if (!refreshed || amount > BigInt(refreshed.balance_minor)) throw new FlowError("errors.amountTooHigh");
    const created = await maybe<{ id: string }>(
      client,
      `INSERT INTO payments (
         org_id, property_id, lease_id, payer_contact_id, currency, amount_minor, paid_on, method,
         status, source, submitted_by, confirmed_by, confirmed_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7::date,$8::payment_method,'confirmed','manager_entry',$9,$9,now()
       ) RETURNING id::text`,
      [
        session.orgId,
        payment.property_id,
        payment.lease_id,
        payment.payer_contact_id,
        payment.currency,
        amount.toString(),
        paidOn,
        input.method,
        session.userId,
      ],
    );
    if (!created) throw new FlowError("errors.generic");
    await client.query(
      `INSERT INTO payment_allocations (org_id, payment_id, invoice_id, amount_minor, created_by)
       VALUES ($1,$2,$3,$4,$5)`,
      [session.orgId, created.id, invoice.id, amount.toString(), session.userId],
    );
    await postPaymentLedger(client, {
      id: created.id,
      orgId: session.orgId,
      propertyId: payment.property_id,
      leaseId: payment.lease_id,
      currency: payment.currency,
      amountMinor: amount,
      paidOn,
      payerId: payment.payer_contact_id,
      userId: session.userId,
    });
    await insertCorrection(client, {
      orgId: session.orgId,
      paymentId: created.id,
      replacesPaymentId: payment.id,
      kind: "correct",
      reason,
      beforeAmount: BigInt(payment.amount_minor),
      afterAmount: amount,
      beforePaidOn: payment.paid_on.slice(0, 10),
      afterPaidOn: paidOn,
      beforeMethod: payment.method,
      afterMethod: input.method,
      userId: session.userId,
    });
    return { paymentId: created.id };
  }, scope(session));
}

export async function reverseBillPayment(session: Session, paymentId: string, reason: string) {
  assertPerm(session, "pay.reverse");
  if (!UUID.test(paymentId)) throw new FlowError("errors.notFound");
  const note = reason.trim();
  if (!note) throw new FlowError("errors.required");
  return tx(session.userId, async (client) => {
    if (!(await gateOpen(client, session.orgId))) throw new FlowError("errors.forbidden");
    const payment = await maybe<{
      id: string;
      status: string;
      ledger_transaction_id: string | null;
      amount_minor: string;
      paid_on: string;
      method: string;
    }>(
      client,
      `SELECT id::text, status::text, ledger_transaction_id::text, amount_minor::text, paid_on::text, method::text
         FROM payments
        WHERE id = $1 AND org_id = $2
        FOR UPDATE`,
      [paymentId, session.orgId],
    );
    if (!payment || payment.status !== "confirmed" || !payment.ledger_transaction_id) throw new FlowError("errors.paymentState");
    await noteChange(client, note);
    await client.query(`SELECT post_reversal($1::uuid, $2)`, [payment.ledger_transaction_id, note]);
    const reversed = await client.query(
      `UPDATE payments SET status = 'reversed' WHERE id = $1 AND org_id = $2 AND status = 'confirmed'`,
      [payment.id, session.orgId],
    );
    if (reversed.rowCount !== 1) throw new FlowError("errors.paymentState");
    await insertCorrection(client, {
      orgId: session.orgId,
      paymentId: payment.id,
      replacesPaymentId: null,
      kind: "reverse",
      reason: note,
      beforeAmount: BigInt(payment.amount_minor),
      afterAmount: null,
      beforePaidOn: payment.paid_on.slice(0, 10),
      afterPaidOn: null,
      beforeMethod: payment.method,
      afterMethod: null,
      userId: session.userId,
    });
  }, scope(session));
}

export async function settlementPdfForSession(
  session: Session,
  input: { ownerId: string; month: string; currency: string },
  today: string,
) {
  if (session.kind !== "staff" || !can(session.role, "stmt.view")) return null;
  if (!UUID.test(input.ownerId)) return null;
  const page = await loadRentSettlement(session, input.month, today);
  if (!page) return null;
  const currency = input.currency.trim().toUpperCase();
  const row = page.owners.find((owner) => owner.ownerId === input.ownerId && owner.currency === currency);
  if (!row) return null;
  const bounds = monthWindow(page.month);
  const t = makeT(session.locale);
  const stored = await tx(
    session.userId,
    async (client) =>
      maybe<{
        opening: string;
        rent: string;
        other: string;
        fee: string;
        expenses: string;
        payouts: string;
        firm: string;
      }>(
        client,
        `SELECT opening_balance_minor::text AS opening,
                rent_received_minor::text AS rent,
                other_income_minor::text AS other,
                management_fee_minor::text AS fee,
                expenses_minor::text AS expenses,
                payouts_minor::text AS payouts,
                coalesce(firm_handled_minor, 0)::text AS firm
           FROM owner_statements
          WHERE org_id = $1
            AND owner_contact_id = $2
            AND btrim(currency) = $3
            AND period_start = $4::date
            AND status <> 'void'
          LIMIT 1`,
        [session.orgId, row.ownerId, row.currency, bounds.start],
      ),
    scope(session),
  );
  const doc = buildStatementPdf(
    settlementPdfSource({
      ownerId: row.ownerId,
      orgId: session.orgId,
      ownerName: row.ownerName,
      periodStart: bounds.start,
      periodEnd: bounds.end,
      currency: row.currency,
      openingMinor: Number(stored?.opening ?? row.openingMinor),
      rentMinor: Number(stored?.rent ?? row.rentMinor),
      otherMinor: Number(stored?.other ?? row.otherMinor),
      feeMinor: Number(stored?.fee ?? row.feeMinor),
      expenseMinor: Number(stored?.expenses ?? row.expenseMinor),
      firmMinor: Number(stored?.firm ?? row.firmMinor),
      payoutMinor: Number(stored?.payouts ?? row.payoutMinor),
    }),
    session.locale as Locale,
    session.calendar as CalendarMode,
    t,
  );
  await writePdfDownload(session.orgId, session.userId, session.role ?? "staff", "owner_statements", row.ownerId, {
    document: "owner_settlement",
    month: page.month,
    currency: row.currency,
  });
  return doc;
}

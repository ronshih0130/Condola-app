import { createHash, randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { tx, svcOn } from './db';
import { billingPreviewsEnabled, monthlyRentPostingEnabled } from './billing-preview-rules';
import { monthlyBounds, type LeaseSource, type RentSource } from './monthly-billing-rules';
import { planMonthlyRentOperation, type MonthlyRentParty } from './monthly-rent-operation-plan';
import { nextInvoiceNumber } from './invoice-number';
import { isUuid } from './repair-rules';
import type { IssuanceResult } from './monthly-bill-types';
import type { Session } from './types';

const VERSION = 'monthly-rent-operation-v1';
const CAP = 2000;
type Input = { leaseId: string; month: string; requestId: string; expectedDigest: string };
type Receipt = { id: string; invoice_id: string; plan_digest: string; amount_minor: string };

async function leaseVisible(client: Client, orgId: string, leaseId: string): Promise<boolean> {
  return (await client.query(`SELECT 1 FROM leases WHERE org_id=$1 AND id=$2`, [orgId, leaseId])).rows.length > 0;
}

// svcOn owns a transaction normally. Map its boundaries to a savepoint here so
// privileged receipt access cannot commit the surrounding authenticated work.
async function receipts<T>(client: Client, session: Session, fn: (c: Client) => Promise<T>): Promise<T> {
  const scoped = Object.create(client) as Client;
  scoped.query = (async (sql: string, params?: unknown[]) => {
    const statement = sql === 'BEGIN' ? 'SAVEPOINT monthly_receipts'
      : sql === 'COMMIT' ? 'RELEASE SAVEPOINT monthly_receipts'
      : sql === 'ROLLBACK' ? 'ROLLBACK TO SAVEPOINT monthly_receipts' : sql;
    return client.query(statement, params);
  }) as Client['query'];
  try {
    return await svcOn(scoped, session.userId, fn);
  } finally {
    await client.query(`SET LOCAL ROLE authenticated`);
    await client.query(`SELECT set_config('request.jwt.claim.role','authenticated',true)`);
  }
}

function result(row: Receipt, status: 'created' | 'already_issued', requestId?: string): IssuanceResult {
  return { status, occurrenceId: row.id, invoiceId: row.invoice_id,
    planDigest: row.plan_digest, amountMinor: row.amount_minor, ...(requestId ? { requestId } : {}) };
}

async function occurrence(client: Client, orgId: string, leaseId: string, start: string) {
  return (await client.query<Receipt>(`SELECT id::text,original_invoice_id::text AS invoice_id,
    plan_digest,amount_minor::text FROM app.b008_monthly_rent_occurrences
    WHERE org_id=$1 AND lease_id=$2 AND month_start=$3::date AND kind='rent'
    ORDER BY created_at DESC,id DESC LIMIT 1`, [orgId, leaseId, start])).rows[0];
}

export async function readMonthlyRentHistory(
  session: Session, input: { leaseId: string; month: string },
): Promise<IssuanceResult | null> {
  let period: ReturnType<typeof monthlyBounds>;
  try { period = monthlyBounds(input.month); } catch (error) {
    if (error instanceof TypeError) return { status: 'rejected_invalid' };
    throw error;
  }
  if (session.kind !== 'staff' || !['admin', 'accountant'].includes(session.role ?? ''))
    return { status: 'rejected_disabled' };
  if (!isUuid(input.leaseId)) return { status: 'rejected_invalid' };
  return tx(session.userId, async client => {
    if (!(await billingPreviewsEnabled(client, session.orgId))) return { status: 'rejected_disabled' };
    if (!(await leaseVisible(client, session.orgId, input.leaseId))) return null;
    return receipts(client, session, async service => {
      const row = await occurrence(service, session.orgId, input.leaseId, period.start);
      return row ? result(row, 'already_issued') : null;
    });
  }, { orgId: session.orgId, environment: session.environment });
}

export async function writeMonthlyRent(session: Session, input: Input): Promise<IssuanceResult> {
  let period: ReturnType<typeof monthlyBounds>;
  try { period = monthlyBounds(input.month); } catch (error) {
    if (error instanceof TypeError) return { status: 'rejected_invalid' };
    throw error;
  }
  if (session.kind !== 'staff' || !['admin', 'accountant'].includes(session.role ?? ''))
    return { status: 'rejected_disabled' };
  if (!isUuid(input.leaseId) || !isUuid(input.requestId) || !/^[0-9a-f]{64}$/.test(input.expectedDigest))
    return { status: 'rejected_invalid' };
  const { leaseId, month, requestId, expectedDigest } = input;
  const intent = createHash('sha256').update(JSON.stringify({
    version: VERSION, orgId: session.orgId, environment: session.environment,
    leaseId, month, expectedDigest,
  })).digest('hex');
  return tx(session.userId, async client => {
    if (!(await billingPreviewsEnabled(client, session.orgId)) ||
        !(await monthlyRentPostingEnabled(client, session.orgId))) return { status: 'rejected_disabled' };
    // Serialize both request reuse across leases and issuance for this lease.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))`,
      [session.orgId, `${session.userId}:${requestId}`]);
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))`,
      [session.orgId, `monthly-rent:${leaseId}`]);
    if (!(await leaseVisible(client, session.orgId, leaseId))) return { status: 'unsupported' };
    const replay = await receipts(client, session, async service => (
      await service.query<Receipt & { intent_digest: string; result_kind: 'created' | 'already_issued' }>(
        `SELECT o.id::text,o.original_invoice_id::text AS invoice_id,o.plan_digest,o.amount_minor::text,
          c.intent_digest,c.result_kind FROM app.b008_monthly_rent_commands c
          JOIN app.b008_monthly_rent_occurrences o ON o.org_id=c.org_id AND o.id=c.occurrence_id
          WHERE c.org_id=$1 AND c.actor_user_id=$2 AND c.request_id=$3`,
        [session.orgId, session.userId, requestId])).rows[0]);
    if (replay) return replay.intent_digest === intent
      ? { ...result(replay, replay.result_kind, requestId), replay: true }
      : { status: 'rejected_conflict' };
    const command = async (service: Client, row: Receipt, kind: 'created' | 'already_issued') => {
      await service.query(`INSERT INTO app.b008_monthly_rent_commands
        (id,org_id,actor_user_id,request_id,intent_version,intent_digest,occurrence_id,result_kind)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [randomUUID(), session.orgId, session.userId, requestId, VERSION, intent, row.id, kind]);
      return result(row, kind, requestId);
    };
    // An immutable receipt takes precedence over the rent line it created,
    // which would otherwise make the source planner report existing_rent.
    const existing = await receipts(client, session, service =>
      occurrence(service, session.orgId, leaseId, period.start));
    if (existing) return receipts(client, session, service => command(service, existing, 'already_issued'));
    const lease = (await client.query<LeaseSource & { status: string; property_currency: string }>(
      `SELECT x.id::text,x.status::text,x.property_id::text,p.name AS property_name,
        p.currency::text AS property_currency,u.label AS unit_label,x.start_date::text,x.end_date::text,
        x.terminated_on::text,x.moved_out_on::text,x.currency::text,
        CASE WHEN c.code IS NULL THEN NULL ELSE jsonb_build_object('minorUnit',c.minor_unit,
          'displayDecimals',c.display_decimals) END AS currency_config,
        x.rent_amount_minor::text AS rent,x.rent_frequency::text AS frequency,x.due_day
        FROM leases x JOIN properties p ON p.org_id=x.org_id AND p.id=x.property_id
        JOIN units u ON u.org_id=x.org_id AND u.id=x.unit_id LEFT JOIN currencies c ON c.code=x.currency
        WHERE x.org_id=$1 AND x.id=$2`, [session.orgId, leaseId])).rows[0];
    if (!lease) return { status: 'unsupported' };
    const parties = (await client.query<MonthlyRentParty>(`SELECT lp.id::text AS "partyId",
      lp.contact_id::text AS "contactId",c.org_id::text AS "contactOrgId",c.display_name AS "payerName",
      c.is_tenant AS "isTenant",c.archived_at::text AS "archivedAt",lp.rent_share_bp AS "rentShareBp"
      FROM lease_parties lp LEFT JOIN contacts c ON c.org_id=lp.org_id AND c.id=lp.contact_id
      WHERE lp.org_id=$1 AND lp.lease_id=$2 AND lp.role='primary' ORDER BY lp.id LIMIT $3`,
      [session.orgId, leaseId, CAP + 1])).rows;
    const rent = (await client.query<RentSource>(`SELECT i.lease_id::text,i.id::text AS invoice_id,
      i.invoice_number,l.id::text AS line_id,i.status::text,i.source,l.service_period::text AS period,
      l.amount_minor::text AS amount,i.currency::text AS currency,
      coalesce(l.service_period && daterange($3::date,($4::date+1),'[)'),false) AS overlaps,
      coalesce(l.service_period=daterange($3::date,($4::date+1),'[)'),false) AS exact
      FROM invoices i JOIN invoice_lines l ON l.org_id=i.org_id AND l.invoice_id=i.id
      WHERE i.org_id=$1 AND i.lease_id=$2 AND l.charge_type='rent'
      AND (l.service_period IS NULL OR isempty(l.service_period)
        OR l.service_period && daterange($3::date,($4::date+1),'[)'))
      ORDER BY i.id,l.id LIMIT $5`, [session.orgId, leaseId, period.start, period.end, CAP + 1])).rows;
    const source = { orgId: session.orgId, environment: session.environment, month, lease, parties, rent,
      capped: parties.length > CAP || rent.length > CAP };
    const planned = planMonthlyRentOperation(source);
    if (planned.kind === 'unsupported') return { status: 'unsupported' };
    const p = planned.operation;
    if (p.digest !== expectedDigest) return { status: 'rejected_conflict' };
    const number = await nextInvoiceNumber(client, session.orgId);
    const invoiceId = randomUUID(), rentLineId = randomUUID(), ledgerTransactionId = randomUUID();
    const invoice = (await client.query(`INSERT INTO invoices
      (id,org_id,property_id,lease_id,bill_to_contact_id,invoice_number,currency,issue_date,due_date,
       period_start,period_end,total_minor,status,source,created_by,einvoice_status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,current_date,$8,$9,$10,$11,'open','recurring',$12,'not_applicable')
      RETURNING *`, [invoiceId, session.orgId, p.propertyId, leaseId, p.payerId, number, p.currency,
      p.dueDate, p.periodStart, p.periodEnd, p.amountMinor, session.userId])).rows[0];
    const rentLine = (await client.query(`INSERT INTO invoice_lines
      (id,org_id,invoice_id,line_no,charge_type,description,quantity,unit_amount_minor,amount_minor,service_period)
      VALUES ($1,$2,$3,1,'rent','rent',1,$4::numeric,$4::bigint,daterange($5::date,$6::date,'[)')) RETURNING *`,
      [rentLineId, session.orgId, invoiceId, p.amountMinor, p.periodStart, p.servicePeriodEndExclusive])).rows[0];
    const ledgerTransaction = (await client.query(`INSERT INTO ledger_transactions
      (id,org_id,property_id,lease_id,kind,currency,effective_date,description,source_table,source_id,created_by)
      VALUES ($1,$2,$3,$4,'invoice',$5,current_date,$6,'invoices',$7,$8) RETURNING *`,
      [ledgerTransactionId, session.orgId, p.propertyId, leaseId, p.currency, number, invoiceId, session.userId])).rows[0];
    const ledgerEntries = (await client.query(`INSERT INTO ledger_entries
      (org_id,transaction_id,account,amount_minor,currency,contact_id,property_id,lease_id,invoice_id,memo)
      VALUES ($1,$2,'tenant_receivable',$3::bigint,$4,$5,$6,$7,$8,'invoice'),
             ($1,$2,'rental_income',-($3::bigint),$4,$5,$6,$7,$8,'rent') RETURNING *`,
      [session.orgId, ledgerTransactionId, p.amountMinor, p.currency, p.payerId, p.propertyId, leaseId, invoiceId])).rows;
    await client.query(`UPDATE invoices SET ledger_transaction_id=$2 WHERE id=$1`, [invoiceId, ledgerTransactionId]);
    const id = randomUUID();
    const snapshot = { version: 'b008-monthly-issuance-v1', orgId: session.orgId, leaseId,
      monthStart: p.periodStart, amountMinor: p.amountMinor, currency: p.currency, planVersion: VERSION,
      planDigest: p.digest, issuerUserId: session.userId, invoiceId, rentLineId, ledgerTransactionId,
      source, invoice: { ...invoice, ledger_transaction_id: ledgerTransactionId }, rentLine, ledgerTransaction, ledgerEntries };
    return receipts(client, session, async service => {
      await service.query(`INSERT INTO app.b008_monthly_rent_occurrences
        (id,org_id,lease_id,month_start,kind,amount_minor,currency,plan_version,plan_digest,
         original_issuer_user_id,original_invoice_id,original_rent_line_id,original_ledger_transaction_id,issuance_snapshot)
        VALUES ($1,$2,$3,$4,'rent',$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
        [id, session.orgId, leaseId, p.periodStart, p.amountMinor, p.currency, VERSION, p.digest,
          session.userId, invoiceId, rentLineId, ledgerTransactionId, JSON.stringify(snapshot)]);
      return command(service, { id, invoice_id: invoiceId, plan_digest: p.digest, amount_minor: p.amountMinor }, 'created');
    });
  }, { orgId: session.orgId, environment: session.environment });
}

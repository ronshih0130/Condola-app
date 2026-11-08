import { guardEffectiveSession, withEffectiveAuthority } from "@/server/b017-custom-role-governance";
import type { Client } from "pg";
import { tx } from "./db";
import { can } from "./perms";
import { isUuid } from "./repair-rules";
import { calculateStatement } from "./statement-calculation";
import { currentOwnerTransferStaff } from "./owner-transfer-period-lock";
import { produceNotificationEvent } from "./notification-event-producers";
import { attributePaymentBig, buildSnapshot, managementFeeBig, reconcileSnapshot, type OwnerNetSnapshot } from "./owner-net-ledger-rules";
import { MockReportDeliveryAdapter, type ReportDeliveryInput, type ReportDeliveryResult } from "./report-delivery-adapter";
import type { Session } from "./types";

export type OwnerNetFlag = "owner_net_ledger" | "monthly_report_delivery";
export async function ownerNetLedgerEnabled(client: Client, orgId: string, key: OwnerNetFlag = "owner_net_ledger") {
  const row = (await client.query<{ value: unknown; feature_flags: unknown }>(
    `SELECT (SELECT value FROM public.platform_settings WHERE key=$2) AS value,feature_flags FROM public.organizations WHERE id=$1`, [orgId,key],
  )).rows[0];
  if (!row?.value || typeof row.value !== "object" || Array.isArray(row.value) ||
      !row.feature_flags || typeof row.feature_flags !== "object" || Array.isArray(row.feature_flags)) return false;
  const global = row.value as Record<string,unknown>, flags = row.feature_flags as Record<string,unknown>;
  return global.enabled === true && Array.isArray(global.allowed_org_ids) && global.allowed_org_ids.includes(orgId.toLowerCase()) && flags[key] === true;
}

type Statement = { id: string; owner_contact_id: string; currency: string; period_start: string; period_end: string; status: string; minor_unit: number; issued_at: string | null; issued_by: string | null; issued_by_name: string | null };
export type VersionView = { id: string; version_no: number; reason: string; actor_user_id: string; actor_name: string | null; created_at: string; snapshot: OwnerNetSnapshot };
export type DeliveryView = { id: string; version_id: string | null; channel: "email"; result: ReportDeliveryResult; adapter: "mock"; actor_user_id: string; created_at: string };
export type RecordStatementVersionInput = { statementId: string; requestId: string; reason: string };
const unavailable = { state: "unavailable" as const };
function validSession(s: Session) { return !s.needsSandbox && [s.userId,s.orgId].every(isUuid) && ["live","sandbox"].includes(s.environment); }
function writer(s: Session) { return validSession(s) && s.kind === "staff" && can(s,"stmt.generate"); }
async function statementFor(client: Client, s: Session, id: string) {
  return (await client.query<Statement>(`SELECT st.id::text,st.owner_contact_id::text,st.currency::text,st.period_start::text,st.period_end::text,st.status::text,
    cu.minor_unit,st.issued_at::text,st.issued_by::text,
    (SELECT pr.display_name FROM public.profiles pr WHERE pr.id=st.issued_by) AS issued_by_name
    FROM public.owner_statements st JOIN public.currencies cu ON cu.code=st.currency WHERE st.org_id=$1 AND st.id=$2
    AND (app.is_member(st.org_id) OR (st.status='issued' AND app.is_my_contact(st.owner_contact_id)))`,[s.orgId,id])).rows[0] ?? null;
}
async function versionsFor(client: Client, id: string) {
  return (await client.query<VersionView>(`SELECT id::text,version_no,reason,actor_user_id::text,actor_name,created_at::text,snapshot
    FROM app.b014_statement_versions_for($1) ORDER BY version_no DESC`,[id])).rows;
}

export async function ownerNetLedgerView(session: Session, statementId: string) {
  session = await guardEffectiveSession(session, "stmt.view");
  if (!validSession(session) || !isUuid(statementId)) return null;
  try {
    return await tx(session.userId,async client => withEffectiveAuthority(client, session, "stmt.view", async () => {
      if (!await ownerNetLedgerEnabled(client,session.orgId)) return null;
      const statement = await statementFor(client,session,statementId);
      if (!statement) return null;
      const versions = await versionsFor(client,statement.id);
      const canRecord = statement.status === "issued" && writer(session) && await currentOwnerTransferStaff(client,session);
      const staff = session.kind === "staff" && (await client.query<{ member: boolean }>(`SELECT app.is_member($1) AS member`,[session.orgId])).rows[0].member;
      const deliveries = staff && await ownerNetLedgerEnabled(client,session.orgId,"monthly_report_delivery")
        ? (await client.query<DeliveryView>(`SELECT id::text,version_id::text,channel,result,adapter,actor_user_id::text,created_at::text FROM app.b014_delivery_events_for($1)`,[statement.id])).rows : null;
      return { latest: versions[0] ?? null, versions, canRecord, deliveries, currency: statement.currency, minorUnit: statement.minor_unit,
        original: { issuedAt: statement.issued_at, issuedBy: statement.issued_by_name }, staff };
    }),{orgId:session.orgId,environment:session.environment},{isolation:"repeatable read",readOnly:true});
  } catch { return null; }
}

async function calculateSnapshot(client: Client, session: Session, statement: Statement) {
  const calc = await calculateStatement(client,session.orgId,statement.owner_contact_id,statement.period_start.slice(0,7),undefined,{repairCostFilter:true});
  if (calc.currency !== statement.currency || calc.start !== statement.period_start || calc.end !== statement.period_end) throw new Error("Statement period mismatch");
  const previous = (await client.query<{id:string;closing_balance_minor:string}>(`SELECT id::text,closing_balance_minor::text FROM public.owner_statements
    WHERE org_id=$1 AND owner_contact_id=$2 AND currency=$3 AND status='issued' AND period_end<$4::date
    ORDER BY period_end DESC,id DESC LIMIT 1`,[session.orgId,statement.owner_contact_id,statement.currency,statement.period_start])).rows[0];
  const previousVersion = previous ? (await versionsFor(client,previous.id))[0] : null;
  const opening = BigInt(previousVersion?.snapshot.closing_minor ?? previous?.closing_balance_minor ?? "0");
  const collectors = new Map((await client.query<{payment_id:string;collector:string}>(
    `SELECT * FROM app.b014_payment_collectors($1,$2::uuid[])`,[session.orgId,calc.payments.map(p=>p.id)],
  )).rows.map(row=>[row.payment_id,row.collector]));
  const depositIds = new Set((await client.query<{id:string}>(`SELECT id::text FROM public.payments
    WHERE org_id=$1 AND id=ANY($2::uuid[]) AND is_deposit`,[session.orgId,calc.payments.map(p=>p.id)])).rows.map(p=>p.id));
  // Recompute from the raw integer strings in BigInt (calculateStatement's totals use Number).
  // Deposit payments are excluded before the fee basis is formed.
  let companyRent = BigInt(0), directRent = BigInt(0), otherIncome = BigInt(0);
  for (const payment of calc.payments) {
    if (depositIds.has(payment.id)) continue;
    let rent = BigInt(0);
    for (const allocation of payment.allocations) {
      const lines = allocation.lines.map(l=>({charge_type:l.charge_type,amount_minor:BigInt(l.amount_minor),description:l.description}));
      const attributed = attributePaymentBig(lines,BigInt(allocation.amount_minor));
      rent += attributed.rent; otherIncome += attributed.utility + attributed.other;
    }
    if (collectors.get(payment.id) === "owner_direct") directRent += rent;
    else companyRent += rent;
  }
  const managementFee = calc.rule ? managementFeeBig(calc.rule, companyRent + directRent) : BigInt(0);
  const expenses = calc.expenses.reduce((sum,e)=>sum+BigInt(e.amount_minor),BigInt(0));
  // A payable entry carries the sign: payout positive, its reversal negative.
  // Attribution is by the recorded owner on the owner_payable entry, so a later
  // reversal still counts after the property's ownership period ended.
  const payouts = (await client.query<{amount:string}>(`SELECT coalesce(sum(e.amount_minor),0)::text AS amount
    FROM public.ledger_transactions t JOIN public.ledger_entries e ON e.org_id=t.org_id AND e.transaction_id=t.id
    WHERE t.org_id=$1 AND t.source_table='b014_owner_transfer_v1' AND t.kind IN ('owner_payout','reversal')
      AND t.currency=$3 AND e.currency=t.currency AND e.account='owner_payable' AND e.contact_id=$2
      AND t.effective_date BETWEEN $4::date AND $5::date`,
    [session.orgId,statement.owner_contact_id,statement.currency,statement.period_start,statement.period_end])).rows[0].amount;
  return buildSnapshot({opening,companyRent,directRent,otherIncome,managementFee,
    expenses,payouts:BigInt(payouts),prepayDraws:BigInt(0)},
  {currency:statement.currency,periodStart:statement.period_start,periodEnd:statement.period_end,statementId:statement.id,calculationFingerprint:calc.fingerprint});
}

export async function recordStatementVersion(session: Session, input: RecordStatementVersionInput) {
  session = await guardEffectiveSession(session, "stmt.generate");
  if (!writer(session) || !input || !isUuid(input.statementId) || !isUuid(input.requestId)) return unavailable;
  // An advisory-lock wait does not refresh a repeatable-read snapshot. Retry
  // the whole calculation after a competing version commits, never just INSERT.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await tx(session.userId,async client => withEffectiveAuthority(client, session, "stmt.generate", async () => {
        if (!await ownerNetLedgerEnabled(client,session.orgId) || !await currentOwnerTransferStaff(client,session)) return unavailable;
        if (typeof input.reason !== "string" || input.reason !== input.reason.trim() || input.reason.length < 1 || input.reason.length > 500) return {state:"invalid" as const};
        const statement = await statementFor(client,session,input.statementId);
        if (!statement || statement.status !== "issued") return unavailable;
        // An identical retry returns the committed version before any recalculation;
        // a different statement/reason/actor under the same request id fails closed.
        const prior = (await client.query<{id:string;statement_id:string;reason:string;actor_user_id:string}>(
          `SELECT id::text,statement_id::text,reason,actor_user_id::text FROM app.b014_version_for_request($1,$2)`,
          [statement.id,input.requestId])).rows[0];
        if (prior) return prior.statement_id === statement.id && prior.reason === input.reason && prior.actor_user_id === session.userId
          ? {state:"recorded" as const,versionId:prior.id} : unavailable;
        const snapshot = await calculateSnapshot(client,session,statement);
        if (!reconcileSnapshot(snapshot)) return {state:"unchanged_identity_error" as const};
        const result = await client.query<{id:string}>(`SELECT app.b014_record_statement_version($1,$2,$3,$4::jsonb)::text AS id`,
          [statement.id,input.requestId,input.reason,JSON.stringify(snapshot)]);
        await produceNotificationEvent(client,session.orgId,"statement_version",result.rows[0].id);
        return {state:"recorded" as const,versionId:result.rows[0].id};
      }),{orgId:session.orgId,environment:session.environment},{isolation:"repeatable read"});
    } catch (error) {
      const cause = error instanceof Error ? error.cause as {code?:string;constraint?:string} | undefined : undefined;
      const concurrentVersion = cause?.code === "23505" && [
        "b014_statement_versions_org_id_statement_id_version_no_key",
        "b014_statement_versions_org_id_request_id_key",
      ].includes(cause.constraint ?? "");
      if (cause?.code !== "40001" && !concurrentVersion) return unavailable;
    }
  }
  return unavailable;
}

export async function recordReportDelivery(session: Session, input: ReportDeliveryInput) {
  session = await guardEffectiveSession(session, "stmt.generate");
  if (!writer(session) || !input || !isUuid(input.statementId) || !isUuid(input.requestId) || (input.versionId !== null && !isUuid(input.versionId))) return unavailable;
  try {
    return await tx(session.userId,async client => withEffectiveAuthority(client, session, "stmt.generate", async () => {
      if (!await ownerNetLedgerEnabled(client,session.orgId) || !await ownerNetLedgerEnabled(client,session.orgId,"monthly_report_delivery") ||
          !await currentOwnerTransferStaff(client,session)) return unavailable;
      const statement = await statementFor(client,session,input.statementId);
      if (!statement || statement.status !== "issued") return unavailable;
      const versionId = input.versionId?.toLowerCase() ?? null;
      if (versionId !== null && !(await versionsFor(client,statement.id)).some(v=>v.id===versionId)) return unavailable;
      const result = await new MockReportDeliveryAdapter().deliver(input);
      const event = await client.query<{id:string}>(`SELECT app.b014_record_delivery_event($1,$2,$3,$4)::text AS id`,
        [statement.id,input.versionId,input.requestId,result]);
      return {state:"recorded" as const,result,eventId:event.rows[0].id};
    }),{orgId:session.orgId,environment:session.environment});
  } catch { return unavailable; }
}

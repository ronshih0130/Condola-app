import { createHash, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { withClient } from "./db";
import { allocateAndLedger, lockAllocationInvoices } from "./domain";
import { emitPaymentResult, lockPaymentResultContext } from "./payment-result-events";
import { beginPaymentCenter, finalizePaymentCenter } from "./payment-center-events";
import { scoreMatch } from "./money";
import { bankDecisionDigest, bankMatchReasonCode, bankRowKeys, isUuid, parseBankCsv } from "./bank-matching-rules";
import { bankMatchBasis } from "../lib/bank-match-basis";
import type { Session } from "./types";

const fail = () => new Error("Bank matching unavailable");
async function authorize(client: Client, session: Session, write: boolean): Promise<boolean> {
  if (session.kind !== "staff" || !["admin","accountant"].includes(session.role ?? "") || session.needsSandbox) return false;
  if (write) await client.query("LOCK TABLE public.platform_settings IN SHARE MODE");
  const result = await client.query(`SELECT 1 FROM organizations o
    JOIN org_members m ON m.org_id=CASE WHEN o.environment='sandbox' THEN o.live_org_id ELSE o.id END AND m.user_id=$2 AND m.status='active' AND m.role IN ('admin','accountant')
    JOIN auth_sessions s ON s.id=$3 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>now()
    JOIN platform_settings p ON p.key='bank_matching'
    WHERE o.id=$1 AND o.environment::text=$4 AND (CASE WHEN o.environment='sandbox' THEN o.live_org_id ELSE o.id END)=$5
      AND o.feature_flags->'bank_matching'='true'::jsonb AND p.value->'enabled'='true'::jsonb
      AND jsonb_typeof(p.value->'allowed_org_ids')='array' AND p.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)
    ${write ? "FOR SHARE OF o,m,s" : ""}`, [session.orgId,session.userId,session.sessionId,session.environment,session.liveOrgId]);
  return result.rowCount === 1;
}
async function operation<T>(session: Session, write: boolean, fn: (client: Client) => Promise<T>): Promise<T | null> {
  return withClient(async (client) => {
    await client.query(write ? "BEGIN" : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      if (!await authorize(client,session,write)) { await client.query("ROLLBACK"); return null; }
      const result = await fn(client); await client.query("COMMIT"); return result;
    } catch { await client.query("ROLLBACK"); throw fail(); }
  });
}
export async function bankBoard(session: Session) {
  return operation(session,false,async (client) => {
    const accounts = await client.query<{id:string;nickname:string;currency:string}>(`SELECT id::text,nickname,currency FROM bank_accounts WHERE org_id=$1 AND archived_at IS NULL ORDER BY created_at,id`,[session.orgId]);
    const lines = await client.query<{id:string;date:string;amount:string;currency:string;last5:string|null;description:string|null;status:string;account:string;account_property:string|null;overlap:boolean}>(
      `SELECT b.id::text,b.posted_on::text AS date,b.amount_minor::text AS amount,b.currency,b.counterparty_account_last5::text AS last5,b.description,b.status::text,a.nickname AS account,a.property_id::text AS account_property,
       EXISTS (SELECT 1 FROM bank_transactions old WHERE old.org_id=b.org_id AND old.bank_account_id=b.bank_account_id AND old.id<>b.id AND old.posted_on=b.posted_on AND old.amount_minor=b.amount_minor) AS overlap
       FROM bank_transactions b JOIN bank_accounts a ON a.id=b.bank_account_id AND a.org_id=b.org_id
       WHERE b.org_id=$1 AND a.archived_at IS NULL AND b.status IN ('unmatched','suggested') ORDER BY b.posted_on DESC,b.created_at DESC,b.id`,[session.orgId]);
    const payments = await client.query<{id:string;date:string;amount:string;currency:string;name:string|null;property_id:string}>(`SELECT p.id::text,p.paid_on::text AS date,p.amount_minor::text AS amount,p.currency,p.property_id::text,c.display_name AS name FROM payments p LEFT JOIN contacts c ON c.id=p.payer_contact_id AND c.org_id=p.org_id WHERE p.org_id=$1 AND p.bank_transaction_id IS NULL AND p.status IN ('submitted','confirmed') ORDER BY p.paid_on DESC,p.id`,[session.orgId]);
    const suggestions = await client.query<{id:string;bank:string;payment:string;score:string;reasons:unknown}>(`SELECT s.id::text,s.bank_transaction_id::text AS bank,s.payment_id::text AS payment,s.score::text,s.reasons FROM bank_match_suggestions s JOIN payments p ON p.org_id=s.org_id AND p.id=s.payment_id WHERE s.org_id=$1 AND s.status='suggested' AND p.bank_transaction_id IS NULL AND p.status IN ('submitted','confirmed')`,[session.orgId]);
    return { accounts:accounts.rows,lines:lines.rows,payments:payments.rows,suggestions:suggestions.rows.map(({id,bank,payment,score,reasons}) => ({id,bank,payment,score,basis:bankMatchBasis(reasons)})) };
  });
}

/** Distinguish an unavailable enabled gateway from the legacy OFF screen. */
export async function bankMatchingEnabled(session: Session): Promise<boolean> {
  if (session.kind !== "staff" || !["admin","accountant"].includes(session.role ?? "")) throw fail();
  return withClient(async (client) => {
    const result = await client.query<{enabled:boolean}>(`SELECT EXISTS (SELECT 1 FROM organizations o JOIN platform_settings p ON p.key='bank_matching'
      WHERE o.id=$1 AND o.environment::text=$2 AND o.feature_flags->'bank_matching'='true'::jsonb AND p.value->'enabled'='true'::jsonb
      AND jsonb_typeof(p.value->'allowed_org_ids')='array' AND p.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) AS enabled`,[session.orgId,session.environment]);
    return result.rows[0].enabled;
  });
}

export async function importBankFile(session: Session, accountId: string, bytes: Uint8Array, encoding: "utf-8" | "big5", dateFormat: "iso" | "roc" = "iso") {
  if (bytes.length > 1_000_000 || !["utf-8","big5"].includes(encoding) || !["iso","roc"].includes(dateFormat)) throw fail();
  let rows: ReturnType<typeof parseBankCsv>;
  try { rows = parseBankCsv(new TextDecoder(encoding,{fatal:true}).decode(bytes),dateFormat); } catch { throw fail(); }
  const hash = createHash("sha256").update(bytes).digest("hex");
  return operation(session,true,async (client) => {
    const account = (await client.query<{id:string;currency:string;property_id:string|null}>(`SELECT id::text,currency,property_id::text FROM bank_accounts WHERE id=$1 AND org_id=$2 AND archived_at IS NULL FOR SHARE`,[accountId,session.orgId])).rows[0];
    if (!account) throw fail();
    accountId = account.id;
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`${session.orgId}:${accountId}`]);
    const prior = (await client.query<{import_id:string;encoding:string;date_format:string}>(`SELECT import_id::text,encoding,date_format FROM app.b009_file_imports WHERE org_id=$1 AND bank_account_id=$2 AND file_hash=$3`,[session.orgId,accountId,hash])).rows[0];
    if (prior) { if (prior.encoding !== encoding || prior.date_format !== dateFormat) throw fail(); return { importId:prior.import_id, duplicate:true, duplicateRows:rows.length }; }
    const file = (await client.query<{id:string}>(`INSERT INTO files(org_id,storage_bucket,storage_path,file_name,mime_type,size_bytes,uploaded_by) VALUES ($1,'bank-imports',$2,'statement.csv','text/csv',$3,$4) RETURNING id::text`,[session.orgId,`b009/${randomUUID()}.csv`,bytes.length,session.userId])).rows[0].id;
    const imported = (await client.query<{id:string}>(`INSERT INTO bank_statement_imports(org_id,bank_account_id,file_id,status,row_count,uploaded_by) VALUES ($1,$2,$3,'completed',$4,$5) RETURNING id::text`,[session.orgId,accountId,file,rows.length,session.userId])).rows[0].id;
    await client.query(`INSERT INTO app.b009_file_imports(org_id,bank_account_id,file_hash,import_id,encoding,date_format) VALUES ($1,$2,$3,$4,$5,$6)`,[session.orgId,accountId,hash,imported,encoding,dateFormat]);
    const keys = bankRowKeys(accountId,rows);
    let duplicateRows = 0;
    for (const [index,row] of rows.entries()) {
      const existing = await client.query(`SELECT 1 FROM app.b009_row_identities WHERE org_id=$1 AND bank_account_id=$2 AND row_key=$3`,[session.orgId,accountId,keys[index]]);
      if (existing.rowCount) { duplicateRows++; continue; }
      const id = (await client.query<{id:string}>(`INSERT INTO bank_transactions(org_id,bank_account_id,import_id,row_number,posted_on,amount_minor,currency,description,counterparty_account_last5,raw,dedupe_hash,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'{}'::jsonb,$10,'unmatched') RETURNING id::text`,[session.orgId,accountId,imported,index+1,row.date,row.amountMinor.toString(),account.currency,row.memo || null,row.last5,keys[index]])).rows[0].id;
      await client.query(`INSERT INTO app.b009_row_identities(org_id,bank_account_id,row_key,bank_transaction_id) VALUES ($1,$2,$3,$4)`,[session.orgId,accountId,keys[index],id]);
      if (row.amountMinor <= BigInt(0)) continue;
      const payments = await client.query<{id:string;amount:string;last5:string|null;date:string}>(`SELECT id::text,amount_minor::text AS amount,payer_account_last5::text AS last5,paid_on::text AS date FROM payments WHERE org_id=$1 AND currency=$2 AND amount_minor=$3 AND ($4::uuid IS NULL OR property_id=$4) AND bank_transaction_id IS NULL AND status IN ('submitted','confirmed')`,[session.orgId,account.currency,row.amountMinor.toString(),account.property_id]);
      for (const payment of payments.rows) {
        const score = scoreMatch({payAmount:Number(payment.amount),bankAmount:Number(row.amountMinor),payLast5:payment.last5,bankLast5:row.last5,payDate:payment.date,bankDate:row.date});
        await client.query(`INSERT INTO bank_match_suggestions(org_id,bank_transaction_id,payment_id,score,reasons,status) VALUES ($1,$2,$3,$4,$5::jsonb,'suggested')`,[session.orgId,id,payment.id,score.score,JSON.stringify(score.reasons)]);
      }
      if (payments.rowCount) await client.query(`UPDATE bank_transactions SET status='suggested' WHERE id=$1`,[id]);
    }
    return {importId:imported,duplicate:false,duplicateRows};
  });
}

export async function decideBankMatch(session: Session, input: {bankId:string;paymentId?:string;suggestionId?:string;decision:"match"|"reject";reason:unknown;requestId?:string}) {
  const reason = bankMatchReasonCode(input.reason);
  if (!reason || !["match","reject"].includes(input.decision)) throw fail();
  let requestId = input.requestId;
  if (requestId !== undefined) {
    if (!isUuid(requestId)) throw fail();
    requestId = requestId.toLowerCase();
  }
  if (isUuid(input.bankId)) input = {...input,bankId:input.bankId.toLowerCase()};
  if (isUuid(input.paymentId)) input = {...input,paymentId:input.paymentId.toLowerCase()};
  const digest = bankDecisionDigest({...input,reason});
  return operation(session,true,async (client) => {
    if (requestId) {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`${session.orgId}:b009req:${requestId}`]);
      const prior = (await client.query<{request_digest:string}>(`SELECT request_digest FROM app.b009_decisions WHERE org_id=$1 AND request_id=$2`,[session.orgId,requestId])).rows[0];
      if (prior) {
        if (prior.request_digest === digest) return true;
        throw fail();
      }
    }
    let initialPayment: {id:string;lease_id:string} | null=null;
    let resultEnabled=false;
    let center:Awaited<ReturnType<typeof beginPaymentCenter>>=null;
    if (input.decision === "match") {
      const flag=(await client.query<{enabled:boolean}>(`SELECT EXISTS (SELECT 1 FROM organizations o JOIN platform_settings f ON f.key='payment_results_v2'
        WHERE o.id=$1 AND o.feature_flags->'payment_results_v2'='true'::jsonb AND f.value->'enabled'='true'::jsonb
          AND jsonb_typeof(f.value->'allowed_org_ids')='array' AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) AS enabled`,[session.orgId])).rows[0].enabled;
      if (flag) await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[session.userId]);
      const discovered=input.suggestionId ? (await client.query<{id:string}>(`SELECT payment_id::text AS id FROM bank_match_suggestions WHERE org_id=$1 AND bank_transaction_id=$2 AND id=$3`,[session.orgId,input.bankId,input.suggestionId])).rows[0]?.id : input.paymentId;
      if (!discovered || (input.paymentId && input.paymentId !== discovered)) throw fail();
      initialPayment=(await client.query<{id:string;lease_id:string}>(`SELECT id::text,lease_id::text FROM payments WHERE org_id=$1 AND id=$2`,[session.orgId,discovered])).rows[0] ?? null;
      if (!initialPayment) throw fail();
      resultEnabled=flag && await lockPaymentResultContext(client,session,initialPayment.lease_id);
      center=await beginPaymentCenter(client,session,{leaseId:initialPayment.lease_id,paymentId:initialPayment.id,action:"bank_match"});
    }
    const bank = (await client.query<{status:string;amount:string;currency:string;property_id:string|null}>(`SELECT b.status::text,b.amount_minor::text AS amount,b.currency,a.property_id::text FROM bank_transactions b JOIN bank_accounts a ON a.org_id=b.org_id AND a.id=b.bank_account_id WHERE b.org_id=$1 AND b.id=$2 AND a.archived_at IS NULL FOR UPDATE OF b FOR SHARE OF a`,[session.orgId,input.bankId])).rows[0];
    if (!bank || !["unmatched","suggested"].includes(bank.status)) throw fail();
    const suggestion = input.suggestionId ? (await client.query<{id:string;payment_id:string;status:string}>(`SELECT id::text,payment_id::text,status::text FROM bank_match_suggestions WHERE org_id=$1 AND bank_transaction_id=$2 AND id=$3 FOR UPDATE`,[session.orgId,input.bankId,input.suggestionId])).rows[0] : null;
    if (input.suggestionId && (!suggestion || suggestion.status !== "suggested")) throw fail();
    if (input.decision === "reject") {
      if (!suggestion) throw fail();
      await client.query(`UPDATE bank_match_suggestions SET status='rejected',decided_by=$2,decided_at=now() WHERE id=$1`,[suggestion.id,session.userId]);
      const remaining = await client.query(`SELECT 1 FROM bank_match_suggestions WHERE org_id=$1 AND bank_transaction_id=$2 AND status='suggested' LIMIT 1`,[session.orgId,input.bankId]);
      if (!remaining.rowCount) await client.query(`UPDATE bank_transactions SET status='unmatched' WHERE org_id=$1 AND id=$2`,[session.orgId,input.bankId]);
      await client.query(`INSERT INTO app.b009_decisions(org_id,bank_transaction_id,payment_id,suggestion_id,decision,source,reason,actor_id,request_id,request_digest) VALUES ($1,$2,$3,$4,'reject','suggestion',$5,$6,$7,$8)`,[session.orgId,input.bankId,suggestion.payment_id,suggestion.id,reason,session.userId,requestId ?? null,requestId ? digest : null]);
      return true;
    }
    const paymentId = suggestion?.payment_id ?? input.paymentId;
    if (!paymentId || (suggestion && input.paymentId && input.paymentId !== paymentId)) throw fail();
    const payment = (await client.query<{id:string;org_id:string;property_id:string;lease_id:string;currency:string;amount_minor:string;payer_contact_id:string|null;status:string;bank_transaction_id:string|null}>(`SELECT id::text,org_id::text,property_id::text,lease_id::text,currency,amount_minor::text,payer_contact_id::text,status::text,bank_transaction_id::text FROM payments WHERE org_id=$1 AND id=$2 FOR UPDATE`,[session.orgId,paymentId])).rows[0];
    if (!payment || !initialPayment || payment.id !== initialPayment.id || payment.lease_id !== initialPayment.lease_id || payment.bank_transaction_id || !["submitted","confirmed"].includes(payment.status) || (bank.property_id !== null && bank.property_id !== payment.property_id) || bank.currency !== payment.currency || bank.amount !== payment.amount_minor || BigInt(bank.amount) <= BigInt(0) || BigInt(bank.amount) > BigInt(Number.MAX_SAFE_INTEGER)) throw fail();
    if (payment.status === "submitted") {
      const invoices = await lockAllocationInvoices(client,session.orgId,payment.lease_id);
      if (Number(payment.amount_minor) > invoices.reduce((sum, invoice) => sum + Number(invoice.balance_minor),0)) throw fail();
      if (resultEnabled && !await lockPaymentResultContext(client,session,payment.lease_id)) throw fail();
      await client.query(`UPDATE payments SET status='confirmed',confirmed_by=$2,confirmed_at=now(),bank_transaction_id=$3 WHERE org_id=$4 AND id=$1`,[payment.id,session.userId,input.bankId,session.orgId]);
      await allocateAndLedger(client,payment,session.userId,invoices);
      const source=resultEnabled ? await emitPaymentResult(client,payment.id,"payment_confirmed") : null;
      await finalizePaymentCenter(client,center,source);
    } else await client.query(`UPDATE payments SET bank_transaction_id=$2 WHERE id=$1 AND org_id=$3`,[payment.id,input.bankId,session.orgId]);
    if (suggestion) await client.query(`UPDATE bank_match_suggestions SET status='approved',decided_by=$2,decided_at=now() WHERE id=$1`,[suggestion.id,session.userId]);
    await client.query(`UPDATE bank_match_suggestions SET status='superseded',decided_by=$3,decided_at=now() WHERE org_id=$1 AND bank_transaction_id=$2 AND status='suggested'`,[session.orgId,input.bankId,session.userId]);
    await client.query(`UPDATE bank_transactions SET status='matched' WHERE org_id=$1 AND id=$2`,[session.orgId,input.bankId]);
    await client.query(`INSERT INTO app.b009_decisions(org_id,bank_transaction_id,payment_id,suggestion_id,decision,source,reason,actor_id,request_id,request_digest) VALUES ($1,$2,$3,$4,'match',$5,$6,$7,$8,$9)`,[session.orgId,input.bankId,payment.id,suggestion?.id ?? null,suggestion ? "suggestion" : "manual",reason,session.userId,requestId ?? null,requestId ? digest : null]);
    return true;
  });
}

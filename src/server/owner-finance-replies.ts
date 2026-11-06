import { guardEffectiveSession, withEffectiveAuthority } from "@/server/b017-custom-role-governance";
import type { Client } from "pg";
import { tx } from "./db";
import { isUuid } from "./repair-rules";
import type { Session } from "./types";

export type OwnerFinanceFlag = "owner_receipt_title" | "owner_report_replies";
export async function ownerFinanceRepliesEnabled(client: Client, orgId: string, key: OwnerFinanceFlag) {
  const row = (await client.query<{ value: unknown; feature_flags: unknown }>(
    `SELECT (SELECT value FROM public.platform_settings WHERE key=$2) AS value,feature_flags FROM public.organizations WHERE id=$1`, [orgId,key],
  )).rows[0];
  if (!row?.value || typeof row.value !== "object" || Array.isArray(row.value) ||
      !row.feature_flags || typeof row.feature_flags !== "object" || Array.isArray(row.feature_flags)) return false;
  const global = row.value as Record<string,unknown>, flags = row.feature_flags as Record<string,unknown>;
  return global.enabled === true && Array.isArray(global.allowed_org_ids) && global.allowed_org_ids.includes(orgId.toLowerCase()) && flags[key] === true;
}

export type ReceiptTitleView = { title: string | null; revisions: { title: string; created_at: string }[] };
export type OwnerTransferView = { id: string; kind: "owner_payout" | "reversal"; effective_date: string; amount_minor: string; currency: string; reverses_transaction_id: string | null; created_at: string };
export type ReportReplyView = { id: string; version_id: string | null; kind: "confirm" | "dispute"; body: string | null; created_at: string; actor_is_owner: boolean };
export type SaveReceiptTitleInput = { requestId: string; title: string };
export type RecordReportReplyInput = { statementId: string; versionId: string | null; requestId: string; kind: "confirm" | "dispute"; body: string | null };
const unavailable = { state: "unavailable" as const };
function validSession(s: Session) { return !s.needsSandbox && [s.userId,s.orgId].every(isUuid) && ["live","sandbox"].includes(s.environment); }
function ownerWriter(s: Session) { return validSession(s) && s.kind === "owner" && isUuid(s.sessionId); }
async function currentSession(client: Client, s: Session) {
  return (await client.query(`SELECT 1 FROM public.auth_sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()`,[s.sessionId,s.userId])).rowCount === 1;
}

export async function ownerReceiptTitleView(session: Session) {
  session = await guardEffectiveSession(session, "stmt.view");
  if (!validSession(session) || session.kind !== "owner") return null;
  try {
    return await tx(session.userId,async client => withEffectiveAuthority(client, session, "stmt.view", async () => {
      if (!await ownerFinanceRepliesEnabled(client,session.orgId,"owner_receipt_title")) return null;
      return (await client.query<ReceiptTitleView>(`SELECT title,revisions FROM app.b022_my_receipt_title($1)`,[session.orgId])).rows[0] ?? null;
    }),{orgId:session.orgId,environment:session.environment},{isolation:"repeatable read",readOnly:true});
  } catch { return null; }
}

export async function saveReceiptTitle(session: Session, input: SaveReceiptTitleInput) {
  session = await guardEffectiveSession(session, "stmt.view");
  if (!ownerWriter(session) || !input || !isUuid(input.requestId)) return unavailable;
  try {
    return await tx(session.userId,async client => withEffectiveAuthority(client, session, "stmt.view", async () => {
      if (!await ownerFinanceRepliesEnabled(client,session.orgId,"owner_receipt_title") || !await currentSession(client,session)) return unavailable;
      if (typeof input.title !== "string") return unavailable;
      const result = await client.query<{id:string}>(`SELECT app.b022_set_receipt_title($1,$2,$3)::text AS id`,[session.orgId,input.requestId,input.title]);
      return {state:"recorded" as const,revisionId:result.rows[0].id};
    }),{orgId:session.orgId,environment:session.environment});
  } catch { return unavailable; }
}

export async function ownerTransferHistory(session: Session, statementId: string) {
  session = await guardEffectiveSession(session, "stmt.view");
  if (!validSession(session) || !isUuid(statementId)) return null;
  try {
    return await tx(session.userId,async client => withEffectiveAuthority(client, session, "stmt.view", async () => {
      if (!await ownerFinanceRepliesEnabled(client,session.orgId,"owner_report_replies")) return null;
      const rows = (await client.query<OwnerTransferView>(`SELECT id::text,kind,effective_date::text,amount_minor,currency,reverses_transaction_id::text,created_at::text
        FROM app.b022_owner_transfers_for($1)`,[statementId])).rows;
      const minorUnit = (await client.query<{minor_unit:number}>(`SELECT c.minor_unit FROM public.owner_statements s JOIN public.currencies c ON c.code=s.currency WHERE s.id=$1`,[statementId])).rows[0]?.minor_unit ?? null;
      return { rows, minorUnit };
    }),{orgId:session.orgId,environment:session.environment},{isolation:"repeatable read",readOnly:true});
  } catch { return null; }
}

export async function reportRepliesView(session: Session, statementId: string) {
  session = await guardEffectiveSession(session, "stmt.view");
  if (!validSession(session) || !isUuid(statementId)) return null;
  try {
    return await tx(session.userId,async client => withEffectiveAuthority(client, session, "stmt.view", async () => {
      if (!await ownerFinanceRepliesEnabled(client,session.orgId,"owner_report_replies")) return null;
      const context = (await client.query<{latest_version_id:string|null;latest_version_no:number;can_reply:boolean}>(
        `SELECT latest_version_id::text,latest_version_no,can_reply FROM app.b022_report_reply_context($1)`,[statementId])).rows[0];
      if (!context) return null;
      const replies = (await client.query<ReportReplyView>(`SELECT id::text,version_id::text,kind,body,created_at::text,actor_is_owner FROM app.b022_report_replies_for($1)`,[statementId])).rows;
      return { replies, latestVersionId:context.latest_version_id, latestVersionNo:context.latest_version_no,
        confirmedCurrent:replies.some(r=>r.kind === "confirm" && r.version_id === context.latest_version_id),
        canReply:ownerWriter(session) && context.can_reply && await currentSession(client,session) };
    }),{orgId:session.orgId,environment:session.environment},{isolation:"repeatable read",readOnly:true});
  } catch { return null; }
}

export async function recordReportReply(session: Session, input: RecordReportReplyInput) {
  session = await guardEffectiveSession(session, "stmt.view");
  if (!ownerWriter(session) || !input || !isUuid(input.statementId) || !isUuid(input.requestId) || (input.versionId !== null && !isUuid(input.versionId))) return unavailable;
  try {
    return await tx(session.userId,async client => withEffectiveAuthority(client, session, "stmt.view", async () => {
      if (!await ownerFinanceRepliesEnabled(client,session.orgId,"owner_report_replies") || !await currentSession(client,session)) return unavailable;
      if ((input.kind !== "confirm" && input.kind !== "dispute") ||
          (input.kind === "confirm" ? input.body !== null : typeof input.body !== "string")) return unavailable;
      const result = await client.query<{id:string}>(`SELECT app.b022_record_report_reply($1,$2,$3,$4,$5)::text AS id`,
        [input.statementId,input.versionId,input.requestId,input.kind,input.body]);
      return {state:"recorded" as const,replyId:result.rows[0].id};
    }),{orgId:session.orgId,environment:session.environment});
  } catch { return unavailable; }
}

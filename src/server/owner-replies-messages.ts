import type { Client } from "pg";
import { tx } from "./db";
import { requireOrgScope } from "./org-guard";
import { ownerPortalExtensionsEnabled } from "./owner-portal-access";
import { can } from "./perms";
import { isUuid } from "./repair-rules";
import type { Session } from "./types";

/**
 * B-023 slice 2: owner lifecycle replies and owner ↔ company messaging, behind the
 * strict `owner_portal_extensions` flag (OFF ⇒ null/unavailable before any B-023
 * gateway is called, so pages 404 and nothing is written).
 * - Lifecycle replies are text-only records attached to B-012 notice versions. They
 *   are never B-012 responses (tenant/company/owner agree-disagree-undecided) and
 *   never imply consent, signature, confirmation, approval or a stance.
 * - Messages reuse public.message_threads/messages; owners read and write only
 *   through app.b023_* gateways (they are not thread participants).
 * Authority (current window on the property) is decided and re-checked in SQL.
 */
export type OwnerLifecycleItem = {
  record_id: string; lease_id: string; notice_version: number;
  kind: "renewal_intent" | "non_renewal_notice" | "early_termination_notice";
  filed_by: "tenant" | "company" | "owner"; occurred_on: string | null; effective_on: string | null; notice_at: string;
  property_name: string; unit_label: string | null; room_label: string | null;
  lease_start: string; lease_end: string | null; lease_status: string; my_reply_count: number; my_last_reply_at: string | null;
};
export type OwnerLifecycleReply = { id: string; notice_version: number; body: string; created_at: string };
export type OwnerLifecycleDetail = OwnerLifecycleItem & { my_replies: OwnerLifecycleReply[] };
export type OwnerThreadRow = { property_id: string; property_name: string; thread_id: string | null; last_message_at: string | null; message_count: number };
export type OwnerThreadMessage = { message_id: string; sender: "owner" | "company"; body: string; created_at: string; edited: boolean };
export type OwnerThreadView = { property_id: string; property_name: string; messages: OwnerThreadMessage[] };
export type ReplyLifecycleInput = { recordId: string; noticeVersion: number; requestId: string; body: string };
export type PostOwnerMessageInput = { propertyId: string; requestId: string; body: string };
export type OwnerWriteResult =
  | { state: "recorded" | "replayed"; id: string }
  | { state: "unavailable" | "invalid" | "conflict" | "stale" | "gone" | "rate_limited" };
export type StaffOwnerThreadRow = { thread_id: string; property_id: string; property_name: string; owner_name: string; last_message_at: string | null; preview: string | null };
export type StaffOwnerLifecycleReply = { reply_id: string; record_id: string; notice_version: number; notice_kind: OwnerLifecycleItem["kind"]; owner_name: string; body: string; created_at: string };

export const OWNER_TEXT_MAX = 2000;
const unavailable = { state: "unavailable" } as const;

function ownerSession(s: Session) {
  return s.kind === "owner" && !s.needsSandbox && [s.userId, s.orgId].every(isUuid) && ["live", "sandbox"].includes(s.environment);
}
function ownerWriter(s: Session) { return ownerSession(s) && isUuid(s.sessionId); }
function scope(s: Session) { return { orgId: s.orgId, environment: s.environment }; }
async function currentSession(client: Client, s: Session) {
  return (await client.query(`SELECT 1 FROM public.auth_sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()`,
    [s.sessionId, s.userId])).rowCount === 1;
}
/** Trimmed text within bounds, else null. */
export function ownerText(value: unknown) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length >= 1 && text.length <= OWNER_TEXT_MAX ? text : null;
}
function writeResult(raw: unknown, idKey: "replyId" | "messageId"): OwnerWriteResult {
  const r = raw as Record<string, unknown> | null;
  const state = r?.state;
  if ((state === "recorded" || state === "replayed") && typeof r?.[idKey] === "string") return { state, id: r[idKey] as string };
  if (state === "invalid" || state === "conflict" || state === "stale" || state === "gone" || state === "rate_limited") return { state };
  return unavailable;
}

export async function ownerLifecycleItems(session: Session): Promise<OwnerLifecycleItem[] | null> {
  if (!ownerSession(session)) return null;
  try {
    return await tx(session.userId, async client => {
      if (!await ownerPortalExtensionsEnabled(client, session.orgId)) return null;
      return (await client.query<OwnerLifecycleItem>(
        `SELECT record_id::text, lease_id::text, notice_version, kind, filed_by, occurred_on::text, effective_on::text, notice_at::text,
                property_name, unit_label, room_label, lease_start::text, lease_end::text, lease_status, my_reply_count, my_last_reply_at::text
           FROM app.b023_owner_lifecycle_items($1)`, [session.orgId])).rows;
    }, scope(session), { isolation: "repeatable read", readOnly: true });
  } catch { return null; }
}

export async function ownerLifecycleDetail(session: Session, recordId: string): Promise<OwnerLifecycleDetail | null> {
  if (!ownerSession(session) || !isUuid(recordId)) return null;
  try {
    return await tx(session.userId, async client => {
      if (!await ownerPortalExtensionsEnabled(client, session.orgId)) return null;
      return (await client.query<OwnerLifecycleDetail>(
        `SELECT record_id::text, lease_id::text, notice_version, kind, filed_by, occurred_on::text, effective_on::text, notice_at::text,
                property_name, unit_label, room_label, lease_start::text, lease_end::text, lease_status, my_reply_count, my_last_reply_at::text, my_replies
           FROM app.b023_owner_lifecycle_detail($1,$2)`, [session.orgId, recordId])).rows[0] ?? null;
    }, scope(session), { isolation: "repeatable read", readOnly: true });
  } catch { return null; }
}

/** Idempotent by requestId (client keeps it across retries). Never a B-012 response. */
export async function replyOwnerLifecycle(session: Session, input: ReplyLifecycleInput): Promise<OwnerWriteResult> {
  if (!ownerWriter(session) || !input || !isUuid(input.recordId) || !isUuid(input.requestId)) return unavailable;
  try {
    return await tx(session.userId, async client => {
      if (!await ownerPortalExtensionsEnabled(client, session.orgId) || !await currentSession(client, session)) return unavailable;
      const body = ownerText(input.body);
      if (!body || !Number.isSafeInteger(input.noticeVersion) || input.noticeVersion < 1 || input.noticeVersion >= 2147483647) return { state: "invalid" };
      const raw = (await client.query<{ result: unknown }>(`SELECT app.b023_reply_owner_lifecycle($1,$2,$3,$4,$5,$6) AS result`,
        [session.orgId, session.sessionId, input.recordId, input.noticeVersion, input.requestId, body])).rows[0]?.result;
      return writeResult(raw, "replyId");
    }, scope(session));
  } catch { return unavailable; }
}

export async function ownerMessageThreads(session: Session): Promise<OwnerThreadRow[] | null> {
  if (!ownerSession(session)) return null;
  try {
    return await tx(session.userId, async client => {
      if (!await ownerPortalExtensionsEnabled(client, session.orgId)) return null;
      return (await client.query<OwnerThreadRow>(
        `SELECT property_id::text, property_name, thread_id::text, last_message_at::text, message_count FROM app.b023_owner_message_threads($1)`,
        [session.orgId])).rows;
    }, scope(session), { isolation: "repeatable read", readOnly: true });
  } catch { return null; }
}

export async function ownerThread(session: Session, propertyId: string): Promise<OwnerThreadView | null> {
  if (!ownerSession(session) || !isUuid(propertyId)) return null;
  try {
    return await tx(session.userId, async client => {
      if (!await ownerPortalExtensionsEnabled(client, session.orgId)) return null;
      const head = (await client.query<{ property_id: string; property_name: string }>(
        `SELECT property_id::text, property_name FROM app.b023_owner_message_threads($1) WHERE property_id=$2`, [session.orgId, propertyId])).rows[0];
      if (!head) return null;
      const messages = (await client.query<OwnerThreadMessage>(
        `SELECT message_id::text, sender, body, created_at::text, edited FROM app.b023_owner_thread_messages($1,$2)`, [session.orgId, propertyId])).rows;
      return { ...head, messages };
    }, scope(session), { isolation: "repeatable read", readOnly: true });
  } catch { return null; }
}

/** Idempotent by requestId. Text only. */
export async function postOwnerMessage(session: Session, input: PostOwnerMessageInput): Promise<OwnerWriteResult> {
  if (!ownerWriter(session) || !input || !isUuid(input.propertyId) || !isUuid(input.requestId)) return unavailable;
  try {
    return await tx(session.userId, async client => {
      if (!await ownerPortalExtensionsEnabled(client, session.orgId) || !await currentSession(client, session)) return unavailable;
      const body = ownerText(input.body);
      if (!body) return { state: "invalid" };
      const raw = (await client.query<{ result: unknown }>(`SELECT app.b023_post_owner_message($1,$2,$3,$4,$5) AS result`,
        [session.orgId, session.sessionId, input.propertyId, input.requestId, body])).rows[0]?.result;
      return writeResult(raw, "messageId");
    }, scope(session));
  } catch { return unavailable; }
}

/**
 * Staff read-only surfaces, existing permissions only: owner threads for the staff
 * inbox (messages.send) and owner lifecycle replies on a lease (leases.edit, the
 * B-012 management roles). Flag OFF ⇒ null after one flag read, no app.b023_ call,
 * nothing rendered. The existing lease-thread inbox query is not touched.
 */
function staffCan(s: Session, key: "messages.send" | "leases.edit") {
  return s.kind === "staff" && [s.userId, s.orgId].every(isUuid) && ["live", "sandbox"].includes(s.environment) && can(s.role, key);
}
export async function staffOwnerThreads(session: Session): Promise<StaffOwnerThreadRow[] | null> {
  if (!staffCan(session, "messages.send")) return null;
  try {
    return await tx(session.userId, async client => {
      if (!await ownerPortalExtensionsEnabled(client, session.orgId)) return null;
      return (await client.query<StaffOwnerThreadRow>(
        `SELECT thread_id::text, property_id::text, property_name, owner_name, last_message_at::text, preview FROM app.b023_staff_owner_threads($1)`,
        [session.orgId])).rows;
    }, requireOrgScope(session), { isolation: "repeatable read", readOnly: true });
  } catch { return null; }
}
export async function staffOwnerLifecycleReplies(session: Session, leaseId: string): Promise<StaffOwnerLifecycleReply[] | null> {
  if (!staffCan(session, "leases.edit") || !isUuid(leaseId)) return null;
  try {
    return await tx(session.userId, async client => {
      if (!await ownerPortalExtensionsEnabled(client, session.orgId)) return null;
      return (await client.query<StaffOwnerLifecycleReply>(
        `SELECT reply_id::text, record_id::text, notice_version, notice_kind, owner_name, body, created_at::text
           FROM app.b023_staff_owner_lifecycle_replies($1,$2)`, [session.orgId, leaseId])).rows;
    }, requireOrgScope(session), { isolation: "repeatable read", readOnly: true });
  } catch { return null; }
}

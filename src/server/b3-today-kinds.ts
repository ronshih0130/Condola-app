import type { Client } from "pg";
import { BANK_ADMISSION_SQL_FOR_TEST } from "./b3-bank-month";
import { brandV3ReadForOrg } from "./brand-v3";
import { guardEffectiveSession, withEffectiveReadAuthority } from "./b017-custom-role-governance";
import { tx } from "./db";
import { FlowError } from "./errors";
import { requireOrgScope } from "./org-guard";
import { assertPerm, type PermKey } from "./perms";
import { tenantThreadCreateOn } from "./tenant-thread";
import type { Session } from "./types";

/**
 * MGT-148 今天 kinds that have an existing data source (T-ROWS-2). Rollout per dashboard-target.md §3 and
 * MGT-95-AC10: 待對帳 and 月結 are v1 items under today_dash (待對帳 also needs bank_matching, its capability);
 * 待你回覆 is a target item behind its own flag today_dash_msg_reply, default OFF. OFF is an absent row, never a zero.
 * Readers throw on failure: readTodayTurn maps forbidden to off and every other error to unavailable.
 */
export const TODAY_KIND_FLAGS = { reply: "today_dash_msg_reply" } as const;
export type TodayBank = { state: "off" } | { state: "ready"; count: number; oldestMonth: string | null; since: string | null };
export type TodayMonthClose = { state: "off" } | { state: "ready"; row: null | { period: string; month: number; owners: number; since: string } };
export type TodayReply = { state: "off" } | { state: "ready"; threads: number; oldest: string | null };
type Deps = { v3?: (orgId: string) => Promise<boolean>; transaction?: typeof tx; now?: () => Date };

type NativeRole = "admin" | "manager" | "accountant";
const v3On = (session: Session, deps: Deps) => (deps.v3 ?? brandV3ReadForOrg)(session.orgId);
/** After the caller's literal guards (B-017 scan): one read-only repeatable-read snapshot under every key's authority. */
async function readKind<T>(admitted: Session, keys: [PermKey, ...PermKey[]], roles: NativeRole[], deps: Deps,
  read: (client: Client, admitted: Session) => Promise<T>): Promise<T> {
  if (admitted.kind !== "staff" || admitted.needsSandbox) throw new FlowError("errors.forbidden");
  return (deps.transaction ?? tx)(admitted.userId, async client => {
    await client.query("SET LOCAL statement_timeout = '2s'");
    const within = (index: number): Promise<T> => index < keys.length
      ? withEffectiveReadAuthority(client, admitted, keys[index], () => within(index + 1))
      : (async () => {
        const staff = await client.query<{ ok: boolean | null }>("SELECT app.has_role($1::uuid, $2::org_role[]) AS ok", [admitted.orgId, roles]);
        if (staff.rows[0]?.ok !== true) throw new FlowError("errors.forbidden");
        return read(client, admitted);
      })();
    return within(0);
  }, requireOrgScope(admitted), { isolation: "repeatable read", readOnly: true });
}

/** 待對帳 (P-ADM, P-ACC): imported lines still to review on unarchived accounts, all months, as on R1-BANK. */
export const TODAY_BANK_SQL_FOR_TEST = `SELECT count(*)::int AS count, to_char(min(b.posted_on), 'YYYY-MM') AS "oldestMonth",
  to_char(min(b.posted_on), 'YYYY-MM-DD') AS since
 FROM bank_transactions b JOIN bank_accounts a ON a.org_id = b.org_id AND a.id = b.bank_account_id
 WHERE b.org_id = $1 AND a.archived_at IS NULL AND b.status IN ('unmatched','suggested')`;
export async function todayBankTurn(session: Session, deps: Deps = {}): Promise<TodayBank> {
  if (!(await v3On(session, deps))) return { state: "off" };
  const viewer = await guardEffectiveSession(session, "bank.reconcile");
  assertPerm(viewer, "bank.reconcile");
  return readKind(viewer, ["bank.reconcile"], ["admin", "accountant"], deps, async (client, admitted) => {
    const admission = (await client.query<{ valid_scope: boolean; valid_session: boolean; enabled: boolean }>(BANK_ADMISSION_SQL_FOR_TEST,
      [admitted.orgId, admitted.sessionId, admitted.userId, admitted.environment, admitted.liveOrgId])).rows[0];
    if (!admission?.valid_scope || !admission.valid_session) throw new FlowError("errors.forbidden");
    if (!admission.enabled) return { state: "off" as const };
    const row = (await client.query<{ count: number; oldestMonth: string | null; since: string | null }>(TODAY_BANK_SQL_FOR_TEST, [admitted.orgId])).rows[0];
    if (!row) throw new Error("Missing bank count");
    return { state: "ready" as const, count: row.count, oldestMonth: row.oldestMonth, since: row.since };
  });
}

/**
 * 月結 (P-ADM, P-ACC): after the 5th (organization calendar) last month has no month_closes row. {k} is the owners
 * still without a non-void statement for that month, the same population as the statement roster's pending rows.
 */
export const TODAY_MONTH_CLOSE_SQL_FOR_TEST = `WITH cal AS (
  SELECT (coalesce($2::timestamptz, clock_timestamp()) AT TIME ZONE o.timezone)::date AS today FROM organizations o WHERE o.id = $1
), prev AS (SELECT today, (date_trunc('month', today) - interval '1 month')::date AS period FROM cal)
SELECT to_char(prev.period, 'YYYY-MM') AS period, extract(day FROM prev.today)::int > 5 AS due,
  EXISTS (SELECT 1 FROM month_closes m WHERE m.org_id = $1 AND m.period_month = prev.period) AS closed,
  (SELECT count(*)::int FROM contacts c WHERE c.org_id = $1 AND c.is_owner AND c.archived_at IS NULL
     AND EXISTS (SELECT 1 FROM property_owners po WHERE po.org_id = $1 AND po.owner_contact_id = c.id)
     AND NOT EXISTS (SELECT 1 FROM owner_statements s WHERE s.org_id = $1 AND s.owner_contact_id = c.id
       AND s.period_start = prev.period AND s.status <> 'void')) AS owners,
  to_char((date_trunc('month', prev.today))::date, 'YYYY-MM-DD') AS since
 FROM prev`;
export async function todayMonthCloseTurn(session: Session, deps: Deps = {}): Promise<TodayMonthClose> {
  if (!(await v3On(session, deps))) return { state: "off" };
  let viewer = await guardEffectiveSession(session, "month.close");
  assertPerm(viewer, "month.close");
  viewer = await guardEffectiveSession(viewer, "stmt.view");
  assertPerm(viewer, "stmt.view");
  return readKind(viewer, ["month.close", "stmt.view"], ["admin", "accountant"], deps, async (client, admitted) => {
    const row = (await client.query<{ period: string; due: boolean; closed: boolean; owners: number; since: string }>(
      TODAY_MONTH_CLOSE_SQL_FOR_TEST, [admitted.orgId, deps.now ? deps.now().toISOString() : null])).rows[0];
    if (!row || !/^\d{4}-\d{2}$/.test(row.period)) throw new Error("Missing month-close calendar");
    // The approved line is 「{月} 月還沒月結・{k} 位屋主在等報表」; k = 0 has no frame (GS-44), so that case has no row.
    return { state: "ready" as const, row: row.due && !row.closed && row.owners > 0
      ? { period: row.period, month: Number(row.period.slice(5)), owners: row.owners, since: row.since } : null };
  });
}

/**
 * 待你回覆 (P-ADM, P-MGR; MGT-105-AC1): lease threads whose last non-deleted, non-system message came from a
 * tenant (primary or co-tenant) of that lease, so no later staff reply exists. Reading a thread does not clear it. One summary row.
 */
export const TODAY_REPLY_SQL_FOR_TEST = `WITH last AS (
  SELECT t.id, t.lease_id, m.sender_contact_id, m.created_at
    FROM message_threads t
    JOIN LATERAL (SELECT x.sender_contact_id, x.created_at FROM messages x
      WHERE x.org_id = t.org_id AND x.thread_id = t.id AND x.deleted_at IS NULL
        AND (x.sender_contact_id IS NOT NULL OR x.sender_member_id IS NOT NULL)
      ORDER BY x.created_at DESC, x.id DESC LIMIT 1) m ON true
   WHERE t.org_id = $1 AND t.kind = 'lease'
)
SELECT count(*)::int AS threads,
  to_char(min(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS oldest
 FROM last
 WHERE sender_contact_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM lease_parties lp WHERE lp.org_id = $1 AND lp.lease_id = last.lease_id AND lp.contact_id = last.sender_contact_id
     AND lp.role IN ('primary','co_tenant'))`;
export async function todayReplyTurn(session: Session, deps: Deps = {}): Promise<TodayReply> {
  if (!(await v3On(session, deps))) return { state: "off" };
  const viewer = await guardEffectiveSession(session, "messages.send");
  assertPerm(viewer, "messages.send");
  return readKind(viewer, ["messages.send"], ["admin", "manager"], deps, async (client, admitted) => {
    const gates = (await client.query<{ flags: unknown; thread: unknown }>(
      "SELECT feature_flags AS flags, (SELECT value FROM platform_settings WHERE key = 'tenant_thread_create') AS thread FROM organizations WHERE id = $1",
      [admitted.orgId])).rows[0];
    if (!gates) throw new Error("Missing Today organization");
    // MGT-105-AC5: also absent unless the B-019 tenant-thread path is on for the org.
    const flags = gates.flags && typeof gates.flags === "object" && !Array.isArray(gates.flags) ? gates.flags as Record<string, unknown> : {};
    if (flags[TODAY_KIND_FLAGS.reply] !== true || !tenantThreadCreateOn(gates.thread, gates.flags, admitted.orgId)) return { state: "off" as const };
    const row = (await client.query<{ threads: number; oldest: string | null }>(TODAY_REPLY_SQL_FOR_TEST, [admitted.orgId])).rows[0];
    if (!row) throw new Error("Missing reply count");
    return { state: "ready" as const, threads: row.threads, oldest: row.oldest };
  });
}

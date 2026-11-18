import {
  AUDIT_PAGE_SIZE,
  AUDIT_SELECT,
  AUDIT_TABLES,
  decodeCursor,
  lookupRecords,
  maskAuditText,
  presentAudit,
  recordKey,
  sensitiveColumn,
  summarizeChanges,
  taipeiRange,
  type AuditActor,
  type AuditTable,
  type RawAudit,
  type RecordHit,
} from "./audit-read";
import { logServerError } from "./errors";
import { formatDate, moneyLabel } from "./format";
import { requireOrgScope } from "./org-guard";
import { dictionary, makeT, type Locale } from "../i18n";
import { brandV3AuditCopy } from "../i18n/lanes/brand-v3-r5-audit";
import { displaySampleName } from "../sample-name";
import type { Session } from "./types";

/**
 * B-073 / R5-AUDIT (設定 › 操作紀錄, the company-wide part of MGT-136: AC2, AC3 company log, AC4, AC5). Admin only,
 * exactly as today's `/m/audit` reader (`audit-read.ts`): the same role check, the same `audit_log` RLS policy
 * (`audit_read` + the B-017 restrictive floor), the same org scope, record names and masking. Filters are person,
 * Taipei calendar days and item; 25 a page, newest first, keyset pages both ways (下一頁 / 上一頁).
 *
 * Plain entries (「{誰}把{什麼}從 {舊} 改成 {新}」) only for an update that changed exactly one named, non-sensitive
 * field listed in PLAIN_FIELDS; Postgres returns only that field's two values, never a row snapshot. Every other
 * entry keeps today's labels (action, fields, record), as on the flag-OFF page.
 */

/** Item filter. 租約・繳款・單位 are the frame's three kinds; every other audited table keeps today's record name. */
const GROUPS: { id: "lease" | "payment" | "unit"; tables: AuditTable[] }[] = [
  { id: "lease", tables: ["leases", "lease_parties", "lease_charges", "lease_signatures"] },
  { id: "payment", tables: ["payments", "payment_allocations"] },
  { id: "unit", tables: ["units", "rooms"] },
];
const GROUPED = new Set<string>(GROUPS.flatMap(group => group.tables));
export type AuditV3Item = { id: string; tables: AuditTable[] };
export const AUDIT_V3_ITEMS: AuditV3Item[] = [
  ...GROUPS,
  ...AUDIT_TABLES.filter(table => !GROUPED.has(table)).map(table => ({ id: table, tables: [table] })),
];
const ITEM_BY_TABLE = new Map<string, string>(AUDIT_V3_ITEMS.flatMap(item => item.tables.map(table => [table, item.id] as const)));
export const itemOfTable = (table: string) => ITEM_BY_TABLE.get(table) ?? null;

/** The item's name: the frame's word for the three kinds, else today's record name (contacts by tenant/owner hit). */
export function itemLabel(locale: Locale, id: string, hit?: RecordHit | null) {
  const c = brandV3AuditCopy(locale);
  if (id === "lease") return c.itemLease;
  if (id === "payment") return c.itemPayment;
  if (id === "unit") return c.itemUnit;
  return makeT(locale)(recordKey(id, hit ?? undefined));
}

type ValueKind = "money" | "date" | "day" | "status" | "text" | "role";
/** `table.column` → how its old and new values are written. Named, non-sensitive columns only (asserted below). */
export const PLAIN_FIELDS: Readonly<Record<string, ValueKind>> = {
  "leases.rent_amount_minor": "money",
  "leases.deposit_amount_minor": "money",
  "leases.start_date": "date",
  "leases.end_date": "date",
  "leases.due_day": "day",
  "leases.status": "status",
  "payments.status": "status",
  "maintenance_tickets.status": "status",
  "properties.name": "text",
  "units.label": "text",
  "rooms.label": "text",
  "contacts.display_name": "text",
  "org_members.role": "role",
};
for (const key of Object.keys(PLAIN_FIELDS)) {
  const column = key.split(".")[1];
  if (sensitiveColumn(column) || summarizeChanges([column]).fields.length !== 1) throw new Error(`R5-AUDIT: ${key} is not a named field`);
}
/** Today's catalog names for stored status values; a value without one is not written in plain words. */
const STATUS_KEYS: Record<string, Record<string, string>> = {
  leases: { draft: "i_st_draft", pending_signature: "i_st_pending", active: "i_st_active", ended: "i_st_ended", terminated: "i_st_terminated", cancelled: "i_st_cancelled" },
  maintenance_tickets: { open: "i_st_open", triaged: "i_st_triaged", assigned: "i_st_assigned", in_progress: "i_st_progress", on_hold: "i_st_hold", resolved: "i_st_resolved", closed: "i_st_closed" },
  payments: { submitted: "i_pay_submitted", confirmed: "i_pay_confirmed", rejected: "i_pay_rejected" },
};
const ROLE_KEYS: Record<string, string> = { admin: "i_role_admin", manager: "i_role_manager", accountant: "i_role_accountant", maintenance: "i_role_maintenance" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export type AuditV3Query = { user?: string; from?: string; to?: string; item?: string; record?: string; cursor?: string; before?: string };
export type AuditV3Filters = { actorId: string | null; from: string | null; to: string | null; item: string | null; cursor: string | null; before: string | null };

/** Unknown or malformed values are dropped (first page, no filter). `record` (today's table filter) maps to its item. */
export function parseAuditV3(input: AuditV3Query): AuditV3Filters {
  const one = (value: unknown) => typeof value === "string" ? value : undefined;
  const user = one(input.user), from = one(input.from), to = one(input.to), item = one(input.item), record = one(input.record);
  const cursor = one(input.cursor), before = one(input.before);
  const known = item && AUDIT_V3_ITEMS.some(entry => entry.id === item) ? item : null;
  const olderOk = !!cursor && !!decodeCursor(cursor);
  return {
    actorId: user && UUID.test(user) ? user : null,
    from: from && DAY.test(from) ? from : null,
    to: to && DAY.test(to) ? to : null,
    item: known ?? (record ? itemOfTable(record) : null),
    cursor: olderOk ? cursor! : null,
    before: !olderOk && before && decodeCursor(before) ? before : null,
  };
}

export const AUDIT_V3_HREF = "/m/audit";
/** The page URL for these filters; `page` picks 下一頁 (`cursor`) or 上一頁 (`before`); none = the first page. */
export function auditV3Href(filters: AuditV3Filters, page: { cursor?: string | null; before?: string | null } = {}) {
  const params = new URLSearchParams();
  if (filters.actorId) params.set("user", filters.actorId);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.item) params.set("item", filters.item);
  if (page.cursor) params.set("cursor", page.cursor);
  else if (page.before) params.set("before", page.before);
  const query = params.toString();
  return query ? `${AUDIT_V3_HREF}?${query}` : AUDIT_V3_HREF;
}
export const filtered = (filters: AuditV3Filters) => !!(filters.actorId || filters.from || filters.to || filters.item || filters.cursor || filters.before);

export type AuditV3PageInput = {
  orgId: string;
  actorId: string | null;
  tables: string[] | null;
  from: string | null;
  to: string | null;
  cursor: { at: string; id: string } | null;
  /** older: rows before the cursor, newest first (下一頁). newer: rows after it, oldest first (上一頁). */
  direction: "older" | "newer";
  limit: number;
};

const PLAIN_KEYS = Object.keys(PLAIN_FIELDS);
/**
 * One page with today's columns plus, for a one-field update in PLAIN_FIELDS only, that field's old and new value
 * (and the row's currency code for money). Predicates are appended only when set.
 */
export function auditV3PageQuery(input: AuditV3PageInput) {
  const params: unknown[] = [input.orgId];
  const where = ["a.org_id = $1"];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace("?", `$${params.length}`));
  };
  if (input.actorId) add("a.actor_user_id = ?::uuid", input.actorId);
  if (input.tables) add("a.table_name = ANY(?::text[])", input.tables);
  if (input.from) add("a.occurred_at >= ?::timestamptz", input.from);
  if (input.to) add("a.occurred_at < ?::timestamptz", input.to);
  const newer = input.direction === "newer";
  if (input.cursor) {
    params.push(input.cursor.at, input.cursor.id);
    where.push(`(a.occurred_at, a.id) ${newer ? ">" : "<"} ($${params.length - 1}::timestamptz, $${params.length}::bigint)`);
  }
  params.push(PLAIN_KEYS);
  const plain = params.length;
  params.push(Math.max(1, Math.min(AUDIT_PAGE_SIZE + 1, Math.floor(input.limit) || 1)));
  const order = newer ? "ASC" : "DESC";
  const sql = `${AUDIT_SELECT},
       v.col AS plain_col,
       v.old_value AS plain_old,
       v.new_value AS plain_new,
       v.currency AS plain_currency
  FROM audit_log a
  LEFT JOIN profiles p ON p.id = a.actor_user_id
  LEFT JOIN LATERAL (
    SELECT x.col,
           left(a.old_row ->> x.col, 200) AS old_value,
           left(a.new_row ->> x.col, 200) AS new_value,
           btrim(coalesce(a.new_row ->> 'currency', a.old_row ->> 'currency')) AS currency
      FROM (SELECT c.cols[1] AS col, cardinality(c.cols) AS n
              FROM (SELECT array_remove(array_remove(a.changed_cols, 'updated_at'), 'created_at') AS cols) c) x
     WHERE a.action = 'update' AND x.n = 1 AND (a.table_name || '.' || x.col) = ANY($${plain}::text[])
  ) v ON true
 WHERE ${where.join("\n   AND ")}
 ORDER BY a.occurred_at ${order}, a.id ${order}
 LIMIT $${params.length}`;
  return { sql, params, order };
}

/** The page and today's member filter list in one statement (as `auditScreenQuery`). */
export function auditV3ScreenQuery(input: AuditV3PageInput) {
  const page = auditV3PageQuery(input);
  const sql = `SELECT COALESCE((
      SELECT json_agg((to_jsonb(s) - 'ord') ORDER BY s.ord)
        FROM (
          SELECT q.*, row_number() OVER (ORDER BY q.occurred_at ${page.order}, q.id::bigint ${page.order}) AS ord
            FROM (${page.sql}) q
        ) s
    ), '[]'::json) AS page,
    COALESCE((
      SELECT json_agg(json_build_object(
               'id', m.user_id::text,
               'name', coalesce(nullif(btrim(p.display_name), ''), '')
             ) ORDER BY coalesce(nullif(btrim(p.display_name), ''), ''), m.user_id)
        FROM org_members m
        LEFT JOIN profiles p ON p.id = m.user_id
       WHERE m.org_id = $1 AND m.status = 'active'
    ), '[]'::json) AS actors`;
  return { sql, params: page.params };
}

export type RawAuditV3 = RawAudit & { plain_col?: string | null; plain_old?: string | null; plain_new?: string | null; plain_currency?: string | null };

export type AuditV3Plain = { record: string; field: string; from: string; to: string; quoted: boolean };
export type AuditV3Legacy = { action: string; fields: string[]; masked: string | null; record: string };
export type AuditV3Entry = {
  key: string;
  who: string;
  item: string;
  when: string;
  reason: string;
  plain: AuditV3Plain | null;
  legacy: AuditV3Legacy | null;
};

/** Taipei time as the frame writes it: 「11/14 15:02」 this year, with the year otherwise. */
export function auditV3When(taipei: string, now: number) {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2})$/.exec(taipei);
  if (!match) return taipei;
  const year = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric" }).format(new Date(now));
  return match[1] === year ? `${match[2]}/${match[3]} ${match[4]}` : `${match[1]}/${match[2]}/${match[3]} ${match[4]}`;
}

function plainValue(kind: ValueKind, table: string, value: string | null | undefined, currency: string | null | undefined, session: Pick<Session, "locale" | "calendar">) {
  if (value == null || value === "") return null;
  const t = makeT(session.locale);
  if (kind === "money") return /^\d{1,15}$/.test(value) && currency && /^[A-Z]{3}$/.test(currency) ? moneyLabel(value, currency, session.locale) : null;
  if (kind === "date") return DAY.test(value) ? formatDate(value, session.locale, session.calendar, dictionary(session.locale)) || null : null;
  if (kind === "day") return /^\d{1,2}$/.test(value) ? value : null;
  if (kind === "status") { const key = STATUS_KEYS[table]?.[value]; return key ? t(key) : null; }
  if (kind === "role") { const key = ROLE_KEYS[value]; return key ? t(key) : null; }
  const text = displaySampleName(maskAuditText(value).text);
  return text || null;
}

/** One entry: plain words when PLAIN_FIELDS covers it and both values can be written; otherwise today's labels. */
export function presentAuditV3(row: RawAuditV3, hit: RecordHit | null, session: Pick<Session, "locale" | "calendar">, now: number): AuditV3Entry {
  const t = makeT(session.locale);
  const view = presentAudit(row, hit);
  const who = view.who || (view.whoKey ? t(view.whoKey) : "");
  const recordText = view.recordText ? displaySampleName(view.recordText) : "";
  const item = itemLabel(session.locale, itemOfTable(row.table_name) ?? row.table_name, hit);
  const base = { key: view.cursor, who, item, when: auditV3When(view.when, now), reason: view.reason };
  const kind = row.plain_col ? PLAIN_FIELDS[`${row.table_name}.${row.plain_col}`] : undefined;
  const changes = summarizeChanges(row.changed_cols);
  if (kind && changes.fields.length === 1 && !changes.other && !changes.masked) {
    const from = plainValue(kind, row.table_name, row.plain_old, row.plain_currency, session);
    const to = plainValue(kind, row.table_name, row.plain_new, row.plain_currency, session);
    if (from && to && from !== to)
      return { ...base, plain: { record: recordText || t(view.recordKey), field: t(changes.fields[0]), from, to, quoted: kind === "status" || kind === "role" || kind === "text" }, legacy: null };
  }
  const fields = [...view.fields.map(key => t(key)), ...(view.other ? [t("i_audit_f_other")] : [])];
  const record = `${t(view.recordKey)}${recordText ? ` ${recordText}` : ""}${view.found ? "" : ` ${t("i_audit_deleted")}`}`;
  return { ...base, plain: null, legacy: { action: t(view.actionKey), fields, masked: view.masked ? t("i_audit_masked") : null, record } };
}

export type AuditV3Page = {
  entries: AuditV3Entry[];
  actors: AuditActor[];
  filters: AuditV3Filters;
  /** 下一頁: the cursor after the last entry. */
  next: string | null;
  /** 上一頁: a `before` cursor, "" for the first page, null on the first page itself. */
  prev: string | null;
};
export type AuditV3Read = { state: "forbidden" | "unavailable" } | ({ state: "ready" } & AuditV3Page);

type Loaded = { rows: RawAuditV3[]; actors: AuditActor[]; hits: Map<string, RecordHit> };
type Deps = { load?: (session: Session, input: AuditV3PageInput) => Promise<Loaded>; now?: () => number };

function asJson<T>(value: T | string): T {
  return typeof value === "string" ? (JSON.parse(value) as T) : value;
}

/** Owning read: the session's own transaction under RLS, org-scoped, as `loadAuditScreen`. */
async function dbLoad(session: Session, input: AuditV3PageInput): Promise<Loaded> {
  const { many, tx } = await import("./db");
  return tx(session.userId, async client => {
    const built = auditV3ScreenQuery(input);
    const [bundle] = await many<{ page: RawAuditV3[] | string; actors: AuditActor[] | string }>(client, built.sql, built.params);
    const rows = asJson<RawAuditV3[]>(bundle?.page ?? []).map(row => ({
      ...row,
      id: String(row.id),
      actor_name: row.actor_name ?? "",
      has_actor: Boolean(row.has_actor),
      changed_cols: Array.isArray(row.changed_cols) ? row.changed_cols : null,
      reason: row.reason ?? null,
      event_type: row.event_type ?? null,
    }));
    const page = rows.slice(0, AUDIT_PAGE_SIZE);
    const hits = await lookupRecords(client, session.orgId, page);
    return { rows, actors: asJson<AuditActor[]>(bundle?.actors ?? []), hits };
  }, requireOrgScope(session));
}

const forbidden = (error: unknown) =>
  ((error as { code?: string } | null)?.code ?? (error as { cause?: { code?: string } } | null)?.cause?.code) === "42501";

/** Admin only, checked before any read: the same rule as `loadAuditScreen` (custom roles need audit). */
export const auditV3Allowed = (session: Session) => session.kind === "staff" && session.role === "admin" && !(session.customRole && !session.customRole.audit);

export async function auditV3Read(session: Session, query: AuditV3Query, deps: Deps = {}): Promise<AuditV3Read> {
  if (!auditV3Allowed(session)) return { state: "forbidden" };
  const filters = parseAuditV3(query);
  const load = deps.load ?? dbLoad;
  const now = (deps.now ?? Date.now)();
  const range = taipeiRange(filters.from, filters.to);
  const tables = filters.item ? AUDIT_V3_ITEMS.find(item => item.id === filters.item)?.tables ?? null : null;
  const input = (cursor: string | null, direction: AuditV3PageInput["direction"]): AuditV3PageInput => ({
    orgId: session.orgId, actorId: filters.actorId, tables, from: range.start, to: range.end,
    cursor: decodeCursor(cursor), direction, limit: AUDIT_PAGE_SIZE + 1,
  });
  try {
    if (filters.before) {
      const newer = await load(session, input(filters.before, "newer"));
      if (newer.rows.length > AUDIT_PAGE_SIZE) return ready(newer, newer.rows.slice(0, AUDIT_PAGE_SIZE).reverse(), true, false);
      // Not a full page newer than the cursor: 上一頁 has reached the first page, read as the first page.
      const first = await load(session, input(null, "older"));
      return ready(first, first.rows.slice(0, AUDIT_PAGE_SIZE), first.rows.length > AUDIT_PAGE_SIZE, true);
    }
    const page = await load(session, input(filters.cursor, "older"));
    return ready(page, page.rows.slice(0, AUDIT_PAGE_SIZE), page.rows.length > AUDIT_PAGE_SIZE, !filters.cursor);
  } catch (error) {
    if (forbidden(error)) return { state: "forbidden" };
    logServerError("b073_audit_read", error);
    return { state: "unavailable" };
  }

  /** 下一頁 after the last entry when more follow; 上一頁 from page 2 (before the first entry, or the first page). */
  function ready(loaded: Loaded, rows: RawAuditV3[], more: boolean, first: boolean): AuditV3Read {
    const entries = rows.map(row => presentAuditV3(row, loaded.hits.get(`${row.table_name}:${row.row_id}`) ?? null, session, now));
    return {
      state: "ready",
      entries,
      actors: loaded.actors.map(actor => ({ id: actor.id, name: maskAuditText(actor.name ?? "").text })),
      filters,
      next: more && entries.length ? entries[entries.length - 1].key : null,
      prev: first ? null : entries.length ? entries[0].key : "",
    };
  }
}

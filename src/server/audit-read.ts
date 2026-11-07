import type { Locale } from "@/i18n";
import { many, tx } from "./db";
import { formatTaipei } from "./time";
import type { Session } from "./types";
import { requireOrgScope } from "./org-guard";

/**
 * Admin-only read model for audit_log.
 * One indexed page, no OFFSET, and no old_row/new_row so the Worker does not
 * parse full snapshots. The screen is two round trips: the page plus the member
 * list, then one UNION for every record name on that page. Identity numbers and
 * other sensitive values are masked before they leave this module.
 */

export const AUDIT_PAGE_SIZE = 25;
export const AUDIT_HISTORY_SIZE = 8;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const BIGINT = /^\d{1,19}$/;

export const AUDIT_ACTIONS = ["insert", "update", "delete"] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_EVENTS = [
  "sign_in",
  "sign_out",
  "line_sign_in",
  "invite",
  "invite_resend",
  "invite_revoke",
  "invite_accept",
  "portal_invite",
  "portal_invite_accept",
  "role_change",
  "deactivate",
  "reactivate",
  "password_change",
  "password_reset",
  "password_reset_requested",
  "mfa_enabled",
  "mfa_disabled",
  "require_2fa",
  "go_live",
  "firm_created",
  "owner_privacy",
  "repair_dispatch",
  "repair_dispatch_revoke",
  "repair_vendor_report",
  "repair_cost_confirm",
] as const;

export const AUDIT_TABLES = [
  "leases",
  "contacts",
  "properties",
  "units",
  "rooms",
  "property_owners",
  "payments",
  "invoices",
  "owner_statements",
  "maintenance_tickets",
  "org_members",
  "auth_events",
  "identity_documents",
  "lease_signatures",
  "lease_parties",
  "lease_charges",
  "expenses",
  "bank_accounts",
  "ledger_transactions",
  "management_agreements",
  "fee_rules",
  "invitations",
  "organizations",
  "meters",
  "utility_bills",
  "invoice_lines",
  "payment_allocations",
  "owner_statement_lines",
  "rule_check_results",
  "line_account_links",
] as const;

export type AuditTable = (typeof AUDIT_TABLES)[number];

const LOOKUP_TABLES = new Set<string>([
  "leases",
  "contacts",
  "properties",
  "units",
  "rooms",
  "owner_statements",
  "property_owners",
  "lease_signatures",
  "lease_parties",
  "lease_charges",
  "invoices",
  "payments",
  "maintenance_tickets",
  "org_members",
  "ledger_transactions",
  "management_agreements",
]);

const EVENT_KEYS: Record<string, string> = {
  sign_in: "i_audit_ev_sign_in",
  sign_out: "i_audit_ev_sign_out",
  line_sign_in: "i_audit_ev_line_sign_in",
  invite: "i_audit_ev_invite",
  invite_resend: "i_audit_ev_invite_resend",
  invite_revoke: "i_audit_ev_invite_revoke",
  invite_accept: "i_audit_ev_invite_accept",
  portal_invite: "i_audit_ev_portal_invite",
  portal_invite_accept: "i_audit_ev_portal_invite_accept",
  role_change: "i_audit_ev_role_change",
  deactivate: "i_audit_ev_deactivate",
  reactivate: "i_audit_ev_reactivate",
  password_change: "i_audit_ev_password_change",
  password_reset: "i_audit_ev_password_reset",
  password_reset_requested: "i_audit_ev_password_reset_requested",
  mfa_enabled: "i_audit_ev_mfa_enabled",
  mfa_disabled: "i_audit_ev_mfa_disabled",
  require_2fa: "i_audit_ev_require_2fa",
  go_live: "i_audit_ev_go_live",
  firm_created: "i_audit_ev_firm_created",
  owner_privacy: "i_audit_ev_owner_privacy",
  repair_dispatch: "i_audit_ev_repair_dispatch",
  repair_dispatch_revoke: "i_audit_ev_repair_dispatch_revoke",
  repair_vendor_report: "i_audit_ev_repair_vendor_report",
  repair_cost_confirm: "i_audit_ev_repair_cost_confirm",
};

const RECORD_KEYS: Record<string, string> = {
  leases: "i_audit_rec_lease",
  contacts: "i_audit_rec_contact",
  properties: "i_audit_rec_property",
  units: "i_audit_rec_unit",
  rooms: "i_audit_rec_room",
  payments: "i_audit_rec_payment",
  invoices: "i_audit_rec_invoice",
  owner_statements: "i_audit_rec_statement",
  org_members: "i_audit_rec_member",
  auth_events: "i_audit_rec_auth",
  identity_documents: "i_audit_rec_id",
  maintenance_tickets: "i_audit_rec_ticket",
  expenses: "i_audit_rec_expense",
  bank_accounts: "i_audit_rec_bank",
  property_owners: "i_audit_rec_owner_link",
  lease_signatures: "i_audit_rec_signature",
  lease_parties: "i_audit_rec_party",
  lease_charges: "i_audit_rec_charge",
  ledger_transactions: "i_audit_rec_ledger",
  management_agreements: "i_audit_rec_agreement",
  fee_rules: "i_audit_rec_fee",
  invitations: "i_audit_rec_invite",
  organizations: "i_audit_rec_org",
  meters: "i_audit_rec_meter",
  utility_bills: "i_audit_rec_bill",
  invoice_lines: "i_audit_rec_invoice_line",
  payment_allocations: "i_audit_rec_allocation",
  owner_statement_lines: "i_audit_rec_statement_line",
  rule_check_results: "i_audit_rec_rule",
  line_account_links: "i_audit_rec_line",
};

const FIELD_KEYS: Record<string, string> = {
  status: "i_audit_f_status",
  display_name: "i_audit_f_name",
  name: "i_audit_f_name",
  address_display: "i_audit_f_address",
  rent_amount_minor: "i_audit_f_rent",
  deposit_amount_minor: "i_audit_f_deposit",
  deposit_months: "i_audit_f_deposit",
  start_date: "i_audit_f_start",
  end_date: "i_audit_f_end",
  role: "i_audit_f_role",
  due_day: "i_audit_f_due",
  currency: "i_audit_f_currency",
  label: "i_audit_f_label",
  rental_mode: "i_audit_f_mode",
  notes: "i_audit_f_notes",
};

const SENSITIVE_COLUMN =
  /(hash|token|secret|password|phone|email|tax_id|storage|encrypt|passport|national|number_masked|number_hash|legal_name|bank_account|account_number|code_hash|einvoice_)/i;

/** Columns the screen is allowed to name. Everything else is omitted or masked. */
export function sensitiveColumn(column: string) {
  if (column === "id" || column.endsWith("_id")) return true;
  if (FIELD_KEYS[column]) return false;
  return SENSITIVE_COLUMN.test(column);
}

export function summarizeChanges(columns: string[] | null) {
  const fields: string[] = [];
  let masked = false;
  let other = false;
  for (const column of columns ?? []) {
    if (column === "updated_at" || column === "created_at") continue;
    if (sensitiveColumn(column)) {
      masked = true;
      continue;
    }
    const key = FIELD_KEYS[column];
    if (key) {
      if (!fields.includes(key)) fields.push(key);
    } else other = true;
  }
  return { fields, masked, other };
}

const MASK = "••••••••••";
const BIGINT_MAX = BigInt("9223372036854775807");
/**
 * One Taiwan number: +886 (optional trunk 0), a parenthesized area code, or a local 0-prefix.
 * A separator is optional and only one character, so the next number in the same sentence stays intact.
 */
const PHONE =
  /\+\s*886[ \t().-]*0?(?:[ \t().-]?\d){8,10}(?!\d)|\(\s*0\d{1,3}\s*\)[ \t.-]*(?:\d[ \t.-]?){5,8}\d(?!\d)|\b0\d(?:[ \t().-]?\d){7,9}(?!\d)/g;

function taiwanPhone(raw: string) {
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("886")) {
    digits = digits.slice(3);
    if (!digits.startsWith("0")) digits = `0${digits}`;
  }
  if (/^09\d{8}$/.test(digits)) return true;
  return /^0[2-8]\d{7,8}$/.test(digits);
}

/** A cursor timestamp Postgres can cast to timestamptz. Digit shape alone is not enough. */
function cursorInstant(at: string) {
  if (!CURSOR_AT.test(at)) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{6}Z$/.exec(at);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return false;
  const parsed = new Date(at);
  if (Number.isNaN(parsed.getTime())) return false;
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() + 1 === month &&
    parsed.getUTCDate() === day &&
    parsed.getUTCHours() === hour &&
    parsed.getUTCMinutes() === minute &&
    parsed.getUTCSeconds() === second
  );
}

function cursorId(id: string) {
  if (!BIGINT.test(id)) return false;
  return BigInt(id) <= BIGINT_MAX;
}

/** Hide identity numbers, phone numbers, emails, and UUIDs inside free text. */
export function maskAuditText(value: string) {
  let masked = false;
  let text = value;
  const apply = (pattern: RegExp) => {
    text = text.replace(pattern, () => {
      masked = true;
      return MASK;
    });
  };
  apply(/[A-Z][1289]\d{8}/gi);
  apply(/[A-Z]{2}\d{8}/gi);
  apply(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi);
  PHONE.lastIndex = 0;
  text = text.replace(PHONE, (match, offset, whole) => {
    const before = offset > 0 ? whole[offset - 1] : "";
    const after = whole[offset + match.length] ?? "";
    if (/\d/.test(before) || /\d/.test(after) || !taiwanPhone(match)) return match;
    masked = true;
    return MASK;
  });
  apply(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g);
  return { text: text.replace(/[ \t]{2,}/g, " ").trim(), masked };
}

/**
 * B-031 width folding, mirroring app.b031_fold_width: a character whose NFKC form is
 * one ASCII letter, digit, @ or + becomes that form. Chinese punctuation is kept.
 */
export function foldWidth(value: string) {
  return Array.from(value, (char) => {
    const folded = char.normalize("NFKC");
    return /^[0-9A-Za-z@+]$/.test(folded) ? folded : char;
  }).join("");
}

const SEP = "[- ().．（）－　]";
const TOK = "[A-Za-z0-9_+/=.-]";
const DETAIL_RULES: [RegExp, string][] = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, MASK],
  [/[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/g, MASK],
  [new RegExp(`(?<![A-Za-z])[A-Za-z]${SEP}?[1289](${SEP}?[0-9]){8}`, "g"), MASK],
  [new RegExp(`(?<![A-Za-z])[A-Za-z]{2}(${SEP}?[0-9]){8}`, "g"), MASK],
  [new RegExp(`(^|[^A-Za-z0-9_+/=.-])(?=${TOK}*[0-9])(?=${TOK}*[A-Za-z])${TOK}{16,}(?!${TOK})`, "g"), `$1${MASK}`],
  [new RegExp(`(?<![0-9])[+(（]?[0-9](${SEP}{0,2}[0-9]){9,}(?![0-9])`, "g"), MASK],
  [new RegExp(`(\\+${SEP}?886|(?<![0-9A-Za-z])\\(?0)${SEP}{0,2}[0-9](${SEP}{0,2}[0-9]){6,9}(?![0-9])`, "g"), MASK],
];

/**
 * Detail text masking: the same rules, in the same order, as app.b031_mask_text
 * (the write side is authoritative; this is defence in depth), then maskAuditText.
 * Snake_case reason codes and ordinary words contain no digit and are never masked
 * as tokens. Used only for AUDIT_DETAIL values; the OFF page keeps maskAuditText.
 */
export function maskDetailText(value: string) {
  const original = foldWidth(value);
  let text = original;
  for (const [pattern, replacement] of DETAIL_RULES) text = text.replace(pattern, replacement);
  const rest = maskAuditText(text);
  return { text: rest.text, masked: rest.masked || text !== original };
}

export function encodeCursor(at: string, id: string) {
  return Buffer.from(`${at}\n${id}`, "utf8").toString("base64url");
}

export function decodeCursor(value: string | null | undefined) {
  if (!value || value.length > 200) return null;
  let text = "";
  try {
    text = Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const split = text.indexOf("\n");
  if (split < 0) return null;
  const at = text.slice(0, split);
  const id = text.slice(split + 1);
  if (!cursorInstant(at) || !cursorId(id)) return null;
  return { at, id };
}

function taipeiDay(day: string | null) {
  if (!day || !DAY.test(day)) return null;
  const parsed = new Date(`${day}T00:00:00+08:00`);
  if (Number.isNaN(parsed.getTime())) return null;
  const formatted = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(parsed);
  return formatted === day ? parsed : null;
}

/** Inclusive start and exclusive end of calendar days in Asia/Taipei. */
export function taipeiRange(from: string | null, to: string | null) {
  const start = taipeiDay(from);
  const end = taipeiDay(to);
  return {
    start: start ? start.toISOString() : null,
    end: end ? new Date(end.getTime() + 86_400_000).toISOString() : null,
  };
}

export type AuditFilters = {
  actorId: string | null;
  action: AuditAction | null;
  eventType: string | null;
  tableName: AuditTable | null;
  from: string | null;
  to: string | null;
  cursor: string | null;
};

export function parseAuditFilters(input: {
  user?: string;
  action?: string;
  record?: string;
  from?: string;
  to?: string;
  cursor?: string;
}): AuditFilters {
  const action = AUDIT_ACTIONS.find((item) => item === input.action) ?? null;
  const eventType = AUDIT_EVENTS.find((item) => item === input.action) ?? null;
  const tableName = AUDIT_TABLES.find((item) => item === input.record) ?? null;
  return {
    actorId: input.user && UUID.test(input.user) ? input.user : null,
    action: eventType ? null : action,
    eventType,
    tableName,
    from: input.from && DAY.test(input.from) ? input.from : null,
    to: input.to && DAY.test(input.to) ? input.to : null,
    cursor: decodeCursor(input.cursor) ? input.cursor ?? null : null,
  };
}

export function recordKey(table: string, kind?: { tenant?: boolean; owner?: boolean }) {
  if (table === "contacts") {
    if (kind?.tenant && !kind.owner) return "i_audit_rec_tenant";
    if (kind?.owner && !kind.tenant) return "i_audit_rec_owner";
    return "i_audit_rec_contact";
  }
  return RECORD_KEYS[table] ?? "i_audit_rec_other";
}

export function recordHref(table: string, id: string, kind?: { tenant?: boolean; owner?: boolean; whole?: boolean }) {
  if (!UUID.test(id)) return null;
  if (table === "leases") return `/m/leases/${id}`;
  if (table === "properties") return `/m/properties/${id}`;
  if (table === "contacts" && kind?.tenant) return `/m/tenants/${id}`;
  if (table === "contacts" && kind?.owner) return `/m/owners/${id}`;
  if (table === "rooms") return `/m/units/room/${id}`;
  if (table === "units" && kind?.whole) return `/m/units/whole/${id}`;
  if (table === "owner_statements") return `/m/statements/${id}`;
  return null;
}

export type RecordHit = {
  text: string;
  tenant?: boolean;
  owner?: boolean;
  whole?: boolean;
  href?: string | null;
};

export function resolveRecord(table: string, rowId: string, hit: RecordHit | null) {
  const key = recordKey(table, hit ?? undefined);
  if (!LOOKUP_TABLES.has(table)) return { recordKey: key, recordText: "", href: null as string | null, found: true };
  if (!hit) return { recordKey: key, recordText: "", href: null as string | null, found: false };
  return {
    recordKey: key,
    recordText: maskAuditText(hit.text).text,
    href: hit.href !== undefined ? hit.href : recordHref(table, rowId, hit),
    found: true,
  };
}

export function actionKey(action: string, eventType: string | null) {
  if (eventType && EVENT_KEYS[eventType]) return EVENT_KEYS[eventType];
  if (action === "update") return "i_audit_act_update";
  if (action === "delete") return "i_audit_act_delete";
  return "i_audit_act_insert";
}

type RawAudit = {
  id: string;
  occurred_key: string;
  occurred_at: Date | string;
  actor_name: string;
  has_actor: boolean;
  table_name: string;
  row_id: string;
  action: string;
  event_type: string | null;
  changed_cols: string[] | null;
  reason: string | null;
};

export type AuditView = {
  cursor: string;
  who: string;
  whoKey: "i_audit_member" | "i_audit_system" | null;
  actionKey: string;
  fields: string[];
  other: boolean;
  masked: boolean;
  reason: string;
  recordKey: string;
  recordText: string;
  href: string | null;
  found: boolean;
  when: string;
  /** B-031 AUDIT_DETAIL. Present only when the DB gateway returned detail (flag ON, admin, same org). */
  detail?: AuditDetailView;
};

/** A display value: literal text, an i18n key, or empty. */
export type AuditDetailValue = { text: string } | { key: string } | null;

export type AuditDetailChange = {
  fieldKey: string;
  before: AuditDetailValue;
  after: AuditDetailValue;
};

export type AuditDetailView = {
  reason: string;
  changes: AuditDetailChange[];
  withheld: number;
};

export function presentAudit(row: RawAudit, hit: RecordHit | null): AuditView {
  const name = maskAuditText(row.actor_name || "").text;
  const changes = summarizeChanges(row.changed_cols);
  const rawReason = row.reason || "";
  const redundant = rawReason === row.event_type || rawReason === row.action || (row.table_name === "auth_events" && rawReason === row.row_id);
  const maskedReason = maskAuditText(redundant ? "" : rawReason);
  const leftover = maskedReason.text.replace(/•/g, "").trim();
  const record = resolveRecord(row.table_name, row.row_id, hit);
  return {
    cursor: encodeCursor(row.occurred_key, row.id),
    who: name,
    whoKey: name ? null : row.has_actor ? "i_audit_member" : "i_audit_system",
    actionKey: actionKey(row.action, row.event_type),
    fields: changes.fields,
    other: changes.other,
    masked: changes.masked || maskedReason.masked,
    reason: leftover ? maskedReason.text : "",
    recordKey: record.recordKey,
    recordText: record.recordText,
    href: record.href,
    found: record.found,
    when: formatTaipei(row.occurred_at),
  };
}

const AUDIT_SELECT = `SELECT a.id::text AS id,
       to_char(a.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_key,
       a.occurred_at,
       coalesce(nullif(btrim(p.display_name), ''), '') AS actor_name,
       (a.actor_user_id IS NOT NULL) AS has_actor,
       a.table_name,
       a.row_id,
       a.action::text AS action,
       a.event_type,
       a.changed_cols,
       a.reason`;

export type AuditQueryInput = {
  orgId: string;
  actorId: string | null;
  action: AuditAction | null;
  eventType: string | null;
  tableName: string | null;
  rowId: string | null;
  from: string | null;
  to: string | null;
  cursor: { at: string; id: string } | null;
  limit: number;
};

/** Predicates are appended only when set, so Postgres can seek the matching keyset index. */
export function auditPageQuery(input: AuditQueryInput) {
  const params: unknown[] = [input.orgId];
  const where = ["a.org_id = $1"];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace("?", `$${params.length}`));
  };
  if (input.actorId) add("a.actor_user_id = ?::uuid", input.actorId);
  if (input.action) add("a.action = ?::audit_action", input.action);
  if (input.eventType) add("a.event_type = ?", input.eventType);
  if (input.tableName) add("a.table_name = ?", input.tableName);
  if (input.rowId) add("a.row_id = ?", input.rowId);
  if (input.from) add("a.occurred_at >= ?::timestamptz", input.from);
  if (input.to) add("a.occurred_at < ?::timestamptz", input.to);
  if (input.cursor) {
    params.push(input.cursor.at, input.cursor.id);
    const at = params.length - 1;
    const id = params.length;
    where.push(`(a.occurred_at, a.id) < ($${at}::timestamptz, $${id}::bigint)`);
  }
  const limit = Math.max(1, Math.min(AUDIT_PAGE_SIZE + 1, Math.floor(input.limit) || 1));
  params.push(limit);
  const sql = `${AUDIT_SELECT}
  FROM audit_log a
  LEFT JOIN profiles p ON p.id = a.actor_user_id
 WHERE ${where.join("\n   AND ")}
 ORDER BY a.occurred_at DESC, a.id DESC
 LIMIT $${params.length}`;
  return { sql, params };
}

const LEASE_TEXT = `btrim(c.display_name || ' ' || p.name || ' ' || u.label || coalesce(' ' || r.label, ''))`;
const LEASE_JOINS = `
  JOIN properties p ON p.id = l.property_id
  JOIN units u ON u.id = l.unit_id
  LEFT JOIN rooms r ON r.id = l.target_room_id
  JOIN lease_parties lp ON lp.lease_id = l.id AND lp.role = 'primary'
  JOIN contacts c ON c.id = lp.contact_id`;

const NULLS = `NULL::text AS parent, NULL::boolean AS is_tenant, NULL::boolean AS is_owner, NULL::text AS mode`;

function leaseChild(table: "lease_signatures" | "lease_parties" | "lease_charges" | "invoices" | "payments") {
  return `SELECT '${table}' AS src, src.id::text AS id, ${LEASE_TEXT} AS text, l.id::text AS parent, NULL::boolean AS is_tenant, NULL::boolean AS is_owner, NULL::text AS mode
    FROM ${table} src
    JOIN leases l ON l.id = src.lease_id
    ${LEASE_JOINS}
   WHERE src.org_id = $1 AND src.id = ANY($IDS::uuid[])`;
}

/** Fixed SQL per table. The table name is never taken from the request. */
const LOOKUP_SQL: Record<string, string> = {
  leases: `SELECT 'leases' AS src, l.id::text AS id, ${LEASE_TEXT} AS text, ${NULLS}
    FROM leases l
    ${LEASE_JOINS}
   WHERE l.org_id = $1 AND l.id = ANY($IDS::uuid[])`,
  contacts: `SELECT 'contacts' AS src, id::text AS id, display_name AS text, NULL::text AS parent, is_tenant, is_owner, NULL::text AS mode
    FROM contacts
   WHERE org_id = $1 AND id = ANY($IDS::uuid[])`,
  properties: `SELECT 'properties' AS src, id::text AS id, name AS text, ${NULLS}
    FROM properties
   WHERE org_id = $1 AND id = ANY($IDS::uuid[])`,
  units: `SELECT 'units' AS src, u.id::text AS id, btrim(p.name || ' ' || u.label) AS text, NULL::text AS parent, NULL::boolean AS is_tenant, NULL::boolean AS is_owner, u.rental_mode::text AS mode
    FROM units u
    JOIN properties p ON p.id = u.property_id
   WHERE u.org_id = $1 AND u.id = ANY($IDS::uuid[])`,
  rooms: `SELECT 'rooms' AS src, r.id::text AS id, btrim(p.name || ' ' || u.label || ' ' || r.label) AS text, ${NULLS}
    FROM rooms r
    JOIN units u ON u.id = r.unit_id
    JOIN properties p ON p.id = u.property_id
   WHERE r.org_id = $1 AND r.id = ANY($IDS::uuid[])`,
  owner_statements: `SELECT 'owner_statements' AS src, id::text AS id, period_start::text || '–' || period_end::text AS text, ${NULLS}
    FROM owner_statements
   WHERE org_id = $1 AND id = ANY($IDS::uuid[])`,
  property_owners: `SELECT 'property_owners' AS src, po.id::text AS id, btrim(c.display_name || ' ' || p.name) AS text, p.id::text AS parent, NULL::boolean AS is_tenant, NULL::boolean AS is_owner, NULL::text AS mode
    FROM property_owners po
    JOIN contacts c ON c.id = po.owner_contact_id
    JOIN properties p ON p.id = po.property_id
   WHERE po.org_id = $1 AND po.id = ANY($IDS::uuid[])`,
  maintenance_tickets: `SELECT 'maintenance_tickets' AS src, id::text AS id, title AS text, property_id::text AS parent, NULL::boolean AS is_tenant, NULL::boolean AS is_owner, NULL::text AS mode
    FROM maintenance_tickets
   WHERE org_id = $1 AND id = ANY($IDS::uuid[])`,
  org_members: `SELECT 'org_members' AS src, m.id::text AS id, coalesce(nullif(btrim(pr.display_name), ''), '') AS text, ${NULLS}
    FROM org_members m
    LEFT JOIN profiles pr ON pr.id = m.user_id
   WHERE m.org_id = $1 AND m.id = ANY($IDS::uuid[])`,
  ledger_transactions: `SELECT 'ledger_transactions' AS src, id::text AS id, coalesce(description, '') AS text, lease_id::text AS parent, NULL::boolean AS is_tenant, NULL::boolean AS is_owner, NULL::text AS mode
    FROM ledger_transactions
   WHERE org_id = $1 AND id = ANY($IDS::uuid[])`,
  management_agreements: `SELECT 'management_agreements' AS src, a.id::text AS id, c.display_name AS text, c.id::text AS parent, NULL::boolean AS is_tenant, NULL::boolean AS is_owner, NULL::text AS mode
    FROM management_agreements a
    JOIN contacts c ON c.id = a.owner_contact_id
   WHERE a.org_id = $1 AND a.id = ANY($IDS::uuid[])`,
  lease_signatures: leaseChild("lease_signatures"),
  lease_parties: leaseChild("lease_parties"),
  lease_charges: leaseChild("lease_charges"),
  invoices: leaseChild("invoices"),
  payments: leaseChild("payments"),
};

const LEASE_LINK = new Set(["lease_signatures", "lease_parties", "lease_charges", "invoices", "payments", "ledger_transactions"]);
const PROPERTY_LINK = new Set(["property_owners", "maintenance_tickets"]);

type LookupHit = {
  src: string;
  id: string;
  text: string | null;
  parent: string | null;
  is_tenant: boolean | null;
  is_owner: boolean | null;
  mode: string | null;
};

function recordGroups(rows: RawAudit[]) {
  const groups = new Map<string, string[]>();
  for (const row of rows) {
    if (!LOOKUP_SQL[row.table_name] || !UUID.test(row.row_id)) continue;
    const list = groups.get(row.table_name);
    if (!list) groups.set(row.table_name, [row.row_id]);
    else if (!list.includes(row.row_id)) list.push(row.row_id);
  }
  return groups;
}

/** One statement for every record name on the page. Null when the page has nothing to resolve. */
export function recordLookupQuery(orgId: string, groups: Map<string, string[]>) {
  const params: unknown[] = [orgId];
  const parts: string[] = [];
  for (const [table, ids] of groups) {
    const body = LOOKUP_SQL[table];
    if (!body || ids.length === 0) continue;
    params.push(ids);
    parts.push(body.split("$IDS").join(`$${params.length}`));
  }
  if (!parts.length) return null;
  return { sql: parts.join("\nUNION ALL\n"), params };
}

function lookupHit(row: LookupHit): RecordHit {
  const hit: RecordHit = { text: row.text ?? "" };
  if (row.src === "contacts") {
    hit.tenant = Boolean(row.is_tenant);
    hit.owner = Boolean(row.is_owner);
  } else if (row.src === "units") {
    hit.whole = row.mode === "whole_unit";
  } else if (row.src === "org_members") {
    hit.href = "/m/team";
  } else if (LEASE_LINK.has(row.src)) {
    hit.href = row.parent && UUID.test(row.parent) ? `/m/leases/${row.parent}` : null;
  } else if (PROPERTY_LINK.has(row.src)) {
    hit.href = row.parent && UUID.test(row.parent) ? `/m/properties/${row.parent}` : null;
  } else if (row.src === "management_agreements") {
    hit.href = row.parent && UUID.test(row.parent) ? `/m/owners/${row.parent}` : null;
  }
  return hit;
}

async function lookupRecords(
  client: Parameters<typeof many>[0],
  orgId: string,
  rows: RawAudit[],
): Promise<Map<string, RecordHit>> {
  const found = new Map<string, RecordHit>();
  const query = recordLookupQuery(orgId, recordGroups(rows));
  if (!query) return found;
  const hits = await many<LookupHit>(client, query.sql, query.params);
  for (const hit of hits) found.set(`${hit.src}:${hit.id}`, lookupHit(hit));
  return found;
}

/**
 * B-031 AUDIT_DETAIL read side. app.b031_audit_detail_rows returns rows only for
 * an active admin of the pinned organization while the audit_detail flag is ON;
 * everyone else gets zero rows. Values were masked when written; this module
 * re-masks text, accepts only allowlisted fields and formats money with BigInt.
 */
export const AUDIT_DETAIL_SQL = "SELECT audit_id, reason, changes, withheld FROM app.b031_audit_detail_rows($1::uuid, $2::bigint[])";

export type RawDetail = { audit_id: string; reason: string | null; changes: unknown; withheld: number | string | null };

const DETAIL_FIELDS: Record<string, { key: string; kind: string }> = {
  rent_amount_minor: { key: "i_audit_f_rent", kind: "money" },
  deposit_amount_minor: { key: "i_audit_f_deposit", kind: "money" },
  base_rent_minor: { key: "i_audit_d_base_rent", kind: "money" },
  deposit_months: { key: "i_audit_d_deposit_months", kind: "number" },
  due_day: { key: "i_audit_f_due", kind: "number" },
  start_date: { key: "i_audit_f_start", kind: "date" },
  end_date: { key: "i_audit_f_end", kind: "date" },
  terminated_on: { key: "i_audit_d_terminated_on", kind: "date" },
  moved_out_on: { key: "i_audit_d_moved_out_on", kind: "date" },
  status: { key: "i_audit_f_status", kind: "code" },
  renewal_status: { key: "i_audit_d_renewal_status", kind: "code" },
  role: { key: "i_audit_f_role", kind: "code" },
  rental_mode: { key: "i_audit_f_mode", kind: "code" },
  default_rental_mode: { key: "i_audit_f_mode", kind: "code" },
  termination_reason: { key: "i_audit_d_termination_reason", kind: "text" },
  deposit_override_reason: { key: "i_audit_d_deposit_reason", kind: "text" },
  display_name: { key: "i_audit_f_name", kind: "text" },
  name: { key: "i_audit_f_name", kind: "text" },
  company_name: { key: "i_audit_d_company", kind: "text" },
  address_display: { key: "i_audit_f_address", kind: "text" },
  label: { key: "i_audit_f_label", kind: "text" },
  title: { key: "i_audit_d_title", kind: "text" },
  email: { key: "i_audit_d_email", kind: "email" },
  phone_e164: { key: "i_audit_d_phone", kind: "phone" },
  is_tenant: { key: "i_audit_d_is_tenant", kind: "bool" },
  is_owner: { key: "i_audit_d_is_owner", kind: "bool" },
  is_vendor: { key: "i_audit_d_is_vendor", kind: "bool" },
  is_billing_owner: { key: "i_audit_d_billing_owner", kind: "bool" },
  archived_at: { key: "i_audit_d_archived_at", kind: "time" },
};

const CODE_KEYS: Record<string, string> = {
  admin: "i_role_admin",
  manager: "i_role_manager",
  accountant: "i_role_accountant",
  maintenance: "i_role_maintenance",
  draft: "i_st_draft",
  pending_signature: "i_st_pending",
  active: "i_st_active",
  ended: "i_st_ended",
  terminated: "i_st_terminated",
  cancelled: "i_st_cancelled",
  invited: "i_audit_v_invited",
  suspended: "i_audit_v_suspended",
  removed: "i_audit_v_removed",
  whole_unit: "i_audit_v_whole_unit",
  by_room: "i_audit_v_by_room",
  none: "i_audit_v_none",
  reminder_sent: "i_audit_v_reminder_sent",
  offered: "i_audit_v_offered",
  renewed: "i_audit_v_renewed",
  declined: "i_audit_v_declined",
  month_to_month: "i_audit_v_month_to_month",
};

const MINOR = /^-?\d{1,19}$/;
const DECIMAL = /^-?\d{1,19}(\.\d{1,6})?$/;

/** Exact-integer minor units. No Number() round trip, so large amounts never lose precision. */
export function detailMoney(minor: string, currency: string, locale: Locale) {
  if (!MINOR.test(minor)) return MASK;
  const value = BigInt(minor);
  const negative = value < BigInt(0);
  const abs = negative ? -value : value;
  const hundred = BigInt(100);
  const whole = new Intl.NumberFormat(locale === "zh-TW" ? "zh-Hant-TW" : "en-US").format(abs / hundred);
  const cents = (abs % hundred).toString().padStart(2, "0");
  const code = /^[A-Z]{3}$/.test(currency) ? currency : "TWD";
  const body = code === "TWD" ? `NT$${whole}${cents === "00" ? "" : `.${cents}`}` : `${code} ${whole}.${cents}`;
  return negative ? `-${body}` : body;
}

/** Partial masks from the write side keep at most a first character and two trailing digits. */
function partialMasked(kind: "email" | "phone", value: string) {
  if (kind === "email") return /^[^@\s*]\*{3}@[^@\s]+$/.test(value) && !maskDetailText(value.slice(value.indexOf("@") + 1)).masked ? value : MASK;
  return /^(\+886|\+|\d)\*+\d{2}$/.test(value) ? value : MASK;
}

function detailValue(kind: string, raw: unknown, currency: string, locale: Locale): AuditDetailValue {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") return { text: MASK };
  switch (kind) {
    case "money":
      return { text: detailMoney(raw, currency, locale) };
    case "number":
      return { text: DECIMAL.test(raw) ? raw : MASK };
    case "date":
      return { text: DAY.test(raw) ? raw : MASK };
    case "time": {
      const when = /^\d{4}-\d{2}-\d{2}[T ]/.test(raw) ? formatTaipei(raw) : "";
      return { text: when || MASK };
    }
    case "bool":
      if (raw === "true") return { key: "i_audit_v_yes" };
      return raw === "false" ? { key: "i_audit_v_no" } : { text: MASK };
    case "code":
      if (!/^[a-z_]{1,40}$/.test(raw)) return { text: MASK };
      return CODE_KEYS[raw] ? { key: CODE_KEYS[raw] } : { text: raw };
    case "email":
    case "phone":
      return { text: partialMasked(kind, raw) };
    case "text":
      return { text: maskDetailText(raw).text.slice(0, 200) };
    default:
      return { text: MASK };
  }
}

/** Unknown fields or kinds are dropped and counted as withheld, never shown. */
export function presentDetail(raw: RawDetail, locale: Locale): AuditDetailView | null {
  let list: unknown = raw.changes;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(list)) return null;
  const changes: AuditDetailChange[] = [];
  let withheld = Math.max(0, Math.floor(Number(raw.withheld) || 0));
  for (const item of list.slice(0, 40)) {
    const entry = (item ?? {}) as { f?: unknown; k?: unknown; b?: unknown; a?: unknown; c?: unknown };
    const field = typeof entry.f === "string" ? DETAIL_FIELDS[entry.f] : undefined;
    if (!field || entry.k !== field.kind) {
      withheld += 1;
      continue;
    }
    const currency = typeof entry.c === "string" ? entry.c : "TWD";
    changes.push({
      fieldKey: field.key,
      before: detailValue(field.kind, entry.b, currency, locale),
      after: detailValue(field.kind, entry.a, currency, locale),
    });
  }
  if (!changes.length) return null;
  return { reason: raw.reason ? maskDetailText(raw.reason).text.slice(0, 500) : "", changes, withheld };
}

/** Skipped for an empty page. Otherwise one statement; zero rows unless the DB permits detail. */
async function lookupDetails(client: Parameters<typeof many>[0], orgId: string, rows: RawAudit[]) {
  const found = new Map<string, RawDetail>();
  const ids = rows.map((row) => row.id).filter((id) => cursorId(id));
  if (!ids.length) return found;
  for (const detail of await many<RawDetail>(client, AUDIT_DETAIL_SQL, [orgId, ids])) {
    found.set(String(detail.audit_id), detail);
  }
  return found;
}

type ScreenBundle ={ page: RawAudit[] | string; actors: { id: string; name: string }[] | string };

function asJson<T>(value: T | string): T {
  return typeof value === "string" ? (JSON.parse(value) as T) : value;
}

/** Page rows and the member filter, in one statement. Record names are a second statement. */
export function auditScreenQuery(input: AuditQueryInput) {
  const page = auditPageQuery(input);
  const sql = `SELECT COALESCE((
      SELECT json_agg((to_jsonb(s) - 'ord') ORDER BY s.ord)
        FROM (
          SELECT q.*, row_number() OVER (ORDER BY q.occurred_at DESC, q.id::bigint DESC) AS ord
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

export type AuditActor = { id: string; name: string };

export type AuditPage = {
  entries: AuditView[];
  hasMore: boolean;
  actors: AuditActor[];
  filters: AuditFilters;
};

function pageInput(session: Session, filters: AuditFilters, rowId: string | null, pageSize: number): AuditQueryInput {
  const range = taipeiRange(filters.from, filters.to);
  return {
    orgId: session.orgId,
    actorId: filters.actorId,
    action: filters.action,
    eventType: filters.eventType,
    tableName: filters.tableName,
    rowId,
    from: range.start,
    to: range.end,
    cursor: decodeCursor(filters.cursor),
    limit: pageSize + 1,
  };
}

async function presentPage(client: Parameters<typeof many>[0], orgId: string, rows: RawAudit[], pageSize: number, locale: Locale) {
  const hasMore = rows.length > pageSize;
  const page = hasMore ? rows.slice(0, pageSize) : rows;
  const labels = await lookupRecords(client, orgId, page);
  const details = await lookupDetails(client, orgId, page);
  return {
    entries: page.map((row) => {
      const view = presentAudit(row, labels.get(`${row.table_name}:${row.row_id}`) ?? null);
      const detail = details.get(row.id);
      if (!detail) return view;
      const presented = presentDetail(detail, locale);
      // The detail block carries the reason re-masked at write (token-like runs included),
      // so the summary line does not repeat the raw stored reason.
      return presented ? { ...view, reason: "", detail: presented } : view;
    }),
    hasMore,
  };
}

async function readPage(
  client: Parameters<typeof many>[0],
  session: Session,
  filters: AuditFilters,
  rowId: string | null,
  pageSize: number,
) {
  const { sql, params } = auditPageQuery(pageInput(session, filters, rowId, pageSize));
  const rows = await many<RawAudit>(client, sql, params);
  return presentPage(client, session.orgId, rows, pageSize, session.locale);
}

function scope(session: Session) { return requireOrgScope(session); }

export async function loadAuditScreen(
  session: Session,
  input: { user?: string; action?: string; record?: string; from?: string; to?: string; cursor?: string },
): Promise<AuditPage> {
  const filters = parseAuditFilters(input);
  if (session.role !== "admin") return { entries: [], hasMore: false, actors: [], filters };
  return tx(
    session.userId,
    async (client) => {
      const built = auditScreenQuery(pageInput(session, filters, null, AUDIT_PAGE_SIZE));
      const [bundle] = await many<ScreenBundle>(client, built.sql, built.params);
      const rows = asJson<RawAudit[]>(bundle?.page ?? []).map((row) => ({
        ...row,
        id: String(row.id),
        actor_name: row.actor_name ?? "",
        has_actor: Boolean(row.has_actor),
        changed_cols: Array.isArray(row.changed_cols) ? row.changed_cols : null,
        reason: row.reason ?? null,
        event_type: row.event_type ?? null,
      }));
      const page = await presentPage(client, session.orgId, rows, AUDIT_PAGE_SIZE, session.locale);
      const actors = asJson<{ id: string; name: string }[]>(bundle?.actors ?? []);
      return {
        ...page,
        actors: actors.map((actor) => ({ id: actor.id, name: maskAuditText(actor.name).text })),
        filters,
      };
    },
    scope(session),
  );
}

export async function loadAuditHistory(session: Session, table: string, rowId: string, cursor?: string) {
  const tableName = AUDIT_TABLES.find((item) => item === table) ?? null;
  if (session.role !== "admin" || !tableName || !UUID.test(rowId)) return { entries: [] as AuditView[], hasMore: false };
  const filters = parseAuditFilters({ cursor });
  filters.tableName = tableName;
  return tx(
    session.userId,
    (client) => readPage(client, session, filters, rowId, AUDIT_HISTORY_SIZE),
    scope(session),
  );
}

export function auditListQuery(filters: AuditFilters, cursor?: string) {
  const params = new URLSearchParams();
  if (filters.actorId) params.set("user", filters.actorId);
  if (filters.eventType) params.set("action", filters.eventType);
  else if (filters.action) params.set("action", filters.action);
  if (filters.tableName) params.set("record", filters.tableName);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (cursor) params.set("cursor", cursor);
  const query = params.toString();
  return query ? `/m/audit?${query}` : "/m/audit";
}

import { maskAuditText } from "./audit-read";
import { query } from "./db";
import type { Session } from "./types";

type OrgPin = { orgId: string; environment: "live" | "sandbox" };

export type Sql = {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
};

export type AuditScope = {
  orgId: string | null;
  actorUserId: string | null;
  actorRole: string;
};

export type AuditEntry = {
  table: string;
  rowId: string;
  action: string; // domain action stored on audit_log.action; row is always INSERT
  eventType: string;
  newRow?: Record<string, unknown>;
  reason?: string;
  requestId?: string | null;
};

export function auditScope(
  session: Pick<Session, "userId" | "role" | "kind">,
  scopeFromRequireOrgScope: OrgPin,
): AuditScope {
  return {
    orgId: scopeFromRequireOrgScope.orgId,
    actorUserId: session.userId,
    actorRole: session.role ?? session.kind,
  };
}

export function svcAuditScope(scope: AuditScope): AuditScope {
  return {
    orgId: scope.orgId,
    actorUserId: scope.actorUserId,
    actorRole: scope.actorRole,
  };
}

const SECRET_KEYS = /token|secret|password|encrypt|storage|code_hash|token_hash/i;

// Structured fields follow audit-read's FIELD_KEYS; text fields still need masking.
const STRUCTURED_FIELDS = new Set([
  "status",
  "rent_amount_minor",
  "deposit_amount_minor",
  "deposit_months",
  "start_date",
  "end_date",
  "role",
  "due_day",
  "currency",
  "rental_mode",
]);

function sanitizeValue(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([column]) => !SECRET_KEYS.test(column))
        .map(([column, item]) => [column, sanitizeValue(item, column)]),
    );
  }
  if (typeof value !== "string") return value;
  if (key === "id" || key?.endsWith("_id") || (key && STRUCTURED_FIELDS.has(key))) {
    return value;
  }
  return maskAuditText(value).text;
}

export function sanitizeAuditPayload(
  newRow?: Record<string, unknown>,
  reason?: string,
): { newRow: Record<string, unknown> | undefined; reason: string | undefined } {
  return {
    newRow: newRow === undefined
      ? undefined
      : sanitizeValue(newRow) as Record<string, unknown>,
    reason: reason === undefined ? undefined : maskAuditText(reason).text,
  };
}

// PROP-09 may use deposit_settlement_* event_type; no amount schema here.
export async function recordAudit(
  scope: AuditScope,
  entry: AuditEntry,
  client?: Sql,
): Promise<void> {
  const payload = sanitizeAuditPayload(entry.newRow, entry.reason);
  const sql = `INSERT INTO audit_log
    (org_id, actor_user_id, actor_role, table_name, row_id, action,
     event_type, new_row, reason, request_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`;
  const params = [
    scope.orgId,
    scope.actorUserId,
    scope.actorRole,
    entry.table,
    entry.rowId,
    entry.action,
    entry.eventType,
    payload.newRow === undefined ? null : JSON.stringify(payload.newRow),
    payload.reason ?? null,
    entry.requestId ?? null,
  ];
  if (client) await client.query(sql, params);
  else await query(sql, params);
}

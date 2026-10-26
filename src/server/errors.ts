export class FlowError extends Error {
  constructor(
    public key: string,
    public vars?: Record<string, string | number>,
  ) {
    super(key);
  }
}

const HEX_BLOB = /\\x[0-9a-fA-F]{8,}/g;
const B64_BLOB = /[A-Za-z0-9+/]{40,}={0,2}/g;
const TWID = /[A-Z][1289]\d{8}/g;
const ARC = /[A-Z]{2}\d{8}/g;
const PASSPORT = /\b[A-Z]{1,2}\d{5,10}\b/g;
const QUOTED = /'[^']*'/g;

/** Drop ID numbers, passport/ARC shapes, quoted DB values, and ciphertext from a log line. */
export function redactServerMessage(raw: string) {
  return raw
    .replace(HEX_BLOB, "\\x…")
    .replace(B64_BLOB, "[redacted]")
    .replace(TWID, "[id]")
    .replace(ARC, "[arc]")
    .replace(PASSPORT, "[doc]")
    .replace(QUOTED, "'[redacted]'")
    .slice(0, 200);
}

function pgText(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

/** Server log line with the driver code and a short redacted message. No names or ID numbers. */
export function logServerError(tag: string, error: unknown) {
  const err = error as {
    name?: string;
    message?: string;
    code?: string;
    routine?: string;
    severity?: string;
    constraint?: string;
    table?: string;
    column?: string;
  };
  const raw = err?.message ?? (error instanceof Error ? error.message : String(error));
  const message = redactServerMessage(raw);
  console.error(`${tag} failed`, {
    name: err?.name ?? (error instanceof Error ? error.name : "Error"),
    code: pgText(err?.code),
    routine: pgText(err?.routine),
    severity: pgText(err?.severity),
    constraint: pgText(err?.constraint),
    table: pgText(err?.table),
    column: pgText(err?.column),
    message,
  });
}

/** Lock, statement, and connect timeouts. These must not fall through to the generic banner. */
export function isDbTimeout(error: unknown) {
  const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  const message = error instanceof Error ? error.message : String(error);
  return (
    code === "55P03" ||
    code === "57014" ||
    /lock timeout|canceling statement due to statement timeout|statement timeout|timeout exceeded when trying to connect/i.test(message)
  );
}

export function mapDbError(error: unknown): Error {
  if (error instanceof FlowError) return error;
  const message = error instanceof Error ? error.message : String(error);
  logServerError("database", error);
  console.error("database error:", error);
  let key = "errors.generic";
  if (/row-level security|permission denied|insufficient_privilege/i.test(message)) key = "errors.forbidden";
  else if (/override reason|exceeds bill average/i.test(message)) key = "errors.capReason";
  else if (/deposit of|leases_deposit_over_cap_requires_override|leases_deposit_override_pair/i.test(message)) key = "errors.depositCap";
  else if (/unbalanced/i.test(message)) key = "errors.ledger";
  else if (/utility_allocation_runs_open_period_uidx/i.test(message)) key = "errors.utilityPeriod";
  else if (/utility_allocation_runs_unit_period_excl/i.test(message)) key = "errors.utilityOverlap";
  else if (/exclusion_violation|exclusion constraint|overlaps lease|double-booking/i.test(message)) key = "errors.occupied";
  else if (/contacts_org_tenant_email_uniq/i.test(message)) key = "errors.tenantExists";
  else if (/duplicate key/i.test(message) && /email/i.test(message)) key = "errors.emailTaken";
  else if (/utility_bills_meter_id_period/i.test(message) || /meter_id, period_start/i.test(message)) key = "errors.billExists";
  else if (/invalid input syntax for type numeric/i.test(message)) key = "errors.amount";
  else if (/ticket photo limit/i.test(message)) key = "errors.photoLimit";
  else if (/ticket photo path|files_ticket_photo_path/i.test(message)) key = "errors.forbidden";
  else if (/files_ticket_photo_cap/i.test(message)) key = "errors.photoSize";
  else if (/maintenance_tickets_schedule_order/i.test(message)) key = "errors.date";
  else if (/rented as whole_unit/i.test(message)) key = "errors.wholeUnit";
  else if (/month is closed|month_closed/i.test(message)) key = "errors.monthClosed";
  else if (/expense is on an issued statement/i.test(message)) key = "errors.expenseLocked";
  else if (/id_doc_retention_days/i.test(message)) key = "errors.idRetention";
  else if (/identity number must be stored masked/i.test(message)) key = "errors.idNumber";
  const wrapped = new FlowError(key);
  if (error instanceof Error) wrapped.cause = error;
  return wrapped;
}

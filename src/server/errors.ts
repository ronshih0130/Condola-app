export class FlowError extends Error {
  constructor(
    public key: string,
    public vars?: Record<string, string | number>,
  ) {
    super(key);
  }
}

export const SAFE_ERROR_REASONS = Object.freeze([
  "invalid_ticket_pricing",
  "missing_seal_image",
  "vendor_profile_incomplete",
  "ticket_not_closed",
  "invalid_ticket_cost",
  "vendor_pdf_pagination_overflow",
  "vendor_pdf_font_unavailable",
  "vendor_pdf_font_origin_required",
  "vendor_pdf_final_group_too_large",
  "vendor_document_integrity_failure",
  "reissue_required",
  "missing_work_address",
  "missing_correction_reason",
  "missing_buyer_selection",
  "invalid_service_job_types",
  "invalid_seal_file",
  "invalid_reissue_source",
  "invalid_issue_time",
  "invalid_idempotency_key",
  "invalid_document_date",
  "idempotency_key_conflict",
  "document_not_issued",
  "document_already_reissued",
  "document_already_issued",
  "insufficient_privilege",
] as const);

export function safeErrorReason(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_ERROR_REASONS.some((reason) => reason === value)
    ? value
    : undefined;
}

export function safeDbCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9A-Z]{5}$/.test(value) ? value : undefined;
}

export function safeDbIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z_][a-z0-9_]{0,62}$/.test(value) ? value : undefined;
}

/** Compatibility API: arbitrary server messages always become fixed safe text. */
export function redactServerMessage(raw: string) {
  void raw;
  return "database error";
}

function pgText(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function dbErrorKey(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
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
  else if (/ticket photo path|files_ticket_photo_path|vendor job photo|repair_vendor_jobs_one_active/i.test(message)) key = "errors.forbidden";
  else if (/files_ticket_photo_cap/i.test(message)) key = "errors.photoSize";
  else if (/maintenance_tickets_schedule_order/i.test(message)) key = "errors.date";
  else if (/rented as whole_unit/i.test(message)) key = "errors.wholeUnit";
  else if (/month is closed|month_closed/i.test(message)) key = "errors.monthClosed";
  else if (/expense is on an issued statement/i.test(message)) key = "errors.expenseLocked";
  else if (/id_doc_retention_days/i.test(message)) key = "errors.idRetention";
  else if (/identity number must be stored masked/i.test(message)) key = "errors.idNumber";
  return key;
}

function logDatabaseError(tag: string, error: unknown, key: string) {
  const metadata = error as {
    code?: unknown;
    constraint?: unknown;
    table?: unknown;
    column?: unknown;
  } | null;
  const code = safeDbCode(metadata?.code);
  const constraint = safeDbIdentifier(metadata?.constraint);
  const table = safeDbIdentifier(metadata?.table);
  const column = safeDbIdentifier(metadata?.column);
  console.error(`${tag} failed`, {
    ...(code === undefined ? {} : { code }),
    ...(constraint === undefined ? {} : { constraint }),
    key,
    ...(table === undefined ? {} : { table }),
    ...(column === undefined ? {} : { column }),
    message: "database error",
  });
}

/** Log validated database metadata and fixed safe text. */
export function logServerError(tag: string, error: unknown) {
  logDatabaseError(tag, error, dbErrorKey(error));
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
  const key = dbErrorKey(error);
  logDatabaseError("database", error, key);
  const wrapped = new FlowError(key);
  const metadata = error as { code?: unknown; constraint?: unknown } | null;
  const code = safeDbCode(metadata?.code);
  const constraint = safeDbIdentifier(metadata?.constraint);
  const isPgError = code !== undefined || pgText(metadata?.constraint) !== undefined;
  const reason = !isPgError && error instanceof Error
    ? safeErrorReason(error.message)
    : undefined;
  wrapped.cause = {
    ...(code === undefined ? {} : { code }),
    ...(constraint === undefined ? {} : { constraint }),
    ...(reason === undefined ? {} : { reason }),
  };
  return wrapped;
}


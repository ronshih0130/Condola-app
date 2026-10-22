export class FlowError extends Error {
  constructor(
    public key: string,
    public vars?: Record<string, string | number>,
  ) {
    super(key);
  }
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
  console.error(error);
  if (/row-level security|permission denied|insufficient_privilege/i.test(message)) {
    return new FlowError("errors.forbidden");
  }
  if (/override reason|exceeds bill average/i.test(message)) {
    return new FlowError("errors.capReason");
  }
  if (/deposit of|leases_deposit_over_cap_requires_override|leases_deposit_override_pair/i.test(message)) {
    return new FlowError("errors.depositCap");
  }
  if (/unbalanced/i.test(message)) return new FlowError("errors.ledger");
  if (/exclusion_violation|exclusion constraint|overlaps lease|double-booking/i.test(message)) {
    return new FlowError("errors.occupied");
  }
  if (/contacts_org_tenant_email_uniq/i.test(message)) {
    return new FlowError("errors.tenantExists");
  }
  if (/duplicate key/i.test(message) && /email/i.test(message)) {
    return new FlowError("errors.emailTaken");
  }
  if (/utility_bills_meter_id_period/i.test(message) || /meter_id, period_start/i.test(message)) {
    return new FlowError("errors.billExists");
  }
  if (/invalid input syntax for type numeric/i.test(message)) return new FlowError("errors.amount");
  if (/ticket photo limit/i.test(message)) return new FlowError("errors.photoLimit");
  if (/ticket photo path|files_ticket_photo_path/i.test(message)) return new FlowError("errors.forbidden");
  if (/files_ticket_photo_cap/i.test(message)) return new FlowError("errors.photoSize");
  if (/maintenance_tickets_schedule_order/i.test(message)) return new FlowError("errors.date");
  if (/rented as whole_unit/i.test(message)) return new FlowError("errors.wholeUnit");
  if (/month is closed|month_closed/i.test(message)) return new FlowError("errors.monthClosed");
  if (/expense is on an issued statement/i.test(message)) return new FlowError("errors.expenseLocked");
  return new FlowError("errors.generic");
}

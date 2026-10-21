export class FlowError extends Error {
  constructor(
    public key: string,
    public vars?: Record<string, string | number>,
  ) {
    super(key);
  }
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
  if (/rented as whole_unit/i.test(message)) return new FlowError("errors.wholeUnit");
  return new FlowError("errors.generic");
}

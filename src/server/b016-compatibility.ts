/** Disconnected B-016 compatibility proposals; no DB, transport or provider imports. */
export type PayeeReferenceCandidate = Readonly<{
  id: string; orgId: string; archivedAt: string | null; showToTenants: boolean;
  propertyId: string | null;
}>;

/** Metadata must eventually come from the B-003 authorized gateway, never a form. */
export function profilePayeeReference(gate: unknown, scope: { orgId: string; propertyId: string },
  account: PayeeReferenceCandidate | null) {
  if (gate !== true) return { status: "disabled", reference: null } as const;
  if (!account || account.orgId !== scope.orgId || account.archivedAt !== null || account.showToTenants !== true ||
      (account.propertyId !== null && account.propertyId !== scope.propertyId)) {
    return { status: "unavailable", reference: null } as const;
  }
  return { status: "eligible", reference: Object.freeze({ orgId: scope.orgId, accountId: account.id }) } as const;
}

/** Strict boolean opt-in around injected work only; this is not an authorization gate. */
export async function withB016Extension<T>(gate: unknown, legacy: T, extension: () => Promise<T>): Promise<T> {
  return gate === true ? extension() : legacy;
}

/** Deposit-only arithmetic: prepay is a separate balance and cannot fund deductions. */
export function depositRefund(input: { depositMinor: bigint; deductionMinor: bigint; ownerPrepayMinor: bigint }) {
  if (![input.depositMinor, input.deductionMinor, input.ownerPrepayMinor].every(value =>
    typeof value === "bigint" && value >= BigInt(0)) || input.deductionMinor > input.depositMinor) {
    throw new Error("invalid_deposit_refund");
  }
  return Object.freeze({ refundMinor: input.depositMinor - input.deductionMinor,
    ownerPrepayMinor: input.ownerPrepayMinor, prepayDrawdownMinor: BigInt(0) });
}

export function mf03Availability(event: "company_invoice" | "owner_prepay") {
  return { status: "deferred", proposal: "PROP-MF-03", event, available: false, confirmationWorkflow: false } as const;
}

/** Global kill switch; an organization must also explicitly opt in. */
export const PAYEE_DETAILS_ENABLED = false;

export function payeeDetailsOn(killSwitch: boolean, flags: unknown): boolean {
  return killSwitch === true && flags !== null && typeof flags === "object" &&
    !Array.isArray(flags) &&
    (flags as Record<string, unknown>).payee_details === true;
}

export type PayeeInput = {
  id?: string;
  holderName: string;
  bankName: string;
  bankCode: string;
  branchCode: string;
  accountNumber: string;
  ownerContactId: string | null;
  isDefault: boolean;
  details: { swift?: string; routing?: string };
};

export function validUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function validatePayee(country: string, input: PayeeInput): PayeeInput {
  const result = {
    ...input,
    holderName: input.holderName.trim(),
    bankName: input.bankName.trim(),
    bankCode: input.bankCode.trim(),
    branchCode: input.branchCode.trim(),
    accountNumber: input.accountNumber.trim(),
  };
  if (!/^[A-Z]{2}$/.test(country) ||
      !result.holderName || result.holderName.length > 200 ||
      !/^[A-Za-z0-9 -]{1,34}$/.test(result.accountNumber) ||
      (result.id !== undefined && !validUuid(result.id)) ||
      (result.ownerContactId !== null && !validUuid(result.ownerContactId)) ||
      (result.isDefault && result.ownerContactId !== null)) {
    throw new Error("invalid_payee");
  }
  if (country === "TW") {
    if (!/^\d{3}$/.test(result.bankCode) ||
        !/^[A-Za-z0-9 -]{1,40}$/.test(result.branchCode)) {
      throw new Error("invalid_payee");
    }
    result.details = {};
  } else {
    if (!result.bankName || result.bankName.length > 200) throw new Error("invalid_payee");
    const details: PayeeInput["details"] = {};
    for (const key of ["swift", "routing"] as const) {
      const value = input.details[key]?.trim();
      if (value && !/^[A-Za-z0-9 -]{1,100}$/.test(value)) throw new Error("invalid_payee");
      if (value) details[key] = value;
    }
    result.details = details;
    result.bankCode = "";
    result.branchCode = "";
  }
  return result;
}

/** Tenants need the complete number to pay; legacy rows expose only last five. */
export function payeeAccount(accountNumber: string | null, last5: string | null): string {
  return accountNumber || (last5 ? `…${last5}` : "");
}

export function resolvePayee<T>(leasePayee: T | null, companyDefault: T | null): T | null {
  return leasePayee ?? companyDefault ?? null;
}

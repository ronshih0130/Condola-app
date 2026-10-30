
export type PayeeAccount = {
  id: string;
  holder_name: string | null;
  bank_name: string | null;
  bank_code: string | null;
  branch_code: string | null;
  account_number: string | null;
  account_last5: string | null;
  owner_contact_id: string | null;
  is_default_payee: boolean;
  details: { swift?: string; routing?: string };
};

export type TenantPayeeView = {
  enabled: boolean;
  last5: string | null | undefined;
  account: PayeeAccount | null;
};

/** Only an audited access denial becomes the ordinary missing-data state. */
export function tenantPayeeDecision(result: { ok: boolean; reason: string; data: TenantPayeeView | null }, unavailableOnDenied: boolean): TenantPayeeView {
  if (!result.ok && unavailableOnDenied && (result.reason === "forbidden" || result.reason === "not_found")) {
    return { enabled: true, last5: null, account: null };
  }
  if (!result.ok || !result.data) throw new Error("Payee access unavailable");
  return result.data;
}

export type PayeeDisplay =
  | { kind: "legacy"; last5: string }
  | { kind: "account"; account: PayeeAccount; number: string }
  | { kind: "none" };

export function tenantPayeeDisplay(view: TenantPayeeView): PayeeDisplay {
  if (!view.enabled) return view.last5 ? { kind: "legacy", last5: view.last5 } : { kind: "none" };
  const account = view.account;
  const number = account ? payeeAccount(account.account_number, account.account_last5) : "";
  return account && number ? { kind: "account", account, number } : { kind: "none" };
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

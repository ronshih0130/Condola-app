import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  PAYEE_DETAILS_ENABLED, payeeDetailsOn, validatePayee,
  payeeAccount, resolvePayee, tenantPayeeDisplay, type PayeeAccount, type PayeeInput,
} from "./payee-rules";

const input: PayeeInput = {
  holderName: "Example Ltd", bankName: "Example Bank", bankCode: "012",
  branchCode: "1234", accountNumber: "1234567890",
  ownerContactId: null, isDefault: true, details: {},
};

test("payee flag requires both switches and an exact JSON boolean", () => {
  assert.equal(PAYEE_DETAILS_ENABLED, false);
  assert.equal(payeeDetailsOn(true, { payee_details: true }), true);
  for (const flags of [null, [], {}, { payee_details: "true" }, { payee_details: 1 }]) {
    assert.equal(payeeDetailsOn(true, flags), false);
  }
  assert.equal(payeeDetailsOn(false, { payee_details: true }), false);
});

test("TW requires three-digit bank code and branch", () => {
  assert.equal(validatePayee("TW", input).bankCode, "012");
  assert.throws(() => validatePayee("TW", { ...input, bankCode: "12" }));
  assert.throws(() => validatePayee("TW", { ...input, branchCode: "" }));
});

test("US and JP use generic bank details without TW requirements", () => {
  for (const country of ["US", "JP"]) {
    const value = validatePayee(country, {
      ...input, bankCode: "", branchCode: "", details: { swift: "EXAMPLE1", routing: "123456789" },
    });
    assert.equal(value.bankCode, "");
    assert.equal(value.details.swift, "EXAMPLE1");
    assert.throws(() => validatePayee(country, { ...input, bankName: "" }));
  }
});

test("validation rejects invalid numbers, oversized holders and owner defaults", () => {
  assert.throws(() => validatePayee("US", { ...input, accountNumber: "<script>" }));
  assert.throws(() => validatePayee("US", { ...input, holderName: "x".repeat(201) }));
  assert.throws(() => validatePayee("US", {
    ...input, ownerContactId: "00000000-0000-0000-0000-000000000001",
  }));
});

test("lease overrides company default and missing data resolves to none", () => {
  assert.equal(resolvePayee("owner", "company"), "owner");
  assert.equal(resolvePayee(null, "company"), "company");
  assert.equal(resolvePayee(null, null), null);
});

test("payment instructions show full numbers or legacy suffix only", () => {
  assert.equal(payeeAccount("1234567890", "67890"), "1234567890");
  assert.equal(payeeAccount(null, "67890"), "…67890");
  assert.equal(payeeAccount(null, null), "");
});

test("tenant payment page contains no sample account literal and retains disclaimer", () => {
  const source = readFileSync(new URL("../app/t/pay/page.tsx", import.meta.url), "utf8");
  assert.equal(source.includes("88921"), false);
  assert.match(source, /i_pay_direct/);
});

test("tenant display preserves OFF fallback and renders enabled selection or none", () => {
  const company: PayeeAccount = {
    id: "company", holder_name: "Company", bank_name: "Bank",
    bank_code: "012", branch_code: "1234", account_number: "1234567890",
    account_last5: "67890", owner_contact_id: null, is_default_payee: true, details: {},
  };
  const owner: PayeeAccount = {
    ...company, id: "owner", owner_contact_id: "owner", is_default_payee: false,
    account_number: "9876543210",
  };
  assert.deepEqual(tenantPayeeDisplay({
    enabled: false, last5: "11111", account: owner,
  }), { kind: "legacy", last5: "11111" });
  assert.deepEqual(tenantPayeeDisplay({
    enabled: false, last5: null, account: company,
  }), { kind: "none" });
  for (const [override, expected] of [[owner, owner], [null, company]] as const) {
    assert.deepEqual(tenantPayeeDisplay({
      enabled: true, last5: "11111", account: resolvePayee(override, company),
    }), { kind: "account", account: expected, number: expected.account_number });
  }
  assert.deepEqual(tenantPayeeDisplay({
    enabled: true, last5: "11111", account: null,
  }), { kind: "none" });
  assert.deepEqual(tenantPayeeDisplay({
    enabled: true, last5: null,
    account: { ...company, account_number: null, account_last5: null },
  }), { kind: "none" });
  const legacy = { ...company, account_number: null };
  assert.deepEqual(tenantPayeeDisplay({
    enabled: true, last5: null, account: legacy,
  }), { kind: "account", account: legacy, number: "…67890" });
});

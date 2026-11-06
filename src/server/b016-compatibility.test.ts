import assert from "node:assert/strict";
import test from "node:test";
import { depositRefund, mf03Availability, profilePayeeReference, withB016Extension,
  type PayeeReferenceCandidate } from "./b016-compatibility";

const scope = { orgId: "org", propertyId: "property" };
const account: PayeeReferenceCandidate = { id: "account", orgId: "org", propertyId: "property", archivedAt: null, showToTenants: true };
test("profile payee reference matches B-003 organization/property/archive/visibility eligibility", () => {
  for (const propertyId of ["property", null]) {
    assert.deepEqual(profilePayeeReference(true, scope, { ...account, propertyId }),
      { status: "eligible", reference: { orgId: "org", accountId: "account" } });
  }
  for (const change of [{ orgId: "foreign" }, { propertyId: "wrong" }, { archivedAt: "2027-01-01" }, { showToTenants: false }]) {
    assert.deepEqual(profilePayeeReference(true, scope, { ...account, ...change }), { status: "unavailable", reference: null });
  }
  assert.deepEqual(profilePayeeReference(true, scope, null), { status: "unavailable", reference: null });
});

test("PAYEE OFF discloses nothing and does not inspect account details", () => {
  const unreadable = new Proxy(account, { get() { throw new Error("account must not be inspected"); } });
  for (const gate of [undefined, false, "true", null, 1, {}]) {
    assert.deepEqual(profilePayeeReference(gate, scope, unreadable), { status: "disabled", reference: null });
  }
  const sensitive = { ...account, accountNumber: "fixture-sensitive", bankName: "fixture-bank" };
  assert.deepEqual(profilePayeeReference(true, scope, sensitive), { status: "eligible", reference: { orgId: "org", accountId: "account" } });
});

test("absent, false and string true preserve legacy output/state with zero new writes or provider calls", async () => {
  const calls = { profile: 0, email: 0, fee: 0, provider: 0 };
  const financialState = { depositMinor: BigInt(10000), ownerPrepayMinor: BigInt(5000) };
  const original = { ...financialState };
  const legacy = { output: "legacy", financialState };
  const extension = async () => {
    calls.profile++; calls.email++; calls.fee++; calls.provider++;
    financialState.ownerPrepayMinor = BigInt(0);
    return { output: "extension", financialState };
  };
  for (const gate of [undefined, false, "true", null, 1, {}]) {
    assert.strictEqual(await withB016Extension(gate, legacy, extension), legacy);
    assert.deepEqual(financialState, original);
    assert.deepEqual(calls, { profile: 0, email: 0, fee: 0, provider: 0 });
  }
  assert.equal((await withB016Extension(true, legacy, extension)).output, "extension");
  assert.deepEqual(calls, { profile: 1, email: 1, fee: 1, provider: 1 });
});

test("deposit refund leaves owner prepay intact and cannot cover excess deductions", () => {
  const input = { depositMinor: BigInt(10000), deductionMinor: BigInt(2000), ownerPrepayMinor: BigInt(5000) };
  assert.deepEqual(depositRefund(input), { refundMinor: BigInt(8000), ownerPrepayMinor: BigInt(5000), prepayDrawdownMinor: BigInt(0) });
  assert.equal(input.ownerPrepayMinor, BigInt(5000));
  assert.throws(() => depositRefund({ ...input, deductionMinor: BigInt(10001) }), /invalid_deposit/);
  assert.throws(() => depositRefund({ ...input, depositMinor: 10000 as unknown as bigint }), /invalid_deposit/);
  assert.throws(() => depositRefund({ ...input, ownerPrepayMinor: BigInt(-1) }), /invalid_deposit/);
});

test("MF-03 invoice/prepay operations stay unavailable with no drawdown or confirmation workflow", () => {
  // There is no executor/callback capability in this proposal API.
  for (const event of ["company_invoice", "owner_prepay"] as const) {
    assert.deepEqual(mf03Availability(event), { status: "deferred", proposal: "PROP-MF-03", event, available: false, confirmationWorkflow: false });
  }
});

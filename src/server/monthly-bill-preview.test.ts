import test from "node:test";
import assert from "node:assert/strict";
import { composeMonthlyBillPreview } from "./monthly-bill-preview";

const input = {
  orgId: "org", leaseId: "lease", periodYm: "2026-11", currency: "USD",
  plannedRent: { amountMinor: "10000", planVersion: "v1", planDigest: "digest", sourceRefId: "charge" },
};

test("rent-only preview preserves component shape, empty credits and plan metadata", () => {
  const preview = composeMonthlyBillPreview(input);
  assert.deepEqual(preview.components, [
    { componentKey: "rent", amountMinor: "10000", currency: "USD", sourceRefKind: "lease_charge", sourceRefId: "charge" },
  ]);
  assert.deepEqual(preview.advanceCredits, []);
  assert.equal(preview.planVersion, "v1");
  assert.equal(preview.planDigest, "digest");
  assert.equal(preview.grossMinor, "10000");
  assert.equal(preview.creditOffsetMinor, "0");
  assert.equal(preview.netMinor, "10000");
  assert.equal(preview.carryMinor, "0");
});

test("excess approved credits produce carry instead of a negative claim", () => {
  const preview = composeMonthlyBillPreview({
    ...input,
    advanceCredits: [{ creditId: "credit", amountMinor: "12500", currency: "USD", status: "approved" }],
  });
  assert.equal(preview.creditOffsetMinor, "12500");
  assert.equal(preview.netMinor, "0");
  assert.equal(preview.carryMinor, "2500");
});

test("clawbacks reduce credits, carry is ignored and offset is clamped at zero", () => {
  for (const [clawback, expectedOffset] of [["200", "300"], ["600", "0"]]) {
    const preview = composeMonthlyBillPreview({
      ...input,
      advanceCredits: [
        { creditId: "approved", amountMinor: "500", currency: "USD", status: "approved" },
        { creditId: "clawback", amountMinor: clawback, currency: "USD", status: "clawback" },
        { creditId: "carry", amountMinor: "90000", currency: "USD", status: "carry" },
      ],
    });
    assert.equal(preview.creditOffsetMinor, expectedOffset);
    assert.equal(preview.netMinor, (BigInt(10000) - BigInt(expectedOffset)).toString());
  }
});

test("utilities and statement sources contribute to gross with source metadata", () => {
  const preview = composeMonthlyBillPreview({
    ...input,
    postedUtilities: [{ amountMinor: "300", sourceRefId: "utility" }],
    statementSources: [{ amountMinor: "700", componentKey: "repair", sourceRefKind: "repair_cost_item", sourceRefId: "repair" }],
  });
  assert.equal(preview.grossMinor, "11000");
  assert.deepEqual(preview.components[1], { componentKey: "utility", amountMinor: "300", currency: "USD", sourceRefKind: "manual", sourceRefId: "utility" });
  assert.deepEqual(preview.components[2], { componentKey: "repair", amountMinor: "700", currency: "USD", sourceRefKind: "repair_cost_item", sourceRefId: "repair" });
});

test("amounts must be canonical decimal integer strings", () => {
  for (const amountMinor of ["1.5", "01", "+1", "-0", " 1", "1e3", ""]) {
    assert.throws(() => composeMonthlyBillPreview({ ...input, plannedRent: { ...input.plannedRent, amountMinor } }), TypeError);
  }
});

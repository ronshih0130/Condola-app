import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { assertVendorEstimate, parseVendorEstimate } from "./vendor-estimate-rules";
const valid = () => ({ requestId: randomUUID(), expectedHeadId: null, amountMinor: "9007199254740993",
  currency: "USD", minorUnit: 2, workScope: "Replace valve", evidence: [] });
test("vendor estimates preserve bigint minor units and reject numeric/coerced/overflow amounts", () => {
  assert.equal(parseVendorEstimate(valid()).amountMinor, BigInt("9007199254740993"));
  assert.equal(parseVendorEstimate({ ...valid(), amountMinor: "9223372036854775807" }).amountMinor, BigInt("9223372036854775807"));
  for (const amountMinor of [1, 1.5, null, "1.2", "-1", "01", "1e3", "9223372036854775808"]) {
    assert.throws(() => parseVendorEstimate({ ...valid(), amountMinor }));
  }
  assert.throws(() => assertVendorEstimate({ ...parseVendorEstimate(valid()), amountMinor: 1 as unknown as bigint }));
});
test("vendor estimate requests pin head, bounded scope and unique UUID-only photo refs", () => {
  const id = randomUUID();
  assert.doesNotThrow(() => parseVendorEstimate({ ...valid(), evidence: [{ id }] }));
  for (const patch of [ { requestId: "bad" }, { expectedHeadId: undefined }, { workScope: " " },
    { evidence: [{ id, path: "private" }] }, { evidence: [{ id }, { id }] }, { evidence: [{ id: "bad" }] },
    { evidence: Array.from({ length: 9 }, () => ({ id: randomUUID() })) }, { currency: "usd" }, { minorUnit: 5 } ]) {
    assert.throws(() => parseVendorEstimate({ ...valid(), ...patch }));
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { parseRequestId } from "../app/api/monthly-rent-issue/_request-id";
import { assertNoNegativeClaim } from "./monthly-bill-rules";

test("monthly rent request id accepts a UUID unchanged", () => {
  const requestId = "123e4567-e89b-42d3-a456-426614174000";
  assert.equal(parseRequestId(requestId), requestId);
});

test("monthly rent request id rejects garbage", () => {
  for (const value of [undefined, null, 42, {}, [], "", "garbage",
    "123e4567-e89b-42d3-a456-426614174000\n"]) {
    assert.equal(parseRequestId(value), null);
  }
});

test("monthly rent claim clamps excess credit to zero and carries the balance", () => {
  assert.deepEqual(
    assertNoNegativeClaim({ grossMinor: "100", creditOffsetMinor: "150" }),
    { netMinor: "0", carryMinor: "50" },
  );
  assert.deepEqual(
    assertNoNegativeClaim({ grossMinor: "100", creditOffsetMinor: "40" }),
    { netMinor: "60", carryMinor: "0" },
  );
});

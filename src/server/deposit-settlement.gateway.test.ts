import assert from "node:assert/strict";
import test from "node:test";
import { getDepositSettlementStatus } from "./deposit-settlement";
import { FlowError } from "./errors";
import type { Session } from "./types";

test("deposit settlement remains disabled for valid org scopes", () => {
  for (const environment of ["live", "sandbox"] as const) {
    const session = {
      orgId: "10000000-0000-4000-8000-000000000001",
      environment,
    } as Session;
    assert.deepEqual(getDepositSettlementStatus(session), { enabled: false });
  }
});

test("deposit settlement validates org and environment before returning", () => {
  for (const orgId of ["", " ", null, undefined]) {
    const session = { orgId, environment: "live" } as unknown as Session;
    assert.throws(() => getDepositSettlementStatus(session), FlowError);
  }
  for (const environment of ["", "production", null, undefined]) {
    const session = { orgId: "10000000-0000-4000-8000-000000000001", environment } as unknown as Session;
    assert.throws(() => getDepositSettlementStatus(session), FlowError);
  }
});

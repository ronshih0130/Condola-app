import assert from "node:assert/strict";
import test from "node:test";
import { FlowError } from "./errors";
import { getRepairCostFoundationStatus } from "./repair-cost";
import type { Session } from "./types";

const orgId = "10000000-0000-4000-8000-000000000001";

test("repair cost foundation stays synchronously OFF for valid org scopes", () => {
  for (const environment of ["live", "sandbox"] as const) {
    for (const kind of ["staff", "tenant", "owner"] as const) {
      const session = { orgId, environment, kind } as Session;
      assert.deepEqual(getRepairCostFoundationStatus(session), { enabled: false });
    }
  }
});

test("repair cost foundation rejects invalid org scope before returning OFF", () => {
  for (const invalidOrgId of ["", " ", "\t\n", null, undefined, 42, {}]) {
    for (const environment of ["live", "sandbox"] as const) {
      const session = { orgId: invalidOrgId, environment } as unknown as Session;
      assert.throws(() => getRepairCostFoundationStatus(session), error =>
        error instanceof FlowError && error.key === "errors.forbidden");
    }
  }
});

test("repair cost foundation rejects invalid environments before returning OFF", () => {
  for (const environment of ["", "production", "LIVE", null, undefined, 42, {}]) {
    const session = { orgId, environment } as unknown as Session;
    assert.throws(() => getRepairCostFoundationStatus(session), error =>
      error instanceof FlowError && error.key === "errors.forbidden");
  }
});

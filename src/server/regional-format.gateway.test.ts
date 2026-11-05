import assert from "node:assert/strict";
import test from "node:test";
import { FlowError } from "./errors";
import { getRegionalFormatContext } from "./regional-format";
import type { Session } from "./types";

const orgIds = [
  "10000000-0000-4000-8000-000000000001",
  "10000000-0000-4000-8000-000000000002",
];

test("regional format stays synchronously OFF for every valid org scope", () => {
  for (const orgId of orgIds) {
    for (const environment of ["live", "sandbox"] as const) {
      for (const kind of ["staff", "tenant", "owner"] as const) {
        const session = {
          orgId, environment, kind, name: "Private Person",
          email: "private@example.test", address: "Private address",
        } as Session;
        const body = getRegionalFormatContext(session);
        assert.deepEqual(body, { enabled: false });
        assert.equal(JSON.stringify(body), '{"enabled":false}');
        assert.deepEqual(Object.keys(body), ["enabled"]);
      }
    }
  }
});

test("regional format rejects invalid org scope before returning OFF", () => {
  for (const orgId of ["", " ", "\t\n", null, undefined, 42, {}]) {
    for (const environment of ["live", "sandbox"] as const) {
      const session = { orgId, environment } as unknown as Session;
      assert.throws(() => getRegionalFormatContext(session), error =>
        error instanceof FlowError && error.key === "errors.forbidden");
    }
  }
});

test("regional format rejects invalid environments before returning OFF", () => {
  for (const environment of ["", "production", "LIVE", null, undefined, 42, {}]) {
    const session = { orgId: orgIds[0], environment } as unknown as Session;
    assert.throws(() => getRegionalFormatContext(session), error =>
      error instanceof FlowError && error.key === "errors.forbidden");
  }
});

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
        } as unknown as Session;
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

test("test-scoped flag overrides cannot activate the build-only gateway or bypass org pin", () => {
  const keys = ["REGIONAL_FORMATS", "REGIONAL_FORMATS_ENABLED", "regional_formats"];
  const previous = keys.map(key => process.env[key]);
  try {
    for (const value of [undefined, "false", "true", "TRUE", "1"]) {
      for (const key of keys) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      for (const orgId of orgIds) {
        const session = { orgId, environment: "live" } as Session;
        assert.deepEqual(getRegionalFormatContext(session), { enabled: false });
      }
      const unscoped = {
        orgId: "", environment: "live", request: { orgId: orgIds[0] },
      } as unknown as Session;
      assert.throws(() => getRegionalFormatContext(unscoped), error =>
        error instanceof FlowError && error.key === "errors.forbidden");
    }
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});

test("gateway never reads PII or caller-supplied regional context", () => {
  const session = { orgId: orgIds[0], environment: "live" } as Session;
  for (const key of ["name", "email", "address", "context", "explain", "jurisdictionCode"]) {
    Object.defineProperty(session, key, {
      get() { throw new Error("Unexpected private field access"); },
    });
  }
  Object.freeze(session);
  const body = getRegionalFormatContext(session);
  assert.equal(JSON.stringify(body), '{"enabled":false}');
  assert.deepEqual(Object.keys(body), ["enabled"]);
});

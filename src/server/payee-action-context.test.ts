import assert from "node:assert/strict";
import test from "node:test";
import { authorizePayeeAction, authorizePayeeApi } from "./payee-action-context";
import type { Session } from "./types";

const session = { userId: "synthetic", sessionId: "synthetic", orgId: "synthetic", environment: "live" } as Session;

test("a consent redirect is audited before it is rethrown, with no form data", async () => {
  const redirect = Object.assign(new Error("redirect"), { digest: "NEXT_REDIRECT;synthetic" });
  const events: unknown[] = [];
  await assert.rejects(authorizePayeeAction({
    readSession: async () => session,
    readContext: async () => { throw new Error("unexpected"); },
    requireConsent: async () => { events.push("consent"); throw redirect; },
    audit: async (...args) => { events.push(args); },
  }), (error: unknown) => error === redirect);
  assert.deepEqual(events, ["consent", [session]]);
});

test("audit failure supersedes consent redirect and valid consent does not log a denial", async () => {
  const failed = new Error("audit unavailable");
  await assert.rejects(authorizePayeeAction({
    readSession: async () => session, readContext: async () => null,
    requireConsent: async () => { throw new Error("consent redirect"); },
    audit: async () => { throw failed; },
  }), (error: unknown) => error === failed);
  const accepted = await authorizePayeeAction({
    readSession: async () => session, readContext: async () => null,
    requireConsent: async () => undefined,
    audit: async () => { throw new Error("unexpected audit"); },
  });
  assert.equal(accepted, session);
});

test("missing organization preserves the verified identity for the denial audit", async () => {
  const identity = { userId: "synthetic", sessionId: "synthetic", orgId: null, environment: null };
  const entries: unknown[] = [];
  await assert.rejects(authorizePayeeAction({
    readSession: async () => null, readContext: async () => identity,
    requireConsent: async () => { throw new Error("unexpected"); },
    audit: async (context) => { entries.push(context); },
  }), /Payee access unavailable/);
  assert.deepEqual(entries, [identity]);
});

test("API denials are audited before returning the original consent response", async () => {
  for (const status of [403, 409]) {
    const events: unknown[] = [];
    const denial = new Response(null, { status });
    const result = await authorizePayeeApi({
      readSession: async () => session, readContext: async () => null,
      requireConsent: async () => { events.push("consent"); return denial; },
      audit: async (context) => { events.push(["audit", context]); },
    });
    assert.deepEqual(events, ["consent", ["audit", session]]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.response, denial);
  }
});

test("API missing session audits its verified context, and audit failure withholds denial", async () => {
  const identity = { userId: "synthetic", sessionId: "synthetic", orgId: null, environment: null };
  const entries: unknown[] = [];
  const result = await authorizePayeeApi({
    readSession: async () => null, readContext: async () => identity,
    requireConsent: async () => { throw new Error("unexpected"); },
    audit: async (context) => { entries.push(context); },
  });
  assert.deepEqual(entries, [identity]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.response.status, 401);
});

test("API infrastructure failures return a private generic denial and stop business work", async () => {
  for (const stage of ["session", "context", "consent", "audit"] as const) {
    const events: string[] = [];
    const result = await authorizePayeeApi({
      readSession: async () => { if (stage === "session") throw new Error("sensitive session failure"); return stage === "context" ? null : session; },
      readContext: async () => { throw new Error("sensitive context failure"); },
      requireConsent: async () => { if (stage === "consent") throw new Error("sensitive consent failure"); return new Response(null, { status: 403 }); },
      audit: async () => { events.push("audit"); if (stage === "audit") throw new Error("sensitive audit failure"); },
    });
    if (result.ok) events.push("business");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.response.status, 503);
      assert.equal(result.response.headers.get("cache-control"), "private, no-store");
      assert.equal(result.response.headers.get("x-content-type-options"), "nosniff");
      assert.deepEqual(await result.response.json(), { ok: false });
    }
    assert.deepEqual(events, stage === "audit" || stage === "consent" ? ["audit"] : []);
  }
});

test("API successful consent returns the session without denial audit", async () => {
  const error = new Error("consent failure");
  const events: unknown[] = [];
  const deps = { readSession: async () => session, readContext: async () => null,
    audit: async (context: unknown) => { events.push(context); } };
  assert.deepEqual(await authorizePayeeApi({ ...deps, requireConsent: async () => null }), { ok: true, session });
  assert.deepEqual(events, []);
  const failed = await authorizePayeeApi({ ...deps, requireConsent: async () => { throw error; } });
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.equal(failed.response.status, 503);
  assert.deepEqual(events, [session]);
});

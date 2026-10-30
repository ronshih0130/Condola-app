import assert from "node:assert/strict";
import test from "node:test";
import { authorizePayeeAction } from "./payee-action-context";
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

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { claimIdempotentSubmit, rememberIdempotentSubmit, stableStringify } from "./idempotency";

const scope = { orgId: "org-1", userId: "user-1" };

test("two different property payloads both save, and a triple-click saves one", () => {
  const records: Parameters<typeof rememberIdempotentSubmit>[0] = [];
  let seq = 0;
  const mint = () => `prop-${++seq}`;
  const first = { ...scope, token: "token-a", hash: stableStringify({ name: "松德一" }) };
  const again = rememberIdempotentSubmit(records, first, mint);
  const triple = rememberIdempotentSubmit(records, first, mint);
  const fourth = rememberIdempotentSubmit(records, first, mint);
  assert.equal(again, "prop-1");
  assert.equal(triple, "prop-1");
  assert.equal(fourth, "prop-1");
  assert.equal(records.length, 1);

  const second = rememberIdempotentSubmit(records, { ...scope, token: "token-b", hash: stableStringify({ name: "松德二" }) }, mint);
  assert.equal(second, "prop-2");
  assert.equal(records.length, 2);
});

test("the same token with a different payload does not replay the first property", () => {
  const records = [
    { id: "prop-1", orgId: "org-1", userId: "user-1", token: "stuck-token", hash: stableStringify({ name: "第一棟" }) },
  ];
  const claim = claimIdempotentSubmit(records, {
    orgId: "org-1",
    userId: "user-1",
    token: "stuck-token",
    hash: stableStringify({ name: "第二棟" }),
  });
  assert.deepEqual(claim, { action: "create" });
  const otherUser = claimIdempotentSubmit(records, {
    orgId: "org-1",
    userId: "user-2",
    token: "stuck-token",
    hash: stableStringify({ name: "第一棟" }),
  });
  assert.deepEqual(otherUser, { action: "create" });
});

test("the property form mints a random token per mount and the server claims org, user, and token", () => {
  const wizard = readFileSync(new URL("./components/property-wizard.tsx", import.meta.url), "utf8");
  const domain = readFileSync(new URL("./server/domain.ts", import.meta.url), "utf8");
  assert.match(wizard, /useMountSubmitToken/);
  assert.doesNotMatch(wizard, /useId\(/);
  assert.match(readFileSync(new URL("./components/submit-token.tsx", import.meta.url), "utf8"), /crypto\.randomUUID/);
  assert.match(domain, /claimIdempotentSubmit/);
  assert.match(domain, /submitUser/);
  assert.match(domain, /idempotencyLockKey\("property"/);
});

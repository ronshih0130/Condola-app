import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const script = readFileSync("public/line-bootstrap.js", "utf8");
test("LIFF redirect processing precedes URL normalization and preserves the opaque invitation flow", async () => {
 const events: string[] = [];
 await runInNewContext(script, {
  document: { getElementById: () => ({ textContent: JSON.stringify({ liffId: "local", orgId: "org", flow: "opaque", csrf: "proof" }) }) },
  window: { liff: { init: async () => { events.push("init"); }, isLoggedIn: () => false,
   login: ({ redirectUri }: { redirectUri: string }) => { events.push(redirectUri); } } },
  history: { replaceState: () => events.push("normalize") },
  location: { origin: "https://local.test", pathname: "/t/liff" },
  fetch: () => { throw new Error("unexpected request"); },
 });
 assert.deepEqual(events, ["init", "normalize", "https://local.test/t/liff?flow=opaque"]);
});
test("LIFF sends its ID token only to the same-origin session endpoint without persisting it", async () => {
 const calls: { path: string; body: Record<string, string> }[] = [], next: string[] = [];
 await runInNewContext(script, {
  document: { getElementById: () => ({ textContent: JSON.stringify({ liffId: "local", orgId: "org", flow: null, csrf: "proof", persona: "vendor" }) }) },
  window: { liff: { init: async () => {}, isLoggedIn: () => true, getIDToken: () => "local-id-token" } },
  history: { replaceState: () => {} }, location: { pathname: "/v/liff", assign: (value: string) => next.push(value) },
  fetch: async (path: string, options: { body: string }) => {
   calls.push({ path, body: JSON.parse(options.body) });
   return { ok: true, json: async () => path.endsWith("flows") ? { flow: "opaque" } : { next: "/vendor-account" } };
  },
 });
 assert.deepEqual(calls, [
  { path: "/api/line/flows", body: { purpose: "login", orgId: "org", persona: "vendor", csrf: "proof" } },
  { path: "/api/line/session", body: { flow: "opaque", idToken: "local-id-token", csrf: "proof" } },
 ]);
 assert.deepEqual(next, ["/vendor-account"]);
});

test("existing account chooser posts server-rendered company/persona with CSRF and never initializes LINE", async () => {
 const calls: { path: string; body: unknown }[] = [], next: string[] = [];
 let click: (() => Promise<void>) | undefined;
 const button = { dataset: { lineOrg: "owned-org", linePortal: "owner" }, disabled: false,
  addEventListener: (_event: string, callback: () => Promise<void>) => { click = callback; } };
 await runInNewContext(script, {
  document: { getElementById: () => ({ textContent: JSON.stringify({ csrf: "proof" }) }), querySelectorAll: () => [button] },
  window: { liff: { init: () => { throw new Error("unneeded provider login"); } } },
  location: { assign: (path: string) => next.push(path) },
  fetch: async (path: string, options: { body: string }) => {
   calls.push({ path, body: JSON.parse(options.body) }); return { ok: true, json: async () => ({ next: "/o/statements" }) };
  },
 });
 assert.ok(click); await click();
 assert.deepEqual(calls, [{ path: "/api/line/portal", body: { orgId: "owned-org", persona: "owner", csrf: "proof" } }]);
 assert.deepEqual(next, ["/o/statements"]); assert.equal(button.disabled, false);
});
test("lost cookies or a refused flow never navigates with the ID token", async () => {
 const calls: string[] = [], next: string[] = [];
 await runInNewContext(script, {
  document: { getElementById: () => ({ textContent: JSON.stringify({ liffId: "local", orgId: "org", flow: null, csrf: "proof", persona: "owner" }) }) },
  window: { liff: { init: async () => {}, isLoggedIn: () => true, getIDToken: () => "private-token" } },
  history: { replaceState: () => {} }, location: { pathname: "/o/liff", assign: (value: string) => next.push(value) },
  fetch: async (path: string) => { calls.push(path); return { ok: false }; },
 });
 assert.deepEqual(calls, ["/api/line/flows"]); assert.deepEqual(next, []);
});

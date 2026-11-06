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
  fetch: async (path: string, options: { body?: string }) => {
   calls.push({ path, body: options.body ? JSON.parse(options.body) : {} });
   return { ok: true, json: async () => path.endsWith("flows") ? { flow: "opaque" } : { next: "/vendor-account" } };
  },
 });
 assert.deepEqual(calls, [
  { path: "/api/line/flows", body: { purpose: "login", orgId: "org", persona: "vendor", csrf: "proof" } },
  { path: "/api/line/session", body: { flow: "opaque", idToken: "local-id-token", csrf: "proof" } },
  { path: "/api/line/links", body: {} },
 ]);
 assert.deepEqual(next, ["/vendor-account"]);
});

test("logged-out LINE SDK never diverts account settings before the user chooses binding", async () => {
 const events: string[] = [];
 const form = { elements: { consent: { checked: true } }, onsubmit: undefined as undefined | ((e: { preventDefault(): void }) => Promise<void>) };
 const nodes: Record<string, unknown> = {
  "line-bootstrap": { textContent: JSON.stringify({ liffId: "local", orgId: "org", flow: null, csrf: "proof", persona: "tenant", purpose: "manage" }) },
  "line-confirm": form, "line-unlink": {}, "line-revoke": {}, "line-submit": { disabled: true }, "line-status": { hidden: true },
 };
 await runInNewContext(script, {
  document: { getElementById: (id: string) => nodes[id] },
  window: { liff: { init: async () => { events.push("init"); }, isLoggedIn: () => false, login: ({ redirectUri }: { redirectUri: string }) => events.push(redirectUri) } },
  history: { replaceState: () => events.push("normalize") }, location: { origin: "https://local.test", pathname: "/t/liff" },
  fetch: () => { throw new Error("No request before user action"); },
 });
 assert.deepEqual(events, ["init", "normalize"]);
 await form.onsubmit!({ preventDefault() {} });
 assert.deepEqual(events, ["init", "normalize", "https://local.test/t/liff?org=org&mode=manage"]);
});

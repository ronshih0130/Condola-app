import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const script = readFileSync("public/line-bootstrap.js", "utf8");
for (const [persona, pathname] of [["tenant", "/t/liff"], ["vendor", "/v/liff"], ["owner", "/o/liff"]] as const) {
 test(`${persona} LIFF redirect processing precedes URL normalization and preserves the opaque invitation flow`, async () => {
  const events: string[] = [];
  await runInNewContext(script, {
   document: { getElementById: () => ({ textContent: JSON.stringify({ liffId: "local", orgId: "org", flow: "opaque", csrf: "proof", persona }) }) },
   window: { liff: { init: async () => { events.push("init"); }, isLoggedIn: () => false,
    login: ({ redirectUri }: { redirectUri: string }) => { events.push(redirectUri); } } },
   history: { replaceState: () => events.push("normalize") },
   location: { origin: "https://local.test", pathname },
   fetch: () => { throw new Error("unexpected request"); },
  });
  assert.deepEqual(events, ["init", "normalize", `https://local.test${pathname}?flow=opaque`]);
 });
}
test("an unknown persona never initializes LINE or sends a request", async () => {
 const events: string[] = [];
 await runInNewContext(script, {
  document: { getElementById: () => ({ textContent: JSON.stringify({ liffId: "local", orgId: "org", flow: "opaque", csrf: "proof" }) }), querySelectorAll: () => [] },
  window: { liff: { init: async () => { events.push("init"); }, isLoggedIn: () => true, getIDToken: () => "private-token" } },
  history: { replaceState: () => events.push("normalize") }, location: { origin: "https://local.test", pathname: "/t/liff", assign: (v: string) => events.push(v) },
  fetch: async (path: string) => { events.push(path); return { ok: true, json: async () => ({ flow: "opaque", next: "/t" }) }; },
 });
 assert.deepEqual(events, []);
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
test("vendor navigation is limited to the landings the session endpoint returns for vendor flows", async () => {
 for (const [landing, allowed] of [["/v/liff/job", true], ["/vendor-account", true], ["/consent?next=%2Fvendor-account", true],
  ["/t", false], ["/o/statements", false], ["//evil.test/v/liff/job", false], ["https://evil.test/", false], ["/vendor-account?token=x", false]] as const) {
  const next: string[] = [];
  await runInNewContext(script, {
   document: { getElementById: () => ({ textContent: JSON.stringify({ liffId: "local", orgId: "org", flow: "opaque", csrf: "proof", persona: "vendor" }) }) },
   window: { liff: { init: async () => {}, isLoggedIn: () => true, getIDToken: () => "local-id-token" } },
   history: { replaceState: () => {} }, location: { origin: "https://local.test", pathname: "/v/liff", assign: (value: string) => next.push(value) },
   fetch: async () => ({ ok: true, json: async () => ({ next: landing }) }),
  });
  assert.deepEqual(next, allowed ? [landing] : [], landing);
 }
});
test("tenant LIFF confirms the session cookie before navigating to the tenant portal", async () => {
 const calls: { path: string; body: Record<string, string> }[] = [], next: string[] = [];
 await runInNewContext(script, {
  document: { getElementById: () => ({ textContent: JSON.stringify({ liffId: "local", orgId: "org", flow: null, csrf: "proof", persona: "tenant" }) }) },
  window: { liff: { init: async () => {}, isLoggedIn: () => true, getIDToken: () => "local-id-token" } },
  history: { replaceState: () => {} }, location: { pathname: "/t/liff", assign: (value: string) => next.push(value) },
  fetch: async (path: string, options: { body?: string }) => {
   calls.push({ path, body: options.body ? JSON.parse(options.body) : {} });
   return { ok: true, json: async () => path.endsWith("flows") ? { flow: "opaque" } : { next: "/t" } };
  },
 });
 assert.deepEqual(calls, [
  { path: "/api/line/flows", body: { purpose: "login", orgId: "org", persona: "tenant", csrf: "proof" } },
  { path: "/api/line/session", body: { flow: "opaque", idToken: "local-id-token", csrf: "proof" } },
  { path: "/api/line/links", body: {} },
 ]);
 assert.deepEqual(next, ["/t"]);
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

test("existing account chooser posts server-rendered company/persona with CSRF and never initializes LINE", async () => {
 const calls: { path: string; body: unknown }[] = [], next: string[] = [];
 let click: (() => Promise<void>) | undefined;
 const button = { dataset: { lineOrg: "owned-org", linePortal: "owner" }, disabled: false,
  addEventListener: (_event: string, callback: () => Promise<void>) => { click = callback; } };
 await runInNewContext(script, {
  document: { getElementById: () => ({ textContent: JSON.stringify({ csrf: "proof", persona: "owner" }) }), querySelectorAll: () => [button] },
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
test("the portal chooser is owner-only: tenant and vendor entries never bind [data-line-portal]", async () => {
 for (const persona of ["tenant", "vendor"] as const) {
  let bound = false;
  const button = { dataset: { lineOrg: "owned-org", linePortal: "owner" }, disabled: false, addEventListener: () => { bound = true; } };
  await runInNewContext(script, {
   document: { getElementById: (id: string) => id === "line-bootstrap" ? { textContent: JSON.stringify({ csrf: "proof", persona }) } : null, querySelectorAll: () => [button] },
   window: {}, location: { assign: () => { throw new Error("unexpected navigation"); } },
   fetch: () => { throw new Error("unexpected request"); },
  });
  assert.equal(bound, false, persona);
 }
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

import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import { vendorLineMatchCopy as copy } from "../../i18n/lanes/vendor-line-match";
import * as http from "./login-routes";
import { vendorMatchContextOn } from "./vendor-match";
import { lineHash } from "./login-token";
import type { Client } from "pg";

const requireHere = createRequire(import.meta.url);
const proof = { browser: "b".repeat(43), csrf: "c".repeat(43) }, job = "11111111-1111-4111-8111-111111111111";
// Two flows of one browser: "flow" is the original tab's cookie handle; a second-tab retry replaces it with "f"x43.
const FLOW_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", FLOW_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", newer = "22222222-2222-4222-8222-222222222222";
const flowOf = (handle: string) => handle === "f".repeat(43) ? FLOW_B : FLOW_A;
const digest = (flow: string, ids: string[]) => createHash("sha256").update(`${flow}:${ids.join(",")}`).digest("hex");
function setup(opts: { failedList?: boolean; conflict?: boolean; next?: string; expired?: boolean } = {}) {
 const calls: string[] = [];
 // Emulates app.b101_review: each flow's frozen candidate list; remove/confirm require that flow's current digest.
 const frozen: Record<string, string[]> = { [FLOW_A]: [job], [FLOW_B]: [job, newer] };
 const mocks: Record<string, unknown> = {
  "next/server": requireHere("next/server"),
  "../auth": { SESSION_COOKIE: "condola_session", sessionCookie: (token: string) => ({ name: "condola_session", value: token, options: { httpOnly: true, path: "/", sameSite: "lax" } }) },
  "../org-scope": { ORG_COOKIE: "condola_org" }, "../portal-role": { PORTAL_ROLE_COOKIE: "condola_portal_role" },
  "../../i18n/lanes/vendor-line-match": { vendorLineMatchCopy: copy },
  "./login-token": requireHere("./login-token"),
  "./login-routes": { ...http, envGate: () => {} },
  "./vendor-match": {
   // Expired 5-minute window: only proof-bound recovery (back/retry) still resolves the committed binding's entry.
   vendorMatchContextOn: async (_c: unknown, handle: string, _p: unknown, recovery = false) => {
    if (opts.expired && !recovery) { calls.push("expired"); throw new (requireHere("./login-token").LineError)(404, "not_found"); }
    return { f: { id: flowOf(handle), org_id: "org-a" }, back: "/v/original-token", jobToken: "original-token" };
   },
   vendorMatchReviewOn: async (_c: unknown, f: { id: string }, action: string, jobId?: string, snapshot?: string) => {
    calls.push(action); if (opts.failedList) throw new Error("unavailable");
    if (action !== "list" && snapshot !== digest(f.id, frozen[f.id])) throw new (requireHere("./login-token").LineError)(404, "not_found");
    if (action === "remove") frozen[f.id] = frozen[f.id].filter(id => id !== jobId);
    return { jobs: frozen[f.id].map(id => ({ id, description: '<script>alert("no")</script>' })), userId: "user-a", identityId: "identity-a", orgId: "org-a",
     snapshot: digest(f.id, frozen[f.id]) };
   },
  },
  "./login-link": {
   lineTransaction: async (fn: (c: unknown) => unknown) => fn({}),
   sessionOn: async () => opts.conflict ? { user_id: "other" } : null,
   credentialsOn: async () => { calls.push("credentials"); },
   lineSessionOn: async () => { calls.push("session"); return "private-session-token"; },
   consentNextOn: async () => opts.next ?? "/vendor-account",
   createLineFlow: async (input: { jobToken: string; orgId: string; vendorMatch: string }) => {
    assert.equal(input.jobToken, "original-token"); assert.equal(input.orgId, "org-a"); assert.equal(input.vendorMatch, "true");
    calls.push("retry"); return { flow: "f".repeat(43) };
   },
  },
 };
 const code = ts.transpileModule(readFileSync("src/server/line/vendor-match-routes.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
 const exports: Record<string, (r: Request) => Promise<Response>> = {};
 new Function("require", "exports", code)((name: string) => { assert.ok(name in mocks, name); return mocks[name]; }, exports);
 // POSTs default to the original tab's rendered flow and snapshot; `handle` sets the flow cookie.
 const req = (input?: Record<string, string>, origin = "https://app.test", handle = "flow") => new Request("https://app.test/v/link", { method: input ? "POST" : "GET", headers: {
  Origin: origin, "Content-Type": "application/json", Cookie: `${http.LINE_BROWSER_COOKIE}=${proof.browser}; ${http.LINE_CSRF_COOKIE}=${proof.csrf}; ${http.LINE_FLOW_COOKIE}=${handle}`,
 }, ...(input ? { body: JSON.stringify({ flow: FLOW_A, snapshot: digest(FLOW_A, [job]), ...input, csrf: proof.csrf }) } : {}) });
 return { calls, exports, req };
}
test("VEN-31 V-LINK renders escaped candidates and only approved copy with private headers, without issuing a session", async () => {
 const { exports, req, calls } = setup(); const r = await exports.vendorMatchGET(req()), html = await r.text();
 assert.equal(r.status, 200); assert.equal(r.headers.get("Cache-Control"), "no-store"); assert.equal(r.headers.get("Referrer-Policy"), "no-referrer");
 assert.equal(r.headers.get("set-cookie"), null); assert.ok(html.includes("&lt;script&gt;")); assert.ok(!html.includes('<script>alert("no")'));
 for (const key of ["title", "body", "remove", "continue", "note", "error", "retry", "back"] as const) assert.ok(html.includes(copy[key]));
 // screens.md V-LINK: the removal note is present only as a hidden element until a removal happens.
 assert.ok(html.includes(`<p id="match-note" hidden>${copy.note}</p>`)); assert.equal(html.split(copy.note).length, 2);
 assert.deepEqual(calls, ["list"]);
});
test("VEN-31 list failure shows approved recovery without leaking candidates", async () => {
 const { exports, req, calls } = setup({ failedList: true }); const r = await exports.vendorMatchGET(req()), html = await r.text();
 assert.ok(html.includes('id="match-review" hidden')); assert.ok(html.includes('id="match-error"><p role="alert">'));
 assert.ok(!html.includes(job)); assert.ok(html.includes('href="/v/original-token"')); assert.deepEqual(calls, ["list"]);
});
test("VEN-31 only confirmation can issue an HTTP-only session, after credentials and scope validation", async () => {
 for (const action of ["remove", "confirm"] as const) {
  const { exports, req, calls } = setup(); const r = await exports.vendorMatchPOST(req({ action, ...(action === "remove" ? { jobId: job } : {}) }));
  assert.equal(r.status, 200); const text = await r.text(); assert.ok(!text.includes("private-session-token"));
  assert.deepEqual(calls, action === "confirm" ? ["confirm", "credentials", "session"] : ["remove"]);
  if (action === "confirm") { assert.match(r.headers.get("set-cookie")!, /HttpOnly/); assert.match(r.headers.get("set-cookie")!, /Secure/); assert.equal(JSON.parse(text).next, "/vendor-account"); }
  else assert.equal(r.headers.get("set-cookie"), null);
 }
});
test("VEN-31 invalid actions, CSRF, injected identity/return URL or different session cannot mint a session", async () => {
 for (const input of [{ action: "confirm", returnUrl: "https://evil.test" }, { action: "confirm", userId: "other" }, { action: "remove", jobId: "bad" }] as Record<string, string>[]) {
  const { exports, req, calls } = setup(); assert.equal((await exports.vendorMatchPOST(req(input))).status, 400); assert.deepEqual(calls, []);
 }
 const csrf = setup(); assert.equal((await csrf.exports.vendorMatchPOST(csrf.req({ action: "confirm" }, "https://evil.test"))).status, 403); assert.deepEqual(csrf.calls, []);
 const conflict = setup({ conflict: true }); assert.equal((await conflict.exports.vendorMatchPOST(conflict.req({ action: "confirm" }))).status, 409); assert.deepEqual(conflict.calls, ["confirm"]);
});
test("VEN-31 retry uses only the proof-bound original entry", async () => {
 const { exports, req, calls } = setup(); const r = await exports.vendorMatchPOST(req({ action: "retry" }));
 assert.equal(r.status, 200); assert.deepEqual(await r.json(), { next: `/v/liff?flow=${"f".repeat(43)}` }); assert.deepEqual(calls, ["retry"]);
});
test("VEN-31 context: possession of a token/flow without matching browser proof cannot reach channel or candidate reads", async () => {
 let count = 0;
 const client = { query: async () => { count++; return { rows: [{ return_path: "/v/link", persona: "vendor", kind: "login", browser_hash: lineHash(proof.browser), csrf_hash: lineHash(proof.csrf) }] }; } } as unknown as Client;
 await assert.rejects(vendorMatchContextOn(client, "handle", { ...proof, browser: "wrong" }), (e: unknown) => (e as { status: number }).status === 404);
 assert.equal(count, 1);
});

test("VEN-31 disabled matching flow stops before OAuth admission or writes", async () => {
 const { flowOn } = await import("./login-link");
 const previous = process.env.LINE_PLATFORM_ENABLED; process.env.LINE_PLATFORM_ENABLED = "true";
 const calls: string[] = [];
 const client = { query: async (sql: string) => {
  calls.push(sql);
  if (sql.includes("app.b033_line_flows")) return { rows: [{ id: "flow", org_id: "org", persona: "vendor", return_path: "/v/link", line_channel_id: "channel",
   browser_hash: lineHash(proof.browser), csrf_hash: lineHash(proof.csrf), expires_at: new Date(Date.now() + 60000), consumed_at: null }] };
  if (sql.includes("FROM line_channels")) return { rows: [{ id: "channel", tenant_config_verified_at: new Date(), login_channel_id: "login", login_channel_secret_ref: "local-test" }] };
  if (sql.includes("app.b101_enabled")) return { rows: [{ enabled: false }] };
  throw new Error("Unexpected query");
 } } as unknown as Client;
 try {
  await assert.rejects(flowOn(client, "flow", proof), (e: unknown) => (e as { status: number }).status === 404);
  assert.equal(calls.length, 3); assert.ok(calls.every(s => !/INSERT|UPDATE/.test(s)));
 } finally { if (previous === undefined) delete process.env.LINE_PLATFORM_ENABLED; else process.env.LINE_PLATFORM_ENABLED = previous; }
});

test("VEN-31-AC4 / VEN-15-AC7: after the 5-minute window the page offers 「再試一次」, confirm is refused and retry restarts LINE sign-in", async () => {
 const { exports, req, calls } = setup({ expired: true });
 const html = await (await exports.vendorMatchGET(req())).text();
 assert.ok(html.includes('id="match-review" hidden')); assert.ok(html.includes(`<button type="button" id="match-retry" class="v-token-secondary">${copy.retry}</button>`));
 assert.ok(html.includes(copy.error)); assert.ok(html.includes('href="/v/original-token"')); assert.ok(!html.includes(job));
 const confirm = await exports.vendorMatchPOST(req({ action: "confirm" }));
 assert.equal(confirm.status, 404); assert.equal(confirm.headers.get("set-cookie"), null);
 const retry = await exports.vendorMatchPOST(req({ action: "retry" }));
 assert.equal(retry.status, 200); assert.deepEqual(await retry.json(), { next: `/v/liff?flow=${"f".repeat(43)}` });
 assert.match(retry.headers.get("set-cookie")!, new RegExp(`${http.LINE_FLOW_COOKIE}=${"f".repeat(43)}`));
 assert.deepEqual(calls, ["expired", "expired", "retry"], "no list/confirm/session after expiry");
});
test("VEN-31 context: an expired flow is refused except for proof-bound recovery", async () => {
 const row = { id: "flow", org_id: "org-a", return_path: "/v/link", persona: "vendor", kind: "login", browser_hash: lineHash(proof.browser), csrf_hash: lineHash(proof.csrf),
  expires_at: new Date(Date.now() - 1000), verified_hash: "v", consumed_at: new Date() };
 const client = { query: async (sql: string) => {
  if (sql.includes("app.b033_line_flows")) return { rows: [row] };
  if (sql.includes("FROM line_channels")) return { rows: [{ id: "channel", tenant_config_verified_at: new Date(), login_channel_id: "login", login_channel_secret_ref: "local-test" }] };
  if (sql.includes("app.b101_enabled")) return { rows: [{ enabled: true }] };
  if (sql.includes("app.b035_vendor_flows")) return { rows: [{ token: "original-token" }] };
  throw new Error(`Unexpected query: ${sql}`);
 } } as unknown as Client;
 const previous = process.env.LINE_PLATFORM_ENABLED; process.env.LINE_PLATFORM_ENABLED = "true";
 try {
  await assert.rejects(vendorMatchContextOn(client, "handle", proof), (e: unknown) => (e as { status: number }).status === 404);
  assert.equal((await vendorMatchContextOn(client, "handle", proof, true)).back, "/v/original-token");
 } finally { if (previous === undefined) delete process.env.LINE_PLATFORM_ENABLED; else process.env.LINE_PLATFORM_ENABLED = previous; }
});

const bootstrap = (html: string) => JSON.parse(/id="match-bootstrap">([^<]+)</.exec(html)![1]) as { csrf: string; flow: string; snapshot: string };
test("review r1 finding 2: V-LINK renders the exact flow and frozen-snapshot digest; remove-then-confirm in one tab issues the session", async () => {
 const { exports, req, calls } = setup();
 const shown = bootstrap(await (await exports.vendorMatchGET(req())).text());
 assert.deepEqual(shown, { csrf: proof.csrf, flow: FLOW_A, snapshot: digest(FLOW_A, [job]) });
 const removed = await exports.vendorMatchPOST(req({ action: "remove", jobId: job, flow: shown.flow, snapshot: shown.snapshot }));
 assert.equal(removed.status, 200); const next = await removed.json(); assert.equal(next.snapshot, digest(FLOW_A, []));
 // The pre-removal digest is now stale even within the same flow.
 const stale = await exports.vendorMatchPOST(req({ action: "confirm", flow: shown.flow, snapshot: shown.snapshot }));
 assert.equal(stale.status, 404); assert.equal(stale.headers.get("set-cookie"), null);
 const done = await exports.vendorMatchPOST(req({ action: "confirm", flow: shown.flow, snapshot: next.snapshot }));
 assert.equal(done.status, 200); assert.match(done.headers.get("set-cookie")!, /condola_session=private-session-token/);
 assert.deepEqual(calls, ["list", "remove", "confirm", "confirm", "credentials", "session"]);
});
test("review r1 finding 2: a mismatched or malformed flow/snapshot is refused before any review, write or session", async () => {
 for (const input of [{ action: "confirm", flow: FLOW_B }, { action: "remove", jobId: job, flow: FLOW_B }, { action: "retry", flow: FLOW_B }] as Record<string, string>[]) {
  const { exports, req, calls } = setup(); const r = await exports.vendorMatchPOST(req(input));
  assert.equal(r.status, 404, JSON.stringify(input)); assert.equal(r.headers.get("set-cookie"), null); assert.deepEqual(calls, []);
 }
 for (const input of [{ action: "confirm", flow: "" }, { action: "confirm", snapshot: "" }, { action: "remove", jobId: job, snapshot: "zz" }, { action: "retry", snapshot: "x" }] as Record<string, string>[]) {
  const { exports, req, calls } = setup(); assert.equal((await exports.vendorMatchPOST(req(input))).status, 400, JSON.stringify(input)); assert.deepEqual(calls, []);
 }
});
test("review r1 finding 2: after a second-tab retry and sign-in, the original tab cannot approve the newer unseen list", async () => {
 const { exports, req, calls } = setup();
 const original = bootstrap(await (await exports.vendorMatchGET(req())).text());
 // Second tab: same CSRF; retry replaces the flow cookie and its OAuth snapshots a newly assigned job.
 const retry = await exports.vendorMatchPOST(req({ action: "retry", flow: original.flow, snapshot: original.snapshot }));
 assert.equal(retry.status, 200);
 const handle = new RegExp(`${http.LINE_FLOW_COOKIE}=([^;]+)`).exec(retry.headers.get("set-cookie")!)![1]; assert.equal(handle, "f".repeat(43));
 const second = bootstrap(await (await exports.vendorMatchGET(req(undefined, undefined, handle))).text());
 assert.deepEqual(second, { csrf: original.csrf, flow: FLOW_B, snapshot: digest(FLOW_B, [job, newer]) });
 calls.length = 0;
 // The original tab acts with what IT rendered while the cookie now names the second flow.
 for (const input of [{ action: "confirm", flow: original.flow, snapshot: original.snapshot }, { action: "remove", jobId: job, flow: original.flow, snapshot: original.snapshot },
  { action: "retry", flow: original.flow }, { action: "confirm", flow: FLOW_B, snapshot: original.snapshot }] as Record<string, string>[]) {
  const r = await exports.vendorMatchPOST(req(input, undefined, handle));
  assert.equal(r.status, 404, JSON.stringify(input)); assert.equal(r.headers.get("set-cookie"), null);
 }
 assert.deepEqual(calls, ["confirm"], "only the forged-flow attempt reached the review, which refused the stale digest");
 // The second tab, which rendered the newer list, still confirms normally.
 const done = await exports.vendorMatchPOST(req({ action: "confirm", flow: second.flow, snapshot: second.snapshot }, undefined, handle));
 assert.equal(done.status, 200); assert.match(done.headers.get("set-cookie")!, /HttpOnly/);
});

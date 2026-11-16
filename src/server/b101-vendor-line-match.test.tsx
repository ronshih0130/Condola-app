import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { Client } from "pg";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { continueInLine } from "../app/v/[token]/continue-in-line";
import { VendorLineMatchEntry } from "../components/v3/vendor/line-match-entry";
import { vendorLineMatchCopy as copy } from "../i18n/lanes/vendor-line-match";
import { sessionFromFlowOn, type LineFlow } from "./line/login-link";

const script = readFileSync("public/line-bootstrap.js", "utf8");
test("VEN-31-AC1: explicit match intent keeps token in POST bodies and uses existing B035 entry", async () => {
 const calls: { path: string; input: Record<string, string> }[] = [], next: string[] = [];
 const flow = "f".repeat(43);
 const ok = await continueInLine("private-job-token", { navigate: v => next.push(v), fetch: async (path, init) => {
  assert.equal(init.referrerPolicy, "no-referrer"); assert.equal(init.credentials, "same-origin");
  calls.push({ path, input: JSON.parse(String(init.body)) });
  return { ok: true, json: async () => path === "/v/liff" ? { csrf: "proof" } : { liffUrl: `/v/liff?flow=${flow}` } };
 } }, true);
 assert.equal(ok, true); assert.deepEqual(next, [`/v/liff?flow=${flow}`]);
 assert.deepEqual(calls, [{ path: "/v/liff", input: { jobToken: "private-job-token" } },
  { path: "/api/line/flows", input: { purpose: "login", persona: "vendor", jobToken: "private-job-token", csrf: "proof", vendorMatch: "true" } }]);
 const html = renderToStaticMarkup(<VendorLineMatchEntry token="private-job-token" />);
 assert.ok(html.includes(copy.entry)); assert.ok(!html.includes("private-job-token"));
});
for (const present of [true, false]) test(`VEN-31-AC2: OAuth state/nonce/PKCE path required with SDK present=${present}`, async () => {
 const next: string[] = [], posts: Record<string, string>[] = [];
 await runInNewContext(script, {
  document: { getElementById: () => ({ textContent: JSON.stringify({ vendorMatch: true, persona: "vendor", flow: present ? "opaque" : null, orgId: "org", csrf: "proof" }) }) },
  window: { liff: { init: () => { throw new Error("Bare SDK token must not bind"); } } },
  location: { assign: (v: string) => next.push(v) },
  fetch: async (_path: string, init: RequestInit) => { posts.push(JSON.parse(String(init.body))); return { ok: true, json: async () => ({ flow: "opaque" }) }; },
 });
 assert.deepEqual(next, ["/api/line/login/start?flow=opaque"]);
 assert.deepEqual(posts, present ? [] : [{ purpose: "login", persona: "vendor", orgId: "org", vendorMatch: "true", csrf: "proof" }]);
});
const renderedFlow = "33333333-3333-4333-8333-333333333333", shownSnapshot = "a".repeat(64), afterRemoval = "b".repeat(64);
test("VEN-15-AC4: browser removal is server-confirmed, busy-safe, text-only and announces the approved toast", async () => {
 const row = { dataset: { job: "job-a" }, querySelector: () => ({ textContent: "<img onerror=bad>" }), remove: () => { removed = true; } };
 let removed = false, release!: () => void, calls = 0;
 const toast = { dataset: { template: copy.removed }, textContent: "" }, note = { hidden: true };
 const button = { dataset: { remove: "job-a" }, disabled: false, onclick: undefined as undefined | (() => Promise<void>) };
 const confirm = { onclick: undefined as undefined | (() => Promise<void>) }, bodies: Record<string, string>[] = [], next: string[] = [];
 const nodes: Record<string, unknown> = { "match-bootstrap": { textContent: JSON.stringify({ csrf: "proof", flow: renderedFlow, snapshot: shownSnapshot }) }, "match-review": { hidden: false }, "match-error": { hidden: true }, "match-toast": toast, "match-note": note, "match-confirm": confirm, "match-retry": {} };
 runInNewContext(readFileSync("public/vendor-line-match.js", "utf8"), {
  document: { getElementById: (id: string) => nodes[id], querySelector: () => row,
   querySelectorAll: (selector: string) => selector === "[data-job]" ? [row] : [button] },
  location: { assign: (v: string) => next.push(v) },
  fetch: async (path: string, init: RequestInit) => { calls++; assert.equal(path, "/v/link"); const input = JSON.parse(String(init.body)); bodies.push(input);
   if (input.action === "confirm") return { ok: true, json: async () => ({ next: "/vendor-account" }) };
   await new Promise<void>(r => { release = r; }); return { ok: true, json: async () => ({ jobs: [], snapshot: afterRemoval }) }; },
 });
 const first = button.onclick!(); await button.onclick!(); assert.equal(calls, 1); assert.equal(removed, false); assert.equal(note.hidden, true);
 release(); await first; assert.equal(removed, true); assert.equal(toast.textContent, copy.removed.replace("{工單}", "<img onerror=bad>"));
 assert.equal(note.hidden, false, "screens.md V-LINK: the removal note appears only after a removal");
 // Review r1 finding 2: every action carries the rendered flow and snapshot; remove-then-confirm uses the digest the removal returned.
 await confirm.onclick!(); assert.deepEqual(next, ["/vendor-account"]);
 assert.deepEqual(bodies, [{ action: "remove", csrf: "proof", flow: renderedFlow, snapshot: shownSnapshot, jobId: "job-a" },
  { action: "confirm", csrf: "proof", flow: renderedFlow, snapshot: afterRemoval }]);
});
test("review r1 finding 2: a removal response without a valid snapshot digest fails closed to the approved error state", async () => {
 const button = { dataset: { remove: "job-a" }, disabled: false, onclick: undefined as undefined | (() => Promise<void>) };
 const review = { hidden: false }, error = { hidden: true }, row = { dataset: { job: "job-a" }, querySelector: () => ({ textContent: "d" }), remove: () => {} };
 const nodes: Record<string, unknown> = { "match-bootstrap": { textContent: JSON.stringify({ csrf: "proof", flow: renderedFlow, snapshot: shownSnapshot }) }, "match-review": review, "match-error": error, "match-toast": { dataset: { template: copy.removed } }, "match-note": { hidden: true }, "match-confirm": {}, "match-retry": {} };
 runInNewContext(readFileSync("public/vendor-line-match.js", "utf8"), {
  document: { getElementById: (id: string) => nodes[id], querySelector: () => row, querySelectorAll: (s: string) => s === "[data-job]" ? [row] : [button] },
  fetch: async () => ({ ok: true, json: async () => ({ jobs: [] }) }),
 });
 await button.onclick!(); assert.equal(review.hidden, true); assert.equal(error.hidden, false);
});
test("VEN-31 migration: private gateways, explicit provenance, no opt-in or flag writes; legacy invite sync preserved", () => {
 const sql = readFileSync("supabase/migrations/20261115180000_b101_vendor_line_match.sql", "utf8");
 assert.doesNotMatch(sql, /GRANT (?:SELECT|INSERT|UPDATE|ALL).* ON (?:TABLE )?app\./);
 // The only platform_settings write is B-101's own default-OFF seed, which never changes an existing value.
 const seed = `INSERT INTO public.platform_settings(key,value) VALUES\n ('vendor_line_match','{"enabled":false,"allowed_org_ids":[]}'::jsonb) ON CONFLICT DO NOTHING;`;
 assert.equal(sql.split(seed).length, 2);
 assert.doesNotMatch(sql.replace(seed, ""), /(?:UPDATE|INSERT INTO) public\.(?:platform_settings|notifications|deliveries|organizations)/);
 assert.match(sql, /notification_opt_in,is_friend\)\s+VALUES\([^;]+false,false/);
 for (const name of ["b026_account_candidates", "b026_link_vendor_job"]) {
  const old = readFileSync("supabase/migrations/20261106220000_b026_vendor_accounts.sql", "utf8");
  const extract = (s: string) => new RegExp(`CREATE (?:OR REPLACE )?FUNCTION app.${name}\\([\\s\\S]*?END \\$\\$;`).exec(s)![0];
  const narrowed = "NOT (a.invite_id IS NULL AND a.line_identity_id IS NOT NULL)";
  assert.equal(extract(sql).split(narrowed).length, 2, `${name}: exactly one narrowed predicate`);
  const restored = extract(sql).replace("CREATE OR REPLACE", "CREATE").replace(`${narrowed} AND `, "").replace(` AND ${narrowed}`, "");
  assert.equal(restored, extract(old), "B026 body is otherwise byte-identical");
 }
 // Round-2 finding 3: an invitation-created account that once used LINE keeps B-026 auto-link (no exclusion on line_identity_id alone).
 assert.doesNotMatch(sql, /line_identity_id IS NULL/);
});

test("VEN-31-AC4: failed removal hides the list and exposes the approved recovery state", async () => {
 const button = { dataset: { remove: "job-a" }, disabled: false, onclick: undefined as undefined | (() => Promise<void>) };
 const review = { hidden: false }, error = { hidden: true };
 const nodes: Record<string, unknown> = { "match-bootstrap": { textContent: '{"csrf":"proof"}' }, "match-review": review, "match-error": error, "match-confirm": {}, "match-retry": {} };
 runInNewContext(readFileSync("public/vendor-line-match.js", "utf8"), {
  document: { getElementById: (id: string) => nodes[id], querySelectorAll: () => [button] },
  fetch: async () => ({ ok: false }),
 });
 await button.onclick!(); assert.equal(review.hidden, true); assert.equal(error.hidden, false); assert.equal(button.disabled, false);
});

const migration = readFileSync("supabase/migrations/20261115180000_b101_vendor_line_match.sql", "utf8");
const fn = (name: string) => new RegExp(`CREATE FUNCTION app\\.${name}\\([\\s\\S]*?\\n\\$\\$;|CREATE FUNCTION app\\.${name}\\([\\s\\S]*?END \\$\\$;`).exec(migration)![0];
test("B-101 own flag: app.b101_enabled requires the strict vendor_line_match platform allowlist and org flag before any other gate", () => {
 const body = fn("b101_enabled");
 assert.match(body, /SELECT coalesce\(\(SELECT o\.feature_flags->'vendor_line_match'='true'::jsonb\n AND f\.value->'enabled'='true'::jsonb AND jsonb_typeof\(f\.value->'allowed_org_ids'\)='array'\n AND f\.value->'allowed_org_ids' @> jsonb_build_array\(o\.id::text\)\n FROM public\.organizations o CROSS JOIN public\.platform_settings f\n WHERE o\.id=p_org AND f\.key='vendor_line_match'\),false\) AND\n app\.b026_accounts_enabled/);
 assert.match(fn("b101_lock"), /'vendor_line_match'\) FOR SHARE NOWAIT/);
 const registry = readFileSync("ops/flags.yaml", "utf8");
 assert.match(registry, /\n  vendor_line_match:\n    owner: [^\n]+\n    expires_at: [^\n]+\n    default: false\n/);
});
test("finding 1: a surviving contact link needs the exact current account, pending invitations win, and every created account is logged", () => {
 const body = fn("b101_match");
 assert.match(body, /OR \(EXISTS\(SELECT 1 FROM public\.line_account_links WHERE org_id=c\.org_id AND contact_id=c\.id AND status='linked' AND unlinked_at IS NULL\)\n   AND \(a\.user_id IS NULL OR a\.user_id IS DISTINCT FROM i\.user_id\)\)/);
 // Review r1 finding 1: ANY live invitation blocks LINE first binding; no invitee (user_id) exemption.
 assert.match(body, /OR \(a\.user_id IS NULL AND EXISTS\(SELECT 1 FROM app\.b026_vendor_account_invites WHERE org_id=c\.org_id AND contact_id=c\.id\n   AND claimed_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp\(\)\)\)\n THEN RAISE EXCEPTION 'identity_conflict'/);
 assert.doesNotMatch(body, /b026_vendor_account_invites[^;]*user_id IS DISTINCT FROM actor/);
 assert.match(body, /INSERT INTO app\.b026_vendor_accounts\(org_id,contact_id,user_id,line_identity_id\) VALUES\(c\.org_id,c\.id,actor,i\.id\);\n  created:=true;/);
 assert.match(body, /IF first_binding OR created THEN\n  INSERT INTO app\.b026_vendor_link_events[^;]+'line_first_binding'\);\n  INSERT INTO public\.audit_log/);
 assert.doesNotMatch(migration, /b026_rebind_vendor_account/, "the staff rebind gateway is not replaced");
});
const plpgsql = (name: string) => new RegExp(`CREATE FUNCTION app\\.${name}\\([\\s\\S]*?END \\$\\$;`).exec(migration)![0];
test("round-2 finding 2: only LINKED contact links are conflicts; an unlinked historical row never blocks a new binding", () => {
 const body = plpgsql("b101_match");
 assert.match(body, /OR EXISTS\(SELECT 1 FROM public\.line_account_links WHERE org_id=c\.org_id AND contact_id=c\.id AND status='linked' AND unlinked_at IS NULL\n   AND \(login_identity_id IS DISTINCT FROM i\.id OR persona IS DISTINCT FROM 'vendor'\)\)/);
 // Other identities' historical (unlinked) rows never block. The one exception (review r3) is THIS identity's own
 // history with the contact, any status: it may return only to the exact current account (no rebind bypass).
 for (const clause of body.split("\n").filter(l => l.includes("FROM public.line_account_links WHERE org_id=c.org_id AND contact_id=c.id") && !l.includes("login_identity_id=i.id)")))
  assert.match(clause, /status='linked' AND unlinked_at IS NULL/, clause);
 assert.match(body, /OR \(EXISTS\(SELECT 1 FROM public\.line_account_links WHERE org_id=c\.org_id AND contact_id=c\.id AND login_identity_id=i\.id\)\n   AND \(a\.user_id IS NULL OR a\.user_id IS DISTINCT FROM i\.user_id\)\)/);
 assert.doesNotMatch(body, /line_account_links[^;]*?status<>'linked'/);
});
test("round-2 finding 1: no first-sign-in gate; only 'confirm' links jobs and 'skip' closes a zero-candidate review without job writes", () => {
 assert.doesNotMatch(migration, /first_sign_in|firstSignIn|confirmed_at/);
 assert.doesNotMatch(plpgsql("b101_match"), /FROM app\.b101_vendor_confirmations/);
 const body = plpgsql("b101_review");
 assert.match(body, /OR \(p_action='skip' AND \(p_job IS NOT NULL OR cardinality\(r\.candidate_ids\)<>0\)\)/);
 const skip = /\n IF p_action='skip' THEN\n([\s\S]*?)\n END IF;/.exec(body)![1];
 assert.equal(skip, "  UPDATE app.b101_vendor_confirmations SET closed_at=clock_timestamp() WHERE flow_id=f.id;\n  RETURN jsonb_build_object('jobs','[]'::jsonb,'userId',r.user_id,'identityId',r.identity_id,'orgId',r.org_id);");
 assert.ok(body.indexOf("IF p_action='skip' THEN") < body.indexOf("INSERT INTO"), "skip returns before any insert");
 assert.equal(body.match(/'line_confirmed'/g)!.length, 1); assert.match(body, /ELSIF p_action='confirm' THEN\n   INSERT INTO app\.b026_vendor_job_accounts/);
});
test("review r1 finding 2: remove/confirm must present this flow's frozen-snapshot digest before any write; list/remove return it", () => {
 const body = plpgsql("b101_review");
 const digestOf = (list: string) => `pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(f.id::text||':'||array_to_string(${list},','),'UTF8')),'hex')`;
 const check = ` IF p_action IN ('remove','confirm') AND (r.candidate_ids IS NULL OR p_snapshot IS NULL OR p_snapshot IS DISTINCT FROM\n  ${digestOf("r.candidate_ids")})\n THEN RAISE EXCEPTION 'not_found' USING ERRCODE='P0033'; END IF;`;
 assert.equal(body.split(check).length, 2);
 assert.ok(body.indexOf(check) < body.indexOf("INSERT INTO") && body.indexOf(check) < body.indexOf("IF p_action='skip' THEN"), "checked before any job write");
 assert.ok(body.indexOf(check) > body.indexOf("r.closed_at IS NOT NULL THEN RAISE EXCEPTION 'already_consumed'"), "a closed review stays 409");
 assert.ok(body.includes(`'orgId',r.org_id,\n  'snapshot',${digestOf("visible")});\nEND $$;`));
 assert.match(migration, /GRANT EXECUTE ON FUNCTION [^;]*app\.b101_review\(uuid,boolean,text,uuid,text\) TO service_role;/);
 assert.doesNotMatch(migration, /b101_review\(uuid,boolean,text,uuid\)/);
});
test("finding 3: the legacy-login block applies only while B-101 is enabled for the account's org", () => {
 assert.match(fn("b101_identity_managed"), /WHERE line_identity_id=p_identity\n  AND app\.b101_enabled\(org_id,p_env_v2\) IS TRUE\)/);
 assert.match(migration, /GRANT EXECUTE ON FUNCTION app\.b101_identity_managed\(uuid,boolean\) TO service_role;/);
 assert.doesNotMatch(migration, /b101_identity_managed\(uuid\)/);
});

// sessionFromFlowOn with a scripted client: no PostgreSQL. Unknown statements fail the test.
function scripted(opts: { jobs?: number; managed?: boolean }) {
 const calls: { sql: string; params?: unknown[] }[] = [];
 const client = { query: async (sql: string, params?: unknown[]) => {
  calls.push({ sql, params });
  if (sql.includes("app.b101_match")) return { rows: [{ result: { userId: "user-a", identityId: "identity-a" } }] };
  if (sql.includes("app.b101_review")) return { rows: [{ result: { jobs: params![2] === "list" ? Array.from({ length: opts.jobs ?? 0 }, (_, n) => ({ id: `job-${n}`, description: "d" })) : [],
   userId: "user-a", identityId: "identity-a", orgId: "org-a" } }] };
  if (sql.includes("FROM app.b035_vendor_flows")) return { rows: [] };
  if (sql.includes("SELECT * FROM app.b033_line_identities")) return { rows: [{ id: "identity-a", user_id: "user-a", status: "linked", unlinked_at: null }] };
  if (sql.includes("FROM line_account_links l")) return { rows: [{ id: "link-a" }] };
  if (sql.includes("app.b101_identity_managed")) return { rows: [{ managed: opts.managed }] };
  if (sql.includes("FROM auth.users WHERE id=$1 FOR UPDATE")) return { rows: [{ id: "user-a", email: "line-vendor-a@line.invalid", email_confirmed_at: new Date(), has_password: false, matches: false }] };
  if (sql.includes("auth_login_attempts") || sql.includes("FROM user_mfa") || sql.includes("public.consents")) return { rows: [] };
  if (sql.includes("FROM org_members")) return { rows: [{ yes: false }] };
  if (/INSERT INTO (?:auth_sessions|app\.b033_line_sessions|audit_log)|UPDATE app\.b033_line_flows SET consumed_at/.test(sql)) return { rows: [] };
  throw new Error(`Unexpected query: ${sql}`);
 } } as unknown as Client;
 return { client, calls };
}
const flowRow = (return_path: string) => ({ id: "flow-a", return_path, org_id: "org-a", persona: "vendor", kind: "login", line_channel_id: "channel", verified_hash: "h" }) as LineFlow;
const metaRow = { ua: "unit", ip: null };
const issued = (calls: { sql: string }[]) => calls.filter(c => c.sql.includes("INSERT INTO auth_sessions")).length;
for (const jobs of [1, 2]) test(`round-2 finding 1: any sign-in with ${jobs} open job(s) shows V-LINK; the callback never confirms or issues a session`, async () => {
 const { client, calls } = scripted({ jobs });
 assert.deepEqual(await sessionFromFlowOn(client, flowRow("/v/link"), metaRow, {}), { next: "/v/link" });
 assert.equal(issued(calls), 0);
 assert.deepEqual(calls.filter(c => c.sql.includes("app.b101_review")).map(c => c.params![2]), ["list"]);
});
test("round-2 finding 1: zero candidates skip V-LINK; the session is issued after 'skip', never 'confirm'", async () => {
 const { client, calls } = scripted({ jobs: 0 });
 const result = await sessionFromFlowOn(client, flowRow("/v/link"), metaRow, {}) as { next: string; token: string; orgId: string; persona: string };
 assert.equal(result.next, "/consent?next=%2Fvendor-account"); assert.ok(result.token); assert.equal(result.orgId, "org-a"); assert.equal(result.persona, "vendor");
 const reviews = calls.filter(c => c.sql.includes("app.b101_review")).map(c => c.params![2]);
 assert.deepEqual(reviews, ["list", "skip"]); assert.equal(issued(calls), 1);
 assert.ok(calls.findIndex(c => c.params?.[2] === "skip") < calls.findIndex(c => c.sql.includes("INSERT INTO auth_sessions")));
});
for (const managed of [true, false]) test(`finding 3: legacy B033 vendor sign-in with B-101 ${managed ? "enabled is blocked" : "disabled issues an ordinary session"}`, async () => {
 const previous = process.env.BRAND_V2; process.env.BRAND_V2 = "true";
 try {
  const { client, calls } = scripted({ managed });
  const run = sessionFromFlowOn(client, flowRow("/vendor-account"), metaRow, {});
  if (managed) await assert.rejects(run, (e: unknown) => (e as { status: number }).status === 404);
  else assert.equal((await run as { next: string }).next, "/consent?next=%2Fvendor-account");
  assert.deepEqual(calls.find(c => c.sql.includes("app.b101_identity_managed"))!.params, ["identity-a", true]);
  assert.equal(issued(calls), managed ? 0 : 1);
 } finally { if (previous === undefined) delete process.env.BRAND_V2; else process.env.BRAND_V2 = previous; }
});

// Finding 2: every TS entry asks app.b101_enabled (which now requires vendor_line_match). Mocked modules, no network.
const requireHere = createRequire(import.meta.url);
function load(file: string, mocks: Record<string, unknown>) {
 const code = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
 const exports: Record<string, unknown> = {};
 new Function("require", "exports", code)((name: string) => { assert.ok(name in mocks, name); return mocks[name]; }, exports);
 return exports;
}
const orgId = "22222222-2222-4222-8222-222222222222";
function gateClient(enabled: boolean, extra: (sql: string) => unknown = () => undefined) {
 const asked: unknown[][] = [];
 return { asked, client: { query: async (sql: string, params: unknown[]) => {
  if (sql.includes("app.b101_enabled")) { asked.push(params); return { rows: [{ enabled }] }; }
  const rows = extra(sql); if (rows) return rows; throw new Error(`Unexpected query: ${sql}`);
 } } };
}
const lineMocks = () => ({
 "next/server": requireHere("next/server"), "../brand-v2": { brandV2Enabled: () => false },
 "./config": { readLineConfig: () => ({ platformEnabled: true }) }, "./login-token": requireHere("./line/login-token"),
 "./login-routes": requireHere("./line/login-routes"),
});
for (const enabled of [false, true]) test(`finding 2: vendor_line_match ${enabled ? "ON enables" : "OFF keeps legacy"} /v/liff?org= and the token-page entry`, async () => {
 const boot = gateClient(enabled);
 const { createLiffBootstrap } = load("src/server/line/bootstrap.ts", { ...lineMocks(), "../auth": { SESSION_COOKIE: "condola_session" },
  "./portal": { linePortalChoices: async () => [] }, "@/i18n": { makeT: () => (key: string) => key }, "@/i18n/line-tenant": { lineTenantCopy: () => ({}) },
  "./login-link": { lineTransaction: async (fn: (c: unknown) => unknown) => fn(boot.client), channelOn: async () => ({ liff_id: "liff-vendor" }),
   flowOn: async () => { throw new Error("no flow"); }, randomProof: () => "p".repeat(43), sessionOn: async () => null } }) as { createLiffBootstrap: (p: string) => (r: Request) => Promise<Response> };
 const html = await (await createLiffBootstrap("vendor")(new Request(`https://app.test/v/liff?org=${orgId}`))).text();
 const config = JSON.parse(/id="line-bootstrap">([^<]+)</.exec(html)![1]);
 assert.equal("vendorMatch" in config, enabled, "OFF: the legacy LIFF ID-token config is unchanged");
 assert.deepEqual(boot.asked, [[orgId, false]]);

 const entry = gateClient(enabled, sql => sql.includes("FROM repair_vendor_jobs") ? { rows: [{ org_id: orgId }] } : undefined);
 const { vendorLineEntryEnabled } = load("src/server/line/vendor-entry.ts", { ...lineMocks(), "../vendor-repair-rules": requireHere("./vendor-repair-rules"),
  "./login-link": { lineTransaction: async (fn: (c: unknown) => unknown) => fn(entry.client), channelOn: async () => ({}), randomProof: () => "p".repeat(43) },
  "./vendor-scope": { vendorScopeOn: async () => ({ job_id: "job" }) } }) as { vendorLineEntryEnabled: (t: string, m?: boolean) => Promise<boolean> };
 const token = randomBytes(32).toString("base64url");
 assert.equal(await vendorLineEntryEnabled(token), true, "legacy B-035 entry does not depend on B-101");
 assert.deepEqual(entry.asked, []);
 assert.equal(await vendorLineEntryEnabled(token, true), enabled, "「登入後看全部未結案件」 only with vendor_line_match ON");
 assert.deepEqual(entry.asked, [[orgId, false]]);
});

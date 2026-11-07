import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import { resetAndSeed } from "./seed";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { DEMO_PASSWORD } from "./demo-password";
import { createSession } from "./auth";
import { totpCode } from "./totp";
import { lineHash, type LinePersona } from "./line/login-token";
import { createLineHandlers, LINE_BROWSER_COOKIE, LINE_CSRF_COOKIE, LINE_FLOW_COOKIE, LINE_PKCE_COOKIE } from "./line/login-routes";
import { randomProof } from "./line/login-link";
import { dispatchLinePush, type LinePush } from "./line/quota";
import { createCapturedLineTransport } from "./line/transport";
import { GET as vendorAccount } from "../app/api/vendor-account/route";
import { POST as vendorAccountMutation } from "../app/api/vendor-account/route";
import { POST as reauth } from "../app/api/line/reauth/route";
import { POST as flows } from "../app/api/line/flows/route";
import { POST as session } from "../app/api/line/session/route";
import { POST as accept } from "../app/api/line/invites/accept/route";
import { POST as bind } from "../app/api/line/bind/route";
import { GET as start } from "../app/api/line/login/start/route";
import { GET as callback } from "../app/api/line/login/callback/route";
import { GET as links } from "../app/api/line/links/route";
import { DELETE as unlink } from "../app/api/line/links/[id]/route";
import { DELETE as revoke } from "../app/api/line/identity/route";
import { GET as tenantEntry } from "../app/(line)/t/liff/route";
import { GET as ownerEntry } from "../app/(line)/o/liff/route";
import { GET as vendorEntry } from "../app/(line)/v/liff/route";

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
const origin = "https://app.condola.app", secret = "local-login-secret", pepper = "local-identity-pepper";
const sub = `U${"a".repeat(32)}`, meta = { ua: "local-test", ip: null };
let db: Client, clone: Awaited<ReturnType<typeof cloneTestDatabase>>, channel: string, contact: string, lease: string;
let browser: string, csrf: string;
const previousEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const entries = { tenant: tenantEntry, owner: ownerEntry, vendor: vendorEntry };
function jwt(patch: Record<string, unknown> = {}, key = secret) {
 const now = Math.floor(Date.now() / 1000);
 const raw = [ { alg: "HS256", typ: "JWT" }, { iss: "https://access.line.me", aud: "local-login", sub, iat: now - 1, exp: now + 300, ...patch } ]
  .map(v => Buffer.from(JSON.stringify(v)).toString("base64url")).join(".");
 return `${raw}.${createHmac("sha256", key).update(raw).digest("base64url")}`;
}
function req(path: string, body?: Record<string, unknown>, options: { method?: string; session?: string; cookies?: string; origin?: string; csrf?: string } = {}) {
 return new Request(`${origin}${path}`, { method: options.method ?? (body ? "POST" : "GET"),
  headers: { "Content-Type": "application/json", Origin: options.origin ?? origin,
   Cookie: `${LINE_BROWSER_COOKIE}=${browser}; ${LINE_CSRF_COOKIE}=${csrf}${options.session ? `; condola_session=${options.session}` : ""}${options.cookies ? `; ${options.cookies}` : ""}` },
  ...(body ? { body: JSON.stringify({ csrf: options.csrf ?? csrf, ...body }) } : {}) });
}
async function parsed(res: Response, status = 200) {
 assert.equal(res.status, status, await res.clone().text());
 assert.equal(res.headers.get("Cache-Control"), "no-store"); assert.equal(res.headers.get("Referrer-Policy"), "no-referrer");
 return res.json();
}
async function enabled(persona: LinePersona, on = true) {
 const key = `line_${persona}_portal`;
 await db.query("UPDATE platform_settings SET value=$2 WHERE key=$1", [key, JSON.stringify({ enabled: on, allowed_org_ids: [ORG_ID] })]);
 await db.query("UPDATE organizations SET feature_flags=feature_flags || jsonb_build_object($2::text,$3::boolean) WHERE id=$1", [ORG_ID, key, on]);
}
async function invite(options: { expired?: boolean; user?: boolean; persona?: "tenant" | "owner" } = {}) {
 const token = randomProof(), id = randomUUID(), persona = options.persona ?? "tenant";
 let cid = contact, lid: string | null = lease;
 if (persona === "owner") { cid = (await db.query("SELECT id FROM contacts WHERE org_id=$1 AND user_id=$2", [ORG_ID, USERS.owner])).rows[0].id; lid = null; }
 if (options.user === false) {
  await db.query("UPDATE contacts SET user_id=NULL,email='new-invite@local.test' WHERE id=$1", [cid]);
 }
 const email = (await db.query("SELECT email FROM contacts WHERE id=$1", [cid])).rows[0].email;
 await db.query("UPDATE invitations SET status='revoked' WHERE contact_id=$1 AND status='pending'", [cid]);
 await db.query(`INSERT INTO invitations(id,org_id,kind,contact_id,lease_id,email,code_hash,status,expires_at,invited_by)
  VALUES($1,$2,$3,$4,$5,$6,$7,'pending',now()+$8::interval,$9)`, [id, ORG_ID, persona, cid, lid, email, lineHash(token), options.expired ? "-1 minute" : "1 day", USERS.admin]);
 return { id, token, contact: cid };
}
async function flow(input: Record<string, string> = {}, token?: string) {
 return parsed(await flows(req("/api/line/flows", { purpose: "login", orgId: ORG_ID, persona: "tenant", ...input }, { session: token })), 201);
}
async function inviteFlow(options: Parameters<typeof invite>[0] = {}) {
 const i = await invite(options); const f = await flow({ purpose: "invite", inviteToken: i.token }); return { ...i, flow: f.flow as string };
}
async function acceptFlow(handle: string, fields: Record<string, unknown> = {}, token?: string) {
 return accept(req("/api/line/invites/accept", { flow: handle, idToken: jwt(), password: DEMO_PASSWORD, consentTextKey: "line.binding.v1", ...fields }, { session: token }));
}
function sessionCookie(res: Response) { return /condola_session=([^;,]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1]; }
async function steppedSession(user: string, remember: boolean, requestMeta: typeof meta) {
 const token = await createSession(user, remember, requestMeta);
 await parsed(await reauth(req("/api/line/reauth", { orgId: ORG_ID, persona: "tenant", password: DEMO_PASSWORD }, { session: token })));
 return token;
}
async function snapshot() {
 const names = ["auth.users", "contacts", "invitations", "app.b033_line_identities", "auth_sessions", "line_account_links", "consents", "audit_log", "app.b033_line_flows", "app.b033_line_sessions", "app.b033_line_limits", "app.b033_line_stepups"];
 const result: Record<string, unknown> = {};
 for (const name of names) result[name] = (await db.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS data FROM ${name} t`)).rows[0].data;
 return result;
}
async function identityCounts() { return (await db.query(`SELECT (SELECT count(*)::int FROM app.b033_line_identities) identities,
 (SELECT count(*)::int FROM auth_sessions) sessions,(SELECT count(*)::int FROM line_account_links WHERE login_identity_id IS NOT NULL) links`)).rows[0]; }
async function unconsumed(id: string) { assert.equal((await db.query("SELECT status FROM invitations WHERE id=$1", [id])).rows[0].status, "pending"); }

test.before(async () => {
 clone = await cloneTestDatabase(); db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
 globalThis.fetch = async () => { throw new Error("External HTTP forbidden in B-033 tests"); };
});
test.beforeEach(async () => {
 process.env.DEMO_MODE = "true"; process.env.ID_DOC_ENCRYPTION_KEY = randomBytes(32).toString("hex");
 await resetAndSeed(); process.env.DEMO_MODE = "false";
 process.env.LINE_PLATFORM_ENABLED = "true";
 browser = randomProof(); csrf = randomProof();
 await db.query("UPDATE platform_settings SET value=$1 WHERE key='line_platform'", [JSON.stringify({ enabled: true, allowed_org_ids: [ORG_ID] })]);
 await db.query("UPDATE organizations SET feature_flags=feature_flags || '{\"line_platform\":true}'::jsonb WHERE id=$1", [ORG_ID]);
 for (const p of ["tenant", "owner", "vendor"] as const) await enabled(p);
 channel = (await db.query("SELECT id FROM line_channels WHERE mode='platform_default' AND is_active")).rows[0].id;
 await db.query("SELECT app.b033_liff_configure($1,'local-tenant','local-vendor','local-owner')", [channel]);
 await db.query("UPDATE line_channels SET login_channel_id='local-login',login_channel_secret_ref='local-ref' WHERE id=$1", [channel]);
 await db.query("SELECT app.b033_channel_verify($1)", [channel]);
 process.env.LINE_CHANNEL_SECRETS = JSON.stringify({ "local-ref": { secret, identityPepper: pepper, destination: "local-bot" } });
 contact = (await db.query("SELECT id FROM contacts WHERE org_id=$1 AND user_id=$2", [ORG_ID, USERS.tenant])).rows[0].id;
 lease = (await db.query("SELECT lease_id FROM lease_parties WHERE org_id=$1 AND contact_id=$2 AND role='primary'", [ORG_ID, contact])).rows[0].lease_id;
 await db.query("DELETE FROM line_account_links WHERE contact_id=$1", [contact]);
});
test.after(async () => { globalThis.fetch = originalFetch; await db?.end(); await clone?.cleanup();
 for (const key of ["DEMO_MODE", "ID_DOC_ENCRYPTION_KEY", "LINE_PLATFORM_ENABLED", "LINE_CHANNEL_SECRETS"]) {
  if (previousEnv[key] === undefined) delete process.env[key]; else process.env[key] = previousEnv[key];
 }
});

for (const [name, patch, key] of [
 ["audience", { aud: "wrong" }, secret], ["issuer", { iss: "https://evil.test" }, secret], ["expiry", { exp: 1 }, secret],
 ["future iat", { iat: 9999999999 }, secret], ["signature", {}, "wrong"], ["subject", { sub: "not-a-subject" }, secret],
] as const) test(`invalid ${name} creates no identity/session/link and leaves invite pending`, async () => {
 const f = await inviteFlow(), before = await identityCounts();
 await parsed(await acceptFlow(f.flow, { idToken: jwt(patch, key) }), 401);
 assert.deepEqual(await identityCounts(), before); await unconsumed(f.id);
});
test("invalid/missing flow or browser proof creates nothing", async () => {
 const f = await inviteFlow(), before = await identityCounts();
 await parsed(await acceptFlow("missing"), 404);
 browser = randomProof(); await parsed(await acceptFlow(f.flow), 404);
 assert.deepEqual(await identityCounts(), before); await unconsumed(f.id);
});
test("invite acceptance atomically links, consumes, preserves consent and creates existing cookie session", async () => {
 const f = await inviteFlow(); const res = await acceptFlow(f.flow); const value = await parsed(res);
 assert.ok(value.linkId); assert.ok(sessionCookie(res)); assert.equal(value.next, "/t");
 assert.deepEqual(await identityCounts(), { identities: 1, sessions: 1, links: 1 });
 const link = (await db.query("SELECT * FROM line_account_links WHERE id=$1", [value.linkId])).rows[0];
 assert.equal(link.line_user_id, null); assert.equal(link.notification_opt_in, true);
 assert.equal((await db.query("SELECT status FROM invitations WHERE id=$1", [f.id])).rows[0].status, "accepted");
 assert.ok((await db.query("SELECT consumed_at FROM app.b033_line_flows WHERE flow_hash=$1", [lineHash(f.flow)])).rows[0].consumed_at);
 const audit = JSON.stringify((await db.query("SELECT old_row,new_row FROM audit_log WHERE table_name IN ('b033_line_events','line_account_links')")).rows);
 assert.ok(!audit.includes(sub)); assert.ok(!audit.includes(secret)); assert.ok(!audit.includes(jwt()));
 await parsed(await acceptFlow(f.flow), 409);
});
test("new invited account reuses portal provisioning within the transaction", async () => {
 const f = await inviteFlow({ user: false }); await parsed(await acceptFlow(f.flow, { password: "ValidLocalPass903" }));
 assert.equal((await db.query("SELECT count(*)::int n FROM auth.users WHERE email='new-invite@local.test'")).rows[0].n, 1);
});
test("existing account always requires its password and never adopts LINE email/name", async () => {
 const f = await inviteFlow(), before = await identityCounts();
 await parsed(await acceptFlow(f.flow, { password: "WrongPass903", idToken: jwt({ email: "yawen.zhang@tenant.demo", name: "untrusted" }) }), 401);
 await parsed(await acceptFlow(f.flow, { password: "" }), 401);
 assert.deepEqual(await identityCounts(), before); await unconsumed(f.id);
});
test("existing-account 2FA is mandatory including when the password is correct", async () => {
 const factor = "JBSWY3DPEHPK3PXP";
 await db.query("INSERT INTO user_mfa(user_id,enabled,totp_secret) VALUES($1,true,$2) ON CONFLICT(user_id) DO UPDATE SET enabled=true,totp_secret=$2", [USERS.tenant, factor]);
 const f = await inviteFlow(); await parsed(await acceptFlow(f.flow), 401); await unconsumed(f.id);
 await parsed(await acceptFlow(f.flow, { secondFactor: totpCode(factor) }));
});
test("organization-required MFA with no enrollment refuses login", async () => {
 await db.query("UPDATE organizations SET settings=settings || '{\"require_2fa\":true}' WHERE id=$1", [ORG_ID]);
 await db.query("INSERT INTO org_members(org_id,user_id,role,status) VALUES($1,$2,'maintenance','active')", [ORG_ID, USERS.tenant]);
 const f = await inviteFlow(); await parsed(await acceptFlow(f.flow), 401); await unconsumed(f.id);
});
for (const mode of ["expired invite", "consumed flow", "expired flow", "conflict"] as const) test(`${mode} aborts invite and all identity/session/link effects`, async () => {
 const f = await inviteFlow();
 if (mode === "expired invite") await db.query("UPDATE invitations SET expires_at=now()-interval '1 minute' WHERE id=$1", [f.id]);
 if (mode === "consumed flow") await db.query("UPDATE app.b033_line_flows SET consumed_at=now() WHERE flow_hash=$1", [lineHash(f.flow)]);
 if (mode === "expired flow") await db.query("UPDATE app.b033_line_flows SET expires_at=now()-interval '1 minute' WHERE flow_hash=$1", [lineHash(f.flow)]);
 if (mode === "conflict") await db.query(`INSERT INTO line_account_links(org_id,contact_id,line_channel_id,status) VALUES($1,$2,$3,'pending')`, [ORG_ID, contact, channel]);
 const before = await identityCounts(); await parsed(await acceptFlow(f.flow), mode.startsWith("expired") ? 410 : 409);
 assert.deepEqual(await identityCounts(), before); await unconsumed(f.id);
});
test("late session failure rolls back invite, new provisioning, consent, identity and link", async () => {
 const f = await inviteFlow({ user: false }), before = await identityCounts();
 await db.query(`CREATE FUNCTION public.b033_test_fail_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced'; END $$;
 CREATE TRIGGER b033_test_fail_session BEFORE INSERT ON auth_sessions FOR EACH ROW EXECUTE FUNCTION public.b033_test_fail_session()`);
 try { await parsed(await acceptFlow(f.flow, { password: "ValidLocalPass903" }), 503); }
 finally { await db.query("DROP TRIGGER b033_test_fail_session ON auth_sessions; DROP FUNCTION public.b033_test_fail_session()"); }
 assert.deepEqual(await identityCounts(), before); await unconsumed(f.id);
 assert.equal((await db.query("SELECT count(*)::int n FROM auth.users WHERE email='new-invite@local.test'")).rows[0].n, 0);
});
test("two separate connections accepting concurrently produce one identity, one session and one link", async () => {
 const f = await inviteFlow();
 const results = await Promise.all([acceptFlow(f.flow), acceptFlow(f.flow)]);
 assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
 assert.deepEqual(await identityCounts(), { identities: 1, sessions: 1, links: 1 });
});
test("LIFF entry and invite/QR reserve share identity and reuse the same browser Condola session", async () => {
 const f = await inviteFlow(), accepted = await acceptFlow(f.flow); await parsed(accepted); const token = sessionCookie(accepted)!;
 const next = await flow();
 const res = await session(req("/api/line/session", { flow: next.flow, idToken: jwt() }, { session: token }));
 await parsed(res); assert.equal(sessionCookie(res), token);
 assert.deepEqual(await identityCounts(), { identities: 1, sessions: 1, links: 1 });
});
test("LINE-first unknown identity cannot establish a session; login flow is consumed", async () => {
 const f = await flow(); assert.deepEqual(await parsed(await session(req("/api/line/session", { flow: f.flow, idToken: jwt() }))), { action: "account_required" });
 assert.deepEqual(await identityCounts(), { identities: 0, sessions: 0, links: 0 });
 await parsed(await session(req("/api/line/session", { flow: f.flow, idToken: jwt() })), 409);
});
test("bind, self-list, unlink and global revoke preserve Condola password sessions", async () => {
 const token = await steppedSession(USERS.tenant, false, meta);
 const f = await flow({ purpose: "bind", contactId: contact }, token);
 const result = await parsed(await bind(req("/api/line/bind", { flow: f.flow, idToken: jwt(), orgId: ORG_ID, contactId: contact, consentTextKey: "line.binding.v1" }, { session: token })));
 const listed = await parsed(await links(req("/api/line/links", undefined, { session: token })));
 assert.equal(listed.links[0].id, result.linkId);
 const signin = await flow(); await parsed(await session(req("/api/line/session", { flow: signin.flow, idToken: jwt() })));
 await parsed(await unlink(req(`/api/line/links/${result.linkId}`, { reason: "user_request" }, { method: "DELETE", session: token }), { params: Promise.resolve({ id: result.linkId }) }));
 await parsed(await revoke(req("/api/line/identity", {}, { method: "DELETE", session: token })));
 assert.equal((await db.query("SELECT status FROM app.b033_line_identities")).rows[0].status, "revoked");
 assert.equal((await db.query("SELECT count(*)::int n FROM auth_sessions WHERE revoked_at IS NULL")).rows[0].n, 1);
 assert.equal((await db.query("SELECT revoked_at FROM auth_sessions WHERE token_hash=$1", [lineHash(token)])).rows[0].revoked_at, null);
});
test("foreign contact and cross-org attempts give non-leaking 404", async () => {
 const token = await steppedSession(USERS.tenant2, false, meta);
 await parsed(await flows(req("/api/line/flows", { purpose: "bind", orgId: ORG_ID, contactId: contact, persona: "tenant" }, { session: token })), 404);
 await parsed(await flows(req("/api/line/flows", { purpose: "bind", orgId: ORG2_ID, contactId: contact, persona: "tenant" }, { session: token })), 404);
});
test("bind requires recent Condola credentials and rejects a LINE-issued session as reauthentication", async () => {
 const f = await inviteFlow(), res = await acceptFlow(f.flow); await parsed(res);
 await parsed(await flows(req("/api/line/flows", { purpose: "bind", orgId: ORG_ID, contactId: contact, persona: "tenant" }, { session: sessionCookie(res) })), 401);
});
for (const persona of ["tenant", "owner", "vendor"] as const) {
 test(`${persona} public bootstrap is outside protected layouts, OFF has Email fallback and no writes/cookies`, async () => {
  await enabled(persona, false); const before = await snapshot();
  const result = await entries[persona](req(`/${persona[0]}/liff?org=${ORG_ID}`));
  assert.equal(result.status, 200); assert.match(await result.text(), /href="\/login"/); assert.equal(result.headers.get("set-cookie"), null);
  assert.deepEqual(await snapshot(), before);
 });
 test(`${persona} portal OFF flow/session/start/callback/bind/accept routes write zero rows`, async () => {
  const f = await flow({ persona }); await enabled(persona, false); const before = await snapshot();
  await parsed(await flows(req("/api/line/flows", { purpose: "login", orgId: ORG_ID, persona })), 404);
  for (const handler of [session, bind, accept]) await parsed(await handler(req("/api/line/session", { flow: f.flow, idToken: jwt() })), 404);
  await parsed(await start(req(`/api/line/login/start?flow=${f.flow}`)), 404);
  await parsed(await callback(req("/api/line/login/callback?state=invalid&code=local", undefined, { cookies: `${LINE_FLOW_COOKIE}=${f.flow}` })), 404);
  assert.deepEqual(await snapshot(), before);
 });
 test(`${persona} bootstrap ON sets secure browser proof without authentication writes`, async () => {
  const before = await snapshot(); const res = await entries[persona](req(`/${persona[0]}/liff?org=${ORG_ID}`));
  assert.equal(res.status, 200); assert.match(res.headers.get("set-cookie") ?? "", /Secure/);
  assert.match(await res.text(), new RegExp(`local-${persona}`)); assert.deepEqual(await snapshot(), before);
 });
}
test("global OFF matrix rejects all API handlers before body/auth reads with zero rows", async () => {
 process.env.LINE_PLATFORM_ENABLED = "false"; const before = await snapshot();
 for (const handler of [flows, session, bind, accept, start, callback, links, revoke, reauth]) await parsed(await handler(req("/api/line/test", {})), 404);
 await parsed(await unlink(req("/api/line/links/bad", {}), { params: Promise.resolve({ id: "bad" }) }), 404);
 assert.deepEqual(await snapshot(), before);
});
test("Origin and CSRF rejection is enforced by exported handlers with private headers", async () => {
 const f = await inviteFlow(), before = await snapshot();
 for (const opts of [{ origin: "https://evil.test" }, { csrf: "wrong" }]) {
  await parsed(await accept(req("/api/line/invites/accept", { flow: f.flow, idToken: jwt() }, opts)), 403);
 }
 assert.deepEqual(await snapshot(), before); await unconsumed(f.id);
});
test("OAuth start stores hashed state/nonce/PKCE, callback verifies all three locally", async () => {
 const f = await flow(); const res = await start(req(`/api/line/login/start?flow=${f.flow}`)); assert.equal(res.status, 302);
 const url = new URL(res.headers.get("location")!);
 const verifier = new RegExp(`${LINE_PKCE_COOKIE}=([^;,]+)`).exec(res.headers.get("set-cookie")!)![1];
 const state = url.searchParams.get("state")!, nonce = url.searchParams.get("nonce")!;
 const row = (await db.query("SELECT * FROM app.b033_line_flows WHERE flow_hash=$1", [lineHash(f.flow)])).rows[0];
 assert.equal(row.state_hash, lineHash(state)); assert.equal(row.nonce_hash, lineHash(nonce)); assert.equal(row.pkce_hash, lineHash(verifier));
 const cookies = `${LINE_FLOW_COOKIE}=${f.flow}; ${LINE_PKCE_COOKIE}=${verifier}`;
 const handlers = createLineHandlers({ exchangeCode: async input => { assert.equal(input.verifier, verifier); return jwt({ nonce }); } });
 await parsed(await handlers.callback(req("/api/line/login/callback?code=local&state=wrong", undefined, { cookies })), 401);
 const good = await handlers.callback(req(`/api/line/login/callback?code=local&state=${state}`, undefined, { cookies }));
 assert.equal(good.status, 303); assert.equal(good.headers.get("location"), `${origin}/login`);
 assert.deepEqual(await identityCounts(), { identities: 0, sessions: 0, links: 0 });
 await parsed(await handlers.callback(req(`/api/line/login/callback?code=local&state=${state}`, undefined, { cookies })), 409);
});
test("OAuth nonce and PKCE mismatch never create a session and shipped exchange fails closed", async () => {
 const f = await flow(), res = await start(req(`/api/line/login/start?flow=${f.flow}`));
 const url = new URL(res.headers.get("location")!), state = url.searchParams.get("state")!;
 const verifier = new RegExp(`${LINE_PKCE_COOKIE}=([^;,]+)`).exec(res.headers.get("set-cookie")!)![1];
 const cookies = `${LINE_FLOW_COOKIE}=${f.flow}; ${LINE_PKCE_COOKIE}=${verifier}`;
 const handlers = createLineHandlers({ exchangeCode: async () => jwt({ nonce: "wrong" }) });
 await parsed(await handlers.callback(req(`/api/line/login/callback?code=local&state=${state}`, undefined, { cookies })), 401);
 await parsed(await callback(req(`/api/line/login/callback?code=local&state=${state}`, undefined, { cookies })), 503);
 await parsed(await handlers.callback(req(`/api/line/login/callback?code=local&state=${state}`, undefined,
  { cookies: `${LINE_FLOW_COOKIE}=${f.flow}; ${LINE_PKCE_COOKIE}=wrong` })), 401);
 assert.deepEqual(await identityCounts(), { identities: 0, sessions: 0, links: 0 });
});
test("attempts survive failed business transactions and stop credential guessing", async () => {
 const f = await inviteFlow();
 for (let i = 0; i < 5; i++) await parsed(await acceptFlow(f.flow, { password: "WrongPass903" }), 401);
 await parsed(await acceptFlow(f.flow), 429); await unconsumed(f.id);
});
test("return path rejects outside-portal redirects", async () => {
 await parsed(await flows(req("/api/line/flows", { purpose: "login", orgId: ORG_ID, persona: "tenant", returnPath: "//evil.test" })), 400);
});
test("service-only privilege catalog and LIFF verification invalidation", async () => {
 for (const table of ["b033_line_flows", "b033_line_identities", "b033_line_sessions", "b033_line_limits", "b033_line_stepups"]) {
  for (const role of ["anon", "authenticated"]) {
   const row = (await db.query("SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE') AS allowed", [role, `app.${table}`])).rows[0];
   assert.equal(row.allowed, false);
  }
  assert.equal((await db.query("SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass", [`app.${table}`])).rows[0].relrowsecurity, true);
 }
 for (const fn of ["app.b033_liff_configure(uuid,text,text,text)", "app.b033_link(uuid,text,uuid,text)"]) {
  for (const role of ["anon", "authenticated", "service_role"]) assert.equal((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') ok", [role, fn])).rows[0].ok, role === "service_role");
 }
 await db.query("SELECT app.b033_channel_verify($1)", [channel]);
 await db.query("SELECT app.b033_liff_configure($1,'changed-tenant','local-vendor','local-owner')", [channel]);
 assert.equal((await db.query("SELECT tenant_config_verified_at FROM line_channels WHERE id=$1", [channel])).rows[0].tenant_config_verified_at, null);
 await db.query("BEGIN; SET LOCAL ROLE service_role");
 try { await assert.rejects(db.query("UPDATE line_channels SET liff_id_tenant='forged' WHERE id=$1", [channel]), /gateway/); }
 finally { await db.query("ROLLBACK"); }
});

test("owner invite derives persona on the server despite tenant/client scope hints", async () => {
 const i = await invite({ persona: "owner" });
 await db.query("DELETE FROM line_account_links WHERE contact_id=$1", [i.contact]);
 const f = await flow({ purpose: "invite", inviteToken: i.token, persona: "tenant", orgId: ORG2_ID, contactId: contact });
 assert.match(f.liffUrl, /^\/o\/liff/);
 const res = await acceptFlow(f.flow); const result = await parsed(res);
 assert.equal(result.next, "/o/statements");
 assert.equal((await db.query("SELECT persona FROM line_account_links WHERE id=$1", [result.linkId])).rows[0].persona, "owner");
});
async function bindPersona(persona: LinePersona) {
 let cid = contact, user = USERS.tenant as string;
 if (persona === "owner") {
  user = USERS.owner; cid = (await db.query("SELECT id FROM contacts WHERE org_id=$1 AND user_id=$2", [ORG_ID, user])).rows[0].id;
 }
 if (persona === "vendor") {
  cid = (await db.query("SELECT id FROM contacts WHERE org_id=$1 AND is_vendor LIMIT 1", [ORG_ID])).rows[0].id;
  for (const key of ["vendor_account", "vendor_dispatch"]) {
   await db.query("UPDATE platform_settings SET value=$2 WHERE key=$1", [key, JSON.stringify({ enabled: true, allowed_org_ids: [ORG_ID] })]);
   await db.query("UPDATE organizations SET feature_flags=feature_flags || jsonb_build_object($2::text,true) WHERE id=$1", [ORG_ID, key]);
  }
  const inviteId = randomUUID();
  await db.query(`INSERT INTO app.b026_vendor_account_invites(id,org_id,contact_id,user_id,token_hash,created_by,expires_at,claimed_at)
   VALUES($1,$2,$3,$4,$5,$6,now()+interval '1 day',now())`, [inviteId, ORG_ID, cid, user, lineHash(randomProof()), USERS.admin]);
  await db.query("INSERT INTO app.b026_vendor_accounts(org_id,contact_id,user_id,invite_id) VALUES($1,$2,$3,$4)", [ORG_ID, cid, user, inviteId]);
 }
 await db.query("DELETE FROM line_account_links WHERE contact_id=$1", [cid]);
 const token = await steppedSession(user, false, meta);
 const f = await flow({ purpose: "bind", persona, contactId: cid }, token);
 const result = await parsed(await bind(req("/api/line/bind", { flow: f.flow, idToken: jwt(), consentTextKey: "line.binding.v1" }, { session: token })));
 return { token, linkId: result.linkId, cid, user };
}
for (const persona of ["tenant", "owner", "vendor"] as const) test(`${persona} management OFF matrix and existing scope-only link`, async () => {
 const beforeJobs = (await db.query("SELECT count(*)::int n FROM app.b026_vendor_job_accounts")).rows[0].n;
 const bound = await bindPersona(persona);
 assert.equal((await db.query("SELECT count(*)::int n FROM app.b026_vendor_job_accounts")).rows[0].n, beforeJobs);
 await enabled(persona, false); const before = await snapshot();
 await parsed(await links(req("/api/line/links", undefined, { session: bound.token })), 404);
 await parsed(await unlink(req(`/api/line/links/${bound.linkId}`, { reason: "user_request" }, { method: "DELETE", session: bound.token }), { params: Promise.resolve({ id: bound.linkId }) }), 404);
 await parsed(await revoke(req("/api/line/identity", {}, { method: "DELETE", session: bound.token })), 404);
 assert.deepEqual(await snapshot(), before);
});
test("vendor contact without established B-026 account mapping cannot be bound", async () => {
 const cid = (await db.query("SELECT id FROM contacts WHERE org_id=$1 AND is_vendor LIMIT 1", [ORG_ID])).rows[0].id;
 const token = await steppedSession(USERS.tenant, false, meta);
 await parsed(await flows(req("/api/line/flows", { purpose: "bind", orgId: ORG_ID, persona: "vendor", contactId: cid }, { session: token })), 404);
});
test("foreign user cannot list or unlink another identity, manager may unlink only own organization", async () => {
 const bound = await bindPersona("tenant"); const stranger = await steppedSession(USERS.tenant2, false, meta);
 assert.equal((await parsed(await links(req("/api/line/links", undefined, { session: stranger })))).links.length, 0);
 await parsed(await unlink(req(`/api/line/links/${bound.linkId}`, { reason: "user_request" }, { method: "DELETE", session: stranger }), { params: Promise.resolve({ id: bound.linkId }) }), 404);
 const foreignAdmin = await steppedSession(USERS.coastAdmin, false, meta);
 await parsed(await unlink(req(`/api/line/links/${bound.linkId}`, { reason: "staff_request" }, { method: "DELETE", session: foreignAdmin }), { params: Promise.resolve({ id: bound.linkId }) }), 404);
 const manager = await steppedSession(USERS.manager, false, meta);
 await parsed(await unlink(req(`/api/line/links/${bound.linkId}`, { reason: "staff_request" }, { method: "DELETE", session: manager }), { params: Promise.resolve({ id: bound.linkId }) }));
 await parsed(await revoke(req("/api/line/identity", {}, { method: "DELETE", session: manager })), 404);
});
test("unlinked contact cannot authenticate via an otherwise valid identity", async () => {
 const bound = await bindPersona("tenant");
 await parsed(await unlink(req(`/api/line/links/${bound.linkId}`, { reason: "user_request" }, { method: "DELETE", session: bound.token }), { params: Promise.resolve({ id: bound.linkId }) }));
 const f = await flow(); const before = await identityCounts();
 assert.deepEqual(await parsed(await session(req("/api/line/session", { flow: f.flow, idToken: jwt() }))), { action: "account_required" });
 assert.deepEqual(await identityCounts(), before);
});
test("identity revoke refuses an unusable recovery email and preserves all links", async () => {
 const bound = await bindPersona("tenant");
 await db.query("UPDATE auth.users SET encrypted_password='' WHERE id=$1", [USERS.tenant]); const before = await snapshot();
 await parsed(await revoke(req("/api/line/identity", {}, { method: "DELETE", session: bound.token })), 401);
 assert.deepEqual(await snapshot(), before);
});
test("existing signed-in different account aborts the whole invite", async () => {
 const f = await inviteFlow(); const token = await steppedSession(USERS.tenant2, false, meta), before = await identityCounts();
 await parsed(await acceptFlow(f.flow, {}, token), 409); await unconsumed(f.id); assert.deepEqual(await identityCounts(), before);
});
test("missing consent and shared invite attempt lock are enforced", async () => {
 const f = await inviteFlow(); await parsed(await acceptFlow(f.flow, { consentTextKey: "" }), 403);
 await db.query("INSERT INTO portal_invite_attempts(ip,failed_count,locked_until) VALUES($1,5,now()+interval '15 minutes')", [`token:${lineHash(f.token)}`]);
 await parsed(await acceptFlow(f.flow), 429); await unconsumed(f.id);
});
test("new accounts cannot treat an unverified collected email as a recovered identity", async () => {
 const f = await inviteFlow({ user: false });
 await db.query("UPDATE invitations SET email=NULL WHERE id=$1", [f.id]);
 await db.query("UPDATE contacts SET email=NULL WHERE id=$1", [contact]);
 await parsed(await acceptFlow(f.flow, { email: "unverified@local.test", password: "ValidLocalPass903" }), 401); await unconsumed(f.id);
});
test("unverified changed LIFF configuration fails closed before flow writes", async () => {
 await db.query("SELECT app.b033_liff_configure($1,'changed','local-vendor','local-owner')", [channel]);
 const before = await snapshot(); await parsed(await flows(req("/api/line/flows", { purpose: "login", orgId: ORG_ID, persona: "tenant" })), 503);
 assert.deepEqual(await snapshot(), before);
});

test("separate flows racing for the same invitation accept exactly once", async () => {
 const first = await inviteFlow(); const second = await flow({ purpose: "invite", inviteToken: first.token });
 const results = await Promise.all([acceptFlow(first.flow), acceptFlow(second.flow)]);
 assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
 assert.deepEqual(await identityCounts(), { identities: 1, sessions: 1, links: 1 });
 assert.equal((await db.query("SELECT count(*)::int n FROM app.b033_line_flows WHERE consumed_at IS NOT NULL")).rows[0].n, 1);
});
test("provider identity belonging to another account aborts a second invitation", async () => {
 const first = await inviteFlow(); await parsed(await acceptFlow(first.flow));
 const second = await inviteFlow({ persona: "owner" });
 await db.query("DELETE FROM line_account_links WHERE contact_id=$1", [second.contact]);
 const before = await identityCounts();
 const denied = await parsed(await acceptFlow(second.flow), 409);
 assert.equal(denied.error, "identity_conflict");
 await unconsumed(second.id); assert.deepEqual(await identityCounts(), before);
});
test("foreign unlink does not disclose an unhealthy channel", async () => {
 const bound = await bindPersona("tenant"), stranger = await steppedSession(USERS.coastAdmin, false, meta);
 await db.query("SELECT app.b033_liff_configure($1,'unverified','local-vendor','local-owner')", [channel]);
 const before = await snapshot();
 const denied = await parsed(await unlink(req(`/api/line/links/${bound.linkId}`, { reason: "staff_request" }, { method: "DELETE", session: stranger }), { params: Promise.resolve({ id: bound.linkId }) }), 404);
 assert.equal(denied.error, "not_found"); assert.deepEqual(await snapshot(), before);
});
test("authorized OAuth callback issues a Condola session once, using a local exchange", async () => {
 await bindPersona("tenant");
 const f = await flow(), started = await start(req(`/api/line/login/start?flow=${f.flow}`));
 const url = new URL(started.headers.get("location")!);
 const verifier = new RegExp(`${LINE_PKCE_COOKIE}=([^;,]+)`).exec(started.headers.get("set-cookie")!)![1];
 let calls = 0;
 const handlers = createLineHandlers({ resolveSecret: async ref => {
  assert.equal(ref, "local-ref"); return { secret, identityPepper: pepper, destination: "local-bot" };
 }, exchangeCode: async input => {
  calls++; assert.equal(input.code, "local-code"); assert.equal(input.verifier, verifier);
  assert.equal(input.redirectUri, `${origin}/api/line/login/callback`);
  return jwt({ nonce: url.searchParams.get("nonce") });
 } });
 const request = () => req(`/api/line/login/callback?state=${url.searchParams.get("state")}&code=local-code`, undefined,
  { cookies: `${LINE_FLOW_COOKIE}=${f.flow}; ${LINE_PKCE_COOKIE}=${verifier}` });
 const result = await handlers.callback(request());
 assert.equal(result.status, 303); assert.equal(result.headers.get("location"), `${origin}/t`);
 assert.equal(result.headers.get("cache-control"), "no-store"); assert.equal(result.headers.get("referrer-policy"), "no-referrer");
 assert.ok(sessionCookie(result)); assert.equal(calls, 1);
 await parsed(await handlers.callback(request()), 409); assert.equal(calls, 1);
 assert.equal((await db.query("SELECT count(*)::int n FROM app.b033_line_sessions")).rows[0].n, 1);
});

test("every exported mutation rejects foreign Origin and wrong CSRF without business or admission writes", async () => {
 const bound = await bindPersona("tenant"), f = await flow(), before = await snapshot();
 for (const invalid of [{ origin: "https://foreign.test" }, { csrf: "wrong" }]) {
  const request = (method = "POST") => req("/api/line/test", { purpose: "login", orgId: ORG_ID, persona: "tenant", flow: f.flow, idToken: jwt(), reason: "user_request" }, { ...invalid, method, session: bound.token });
  for (const handler of [flows, session, bind, accept]) await parsed(await handler(request()), 403);
  await parsed(await unlink(request("DELETE"), { params: Promise.resolve({ id: bound.linkId }) }), 403);
  await parsed(await revoke(request("DELETE")), 403);
 }
 assert.deepEqual(await snapshot(), before);
});

// QA round 2: recent session creation never proves password/MFA authentication.
test("fresh confirmation/signup sessions cannot bind, self-unlink or globally revoke without explicit step-up", async () => {
 const bound = await bindPersona("tenant");
 const fresh = await createSession(USERS.tenant, false, meta);
 const before = await snapshot();
 await parsed(await flows(req("/api/line/flows", { purpose: "bind", orgId: ORG_ID, persona: "tenant", contactId: contact }, { session: fresh })), 401);
 await parsed(await unlink(req(`/api/line/links/${bound.linkId}`, { reason: "user_request" }, { method: "DELETE", session: fresh }), { params: Promise.resolve({ id: bound.linkId }) }), 401);
 await parsed(await revoke(req("/api/line/identity", {}, { method: "DELETE", session: fresh })), 401);
 assert.deepEqual(await snapshot(), before);
 const factor = "JBSWY3DPEHPK3PXP";
 await db.query("INSERT INTO user_mfa(user_id,enabled,totp_secret) VALUES($1,true,$2) ON CONFLICT(user_id) DO UPDATE SET enabled=true,totp_secret=$2", [USERS.tenant, factor]);
 const step = (fields: Record<string, unknown>) => reauth(req("/api/line/reauth", { orgId: ORG_ID, persona: "tenant", ...fields }, { session: fresh }));
 for (const fields of [{}, { password: "wrong", secondFactor: totpCode(factor) }, { password: DEMO_PASSWORD }, { password: DEMO_PASSWORD, secondFactor: "invalid" }]) await parsed(await step(fields), 401);
 assert.equal((await db.query("SELECT count(*)::int n FROM app.b033_line_stepups r JOIN auth_sessions s ON s.id=r.session_id WHERE s.token_hash=$1", [lineHash(fresh)])).rows[0].n, 0);
 await db.query("UPDATE auth_sessions SET created_at=now()-interval '1 day' WHERE token_hash=$1", [lineHash(fresh)]);
 await parsed(await step({ password: DEMO_PASSWORD, secondFactor: totpCode(factor) }));
 const f = await flow({ purpose: "bind", contactId: contact }, fresh);
 assert.ok(f.flow);
 await parsed(await bind(req("/api/line/bind", { flow: f.flow, idToken: jwt(), consentTextKey: "line.binding.v1" }, { session: fresh })));
 await parsed(await unlink(req(`/api/line/links/${bound.linkId}`, { reason: "user_request" }, { method: "DELETE", session: fresh }), { params: Promise.resolve({ id: bound.linkId }) }));
 await parsed(await revoke(req("/api/line/identity", {}, { method: "DELETE", session: fresh })));
});
for (const invalidation of ["expired", "password changed", "MFA enabled", "organization MFA required"] as const) test(`step-up is rejected after ${invalidation}`, async () => {
 const bound = await bindPersona("tenant");
 const pending = await flow({ purpose: "bind", contactId: contact }, bound.token);
 if (invalidation === "expired") await db.query("UPDATE app.b033_line_stepups SET authenticated_at=now()-interval '11 minutes'");
 if (invalidation === "password changed") await db.query("UPDATE auth.users SET encrypted_password=crypt('ChangedLocalPass903',gen_salt('bf')) WHERE id=$1", [USERS.tenant]);
 if (invalidation === "MFA enabled") await db.query("INSERT INTO user_mfa(user_id,enabled,totp_secret) VALUES($1,true,'JBSWY3DPEHPK3PXP') ON CONFLICT(user_id) DO UPDATE SET enabled=true,totp_secret=excluded.totp_secret", [USERS.tenant]);
 if (invalidation === "organization MFA required") {
  await db.query("INSERT INTO org_members(org_id,user_id,role,status) VALUES($1,$2,'maintenance','active')", [ORG_ID, USERS.tenant]);
  await db.query("UPDATE organizations SET settings=settings || '{\"require_2fa\":true}' WHERE id=$1", [ORG_ID]);
  await parsed(await reauth(req("/api/line/reauth", { orgId: ORG_ID, persona: "tenant", password: DEMO_PASSWORD }, { session: bound.token })), 401);
 }
 await parsed(await flows(req("/api/line/flows", { purpose: "bind", orgId: ORG_ID, persona: "tenant", contactId: contact }, { session: bound.token })), 401);
 await parsed(await revoke(req("/api/line/identity", {}, { method: "DELETE", session: bound.token })), 401);
 await parsed(await bind(req("/api/line/bind", { flow: pending.flow, idToken: jwt(), consentTextKey: "line.binding.v1" }, { session: bound.token })), 401);
});
// Only the disposable fixture connection may remove seeded append-only evidence.
async function removeSeedConsent(userId: string) {
 await db.query("SET session_replication_role=replica");
 try { await db.query("DELETE FROM consents WHERE user_id=$1", [userId]); }
 finally { await db.query("SET session_replication_role=origin"); }
}
for (const evidence of ["missing", "stale", "current", "new account"] as const) test(`invite ${evidence} legal consent is never implicitly recorded`, async () => {
 const f = await inviteFlow({ user: evidence !== "new account" });
 if (evidence === "missing") await removeSeedConsent(USERS.tenant);
 if (evidence === "stale") {
  await removeSeedConsent(USERS.tenant);
  await db.query("INSERT INTO consents(user_id,accepted_at,terms_version,privacy_version,source) VALUES($1,now(),'2020-01-01','2020-01-01','portal')", [USERS.tenant]);
 }
 const consentBefore = (await db.query("SELECT * FROM consents ORDER BY id")).rows;
 const metadataBefore = (await db.query("SELECT raw_app_meta_data,raw_user_meta_data FROM auth.users WHERE id=$1", [USERS.tenant])).rows;
 const res = await acceptFlow(f.flow, { password: evidence === "new account" ? "ValidLocalPass903" : DEMO_PASSWORD });
 const result = await parsed(res);
 assert.ok(sessionCookie(res));
 assert.equal(result.next, evidence === "current" ? "/t" : "/consent/portal?next=%2Ft");
 assert.deepEqual((await db.query("SELECT * FROM consents ORDER BY id")).rows, consentBefore);
 if (evidence === "new account") {
  const created = (await db.query("SELECT raw_app_meta_data,raw_user_meta_data FROM auth.users WHERE email='new-invite@local.test'")).rows[0];
  assert.equal(created.raw_app_meta_data?.consent, undefined);
  assert.equal(created.raw_user_meta_data?.terms_accepted_at, undefined);
 }

 assert.deepEqual((await db.query("SELECT raw_app_meta_data,raw_user_meta_data FROM auth.users WHERE id=$1", [USERS.tenant])).rows, metadataBefore);
});
async function reassignVendor(cid: string) {
 const token = await createSession(USERS.admin, false, meta);
 const sid = (await db.query("SELECT id FROM auth_sessions WHERE token_hash=$1", [lineHash(token)])).rows[0].id;
 await db.query("BEGIN");
 await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [USERS.admin]);
 const result = (await db.query("SELECT app.b026_rebind_vendor_account($1,$1,'live',$2,$3,$4,$5) result", [ORG_ID, sid, cid, USERS.tenant2, lineHash(randomProof())])).rows[0].result;
 await db.query("COMMIT");
 assert.equal(result.status, "invited");
 assert.equal((await db.query("SELECT app.b033_contact_user($1,$2,'vendor') id", [ORG_ID, cid])).rows[0].id, null);
}
// QA round 3: exercise the real bind service all the way to captured dispatch.
async function pushFor(bound: { cid: string; linkId: string }, persona: LinePersona): Promise<LinePush> {
 for (const key of ["line_push", "notification_delivery_v2"]) {
  await db.query("UPDATE platform_settings SET value=$2 WHERE key=$1", [key, JSON.stringify({ enabled: true, allowed_org_ids: [ORG_ID] })]);
  await db.query("UPDATE organizations SET feature_flags=feature_flags || jsonb_build_object($2::text,true) WHERE id=$1", [ORG_ID, key]);
 }
 await db.query("SELECT app.b033_org_budget_set($1,$2,date_trunc('month',now() AT TIME ZONE 'Asia/Taipei')::date,180)", [channel, ORG_ID]);
 await db.query("UPDATE app.b033_line_identities SET friend_state=true WHERE id=(SELECT login_identity_id FROM line_account_links WHERE id=$1)", [bound.linkId]);
 await db.query("UPDATE line_account_links SET is_friend=true WHERE id=$1", [bound.linkId]);
 const notification = (await db.query(`INSERT INTO notifications(org_id,recipient_contact_id,event_type,template_key,locale)
  VALUES($1,$2,'b033_test','local-test','en') RETURNING id`, [ORG_ID, bound.cid])).rows[0].id;
 return { orgId: ORG_ID, notificationId: notification, claimId: randomUUID(), channelId: channel,
  persona, to: sub, identityPepper: pepper, messages: [{ type: "text", text: "local test" }] };
}
const pushEnv = { LINE_PLATFORM_ENABLED: "true", LINE_PUSH_QUOTA_GUARD: "true" };
test("bound vendor with NULL contact user dispatches using the authoritative B-026 account", async () => {
 const bound = await bindPersona("vendor");
 assert.equal((await db.query("SELECT user_id FROM contacts WHERE id=$1", [bound.cid])).rows[0].user_id, null);
 const request = await pushFor(bound, "vendor"), transport = createCapturedLineTransport({ mode: "accepted" });
 assert.deepEqual(await dispatchLinePush(request, transport, pushEnv), { status: "accepted" });
 assert.equal(transport.calls.length, 1);
 assert.deepEqual((await db.query("SELECT channel,status,counts_toward_quota FROM deliveries WHERE b033_claim_id=$1", [request.claimId])).rows,
  [{ channel: "line", status: "sent", counts_toward_quota: true }]);
});
for (const first of ["tenant", "vendor"] as const) test(`shared identity first bound as ${first} dispatches both link personas`, async () => {
 const second = first === "tenant" ? "vendor" : "tenant";
 const bindings = [{ persona: first, bound: await bindPersona(first) }, { persona: second, bound: await bindPersona(second) }] as const;
 assert.deepEqual((await db.query("SELECT persona FROM app.b033_line_identities")).rows, [{ persona: first }]);
 const transport = createCapturedLineTransport({ mode: "accepted" });
 for (const { persona, bound } of bindings) {
  assert.deepEqual(await dispatchLinePush(await pushFor(bound, persona), transport, pushEnv), { status: "accepted" });
 }
 assert.equal(transport.calls.length, 2);
});
test("link persona prevents a shared identity's original persona from authorizing another link", async () => {
 await bindPersona("tenant");
 const bound = await bindPersona("vendor");
 // Deliberately satisfy the old contact/user/identity predicate for the wrong persona.
 await db.query("UPDATE contacts SET user_id=NULL WHERE id=$1", [contact]);
 await db.query("UPDATE contacts SET user_id=$2,is_tenant=true WHERE id=$1", [bound.cid, bound.user]);
 const request = await pushFor(bound, "tenant"), transport = createCapturedLineTransport({ mode: "accepted" });
 const result = await dispatchLinePush(request, transport, pushEnv);
 assert.equal(result.reason, "line_guard"); assert.equal(transport.calls.length, 0);
});
test("vendor reassignment removes push eligibility even if the stale contact user still matches", async () => {
 const bound = await bindPersona("vendor"), request = await pushFor(bound, "vendor");
 await db.query("UPDATE contacts SET user_id=$2 WHERE id=$1", [bound.cid, bound.user]);
 await reassignVendor(bound.cid);
 const transport = createCapturedLineTransport({ mode: "accepted" });
 const result = await dispatchLinePush(request, transport, pushEnv);
 assert.equal(result.reason, "line_guard"); assert.equal(transport.calls.length, 0);
});
test("historical vendor list retains identity ownership and portal gates, then unlinks by the listed ID", async () => {
 const bound = await bindPersona("vendor");
 await reassignVendor(bound.cid);
 await enabled("vendor", false);
 const before = await snapshot();
 await parsed(await links(req("/api/line/links", undefined, { session: bound.token })), 404);
 assert.deepEqual(await snapshot(), before);
 await enabled("vendor");
 const listed = await parsed(await links(req("/api/line/links", undefined, { session: bound.token })));
 assert.equal(listed.links.length, 1); assert.equal(listed.links[0].id, bound.linkId);
 const stranger = await steppedSession(USERS.tenant2, false, meta);
 assert.deepEqual(await parsed(await links(req("/api/line/links", undefined, { session: stranger }))), { links: [] });
 const id = listed.links[0].id;
 await parsed(await unlink(req(`/api/line/links/${id}`, { reason: "user_request" }, { method: "DELETE", session: bound.token }), { params: Promise.resolve({ id }) }));
 const history = await parsed(await links(req("/api/line/links", undefined, { session: bound.token })));
 assert.equal(history.links[0].id, id); assert.equal(history.links[0].status, "unlinked");
 assert.equal(history.links[0].notificationOptIn, false);
 assert.equal((await db.query("SELECT count(*)::int n FROM app.b026_vendor_accounts WHERE contact_id=$1", [bound.cid])).rows[0].n, 0);
});
for (const action of ["self unlink", "staff unlink", "global revoke"] as const) test(`vendor reassignment permits historical ${action} without restoring account scope`, async () => {
 const bound = await bindPersona("vendor");
 const f = await flow({ persona: "vendor" });
 const signed = await session(req("/api/line/session", { flow: f.flow, idToken: jwt() })); await parsed(signed);
 const lineToken = sessionCookie(signed)!;
 await reassignVendor(bound.cid);
 const stranger = await steppedSession(USERS.tenant2, false, meta);
 await parsed(await unlink(req(`/api/line/links/${bound.linkId}`, { reason: "user_request" }, { method: "DELETE", session: stranger }), { params: Promise.resolve({ id: bound.linkId }) }), 404);
 if (action === "global revoke") {
  await parsed(await revoke(req("/api/line/identity", {}, { method: "DELETE", session: bound.token })));
  assert.ok((await db.query("SELECT revoked_at FROM auth_sessions WHERE token_hash=$1", [lineHash(lineToken)])).rows[0].revoked_at);
 } else {
  const actor = action === "staff unlink" ? await createSession(USERS.manager, false, meta) : bound.token;
  await parsed(await unlink(req(`/api/line/links/${bound.linkId}`, { reason: action === "staff unlink" ? "staff_request" : "user_request" }, { method: "DELETE", session: actor }), { params: Promise.resolve({ id: bound.linkId }) }));
  // Global revoke also handles already-deactivated historical links.
  await parsed(await revoke(req("/api/line/identity", {}, { method: "DELETE", session: bound.token })));
  assert.ok((await db.query("SELECT revoked_at FROM auth_sessions WHERE token_hash=$1", [lineHash(lineToken)])).rows[0].revoked_at);
 }
 const link = (await db.query("SELECT status,notification_opt_in FROM line_account_links WHERE id=$1", [bound.linkId])).rows[0];
 assert.deepEqual(link, { status: "unlinked", notification_opt_in: false });
 await assert.rejects(db.query("UPDATE line_account_links SET status='linked',unlinked_at=NULL WHERE id=$1", [bound.linkId]), /Identity mismatch/);
 assert.equal((await db.query("SELECT count(*)::int n FROM app.b026_vendor_accounts WHERE contact_id=$1", [bound.cid])).rows[0].n, 0);
});
test("vendor LINE destination resolves to the existing account page and enforces its real API authorization", async () => {
 const bound = await bindPersona("vendor"), f = await flow({ persona: "vendor" });
 const signed = await session(req("/api/line/session", { flow: f.flow, idToken: jwt() }));
 const result = await parsed(signed), token = sessionCookie(signed)!;
 assert.equal(result.next, "/vendor-account");
 const page = readFileSync(`src/app${result.next}/page.tsx`, "utf8");
 assert.match(page, /import VendorAccountPanel from "\.\/panel"/);
 assert.match(readFileSync(`src/app${result.next}/panel.tsx`, "utf8"), /fetch\("\/api\/vendor-account"/);
 assert.equal((await vendorAccount(req("/api/vendor-account"))).status, 403);
 const sync = await vendorAccountMutation(req("/api/vendor-account", { action: "sync" }, { session: token }));
 assert.equal(sync.status, 200);
 const response = await vendorAccount(req("/api/vendor-account", undefined, { session: token }));
 assert.equal(response.status, 200);
 const data = await response.json();
 assert.ok(data.settings.some((s: { contactId: string }) => s.contactId === bound.cid));
 assert.equal(data.jobs.length, 0); // Binding does not invent job authorization.
 const foreign = await createSession(USERS.tenant2, false, meta);
 const other = await vendorAccount(req("/api/vendor-account", undefined, { session: foreign }));
 assert.equal(other.status, 200); assert.deepEqual(await other.json(), { settings: [], jobs: [] });
 await removeSeedConsent(bound.user);
 assert.equal((await vendorAccount(req("/api/vendor-account", undefined, { session: token }))).status, 403);
 const again = await flow({ persona: "vendor" });
 assert.equal((await parsed(await session(req("/api/line/session", { flow: again.flow, idToken: jwt() })))).next, "/consent?next=%2Fvendor-account");
});

for (const persona of ["tenant", "owner", "vendor"] as const) test(`${persona} reauthentication OFF preserves rows`, async () => {
 const token = await createSession(USERS.tenant, false, meta);
 await enabled(persona, false); const before = await snapshot();
 await parsed(await reauth(req("/api/line/reauth", { orgId: ORG_ID, persona, password: DEMO_PASSWORD }, { session: token })), 404);
 assert.deepEqual(await snapshot(), before);
});
test("step-up admission survives incorrect passwords and rejects CSRF before credential writes", async () => {
 const token = await createSession(USERS.tenant, false, meta);
 const input = { orgId: ORG_ID, persona: "tenant", password: DEMO_PASSWORD };
 const before = await snapshot();
 await parsed(await reauth(req("/api/line/reauth", input, { session: token, csrf: "wrong" })), 403);
 await parsed(await reauth(req("/api/line/reauth", input, { session: token, origin: "https://evil.test" })), 403);
 assert.deepEqual(await snapshot(), before);
 for (let i = 0; i < 10; i++) await parsed(await reauth(req("/api/line/reauth", { ...input, password: "wrong" }, { session: token })), 401);
 await parsed(await reauth(req("/api/line/reauth", input, { session: token })), 429);
 assert.equal((await db.query("SELECT count(*)::int n FROM app.b033_line_stepups")).rows[0].n, 0);
});

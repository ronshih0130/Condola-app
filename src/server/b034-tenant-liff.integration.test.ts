import assert from "node:assert/strict";
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
import { LINE_BROWSER_COOKIE, LINE_CSRF_COOKIE } from "./line/login-routes";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { tx } from "./db";
import { resolveIdentity } from "./identity";
import { sessionOn, lineTransaction } from "./line/login-link";
import { tenantLineInviteOrg, tenantLineEntryEnabled } from "./line/tenant-entry";
import { GET as vendorAccount } from "../app/api/vendor-account/route";
import { randomProof } from "./line/login-link";
import { dispatchLinePush, type LinePush } from "./line/quota";
import { createCapturedLineTransport } from "./line/transport";
import { POST as reauth } from "../app/api/line/reauth/route";
import { POST as flows } from "../app/api/line/flows/route";
import { POST as session } from "../app/api/line/session/route";
import { POST as accept } from "../app/api/line/invites/accept/route";
import { POST as bind } from "../app/api/line/bind/route";
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
 const names = ["auth.users", "contacts", "invitations", "app.b033_line_identities", "auth_sessions", "line_account_links", "consents", "audit_log", "app.b033_line_flows", "app.b033_line_sessions", "app.b033_line_limits", "app.b033_line_stepups", "notifications", "deliveries", "app.b028_delivery_attempts", "app.b033_push_fallbacks"];
 const result: Record<string, unknown> = {};
 for (const name of names) result[name] = (await db.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS data FROM ${name} t`)).rows[0].data;
 return result;
}
async function identityCounts() { return (await db.query(`SELECT (SELECT count(*)::int FROM app.b033_line_identities) identities,
 (SELECT count(*)::int FROM auth_sessions) sessions,(SELECT count(*)::int FROM line_account_links WHERE login_identity_id IS NOT NULL) links`)).rows[0]; }
async function unconsumed(id: string) { assert.equal((await db.query("SELECT status FROM invitations WHERE id=$1", [id])).rows[0].status, "pending"); }

test.before(async () => {
 clone = await cloneTestDatabase(); db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
 globalThis.fetch = async () => { throw new Error("External HTTP forbidden in B-034 tests"); };
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

async function accepted() {
 const f = await inviteFlow(), response = await acceptFlow(f.flow), result = await parsed(response);
 return { ...f, ...result, token: sessionCookie(response)!, response };
}
async function login(token?: string, fields: Record<string, string> = {}) {
 const f = await flow(fields);
 const response = await session(req("/api/line/session", { flow: f.flow, idToken: jwt() }, { session: token }));
 return { response, flow: f.flow };
}
async function queued(linkId: string): Promise<LinePush> {
 for (const key of ["line_push", "notification_delivery_v2"]) {
  await db.query("UPDATE platform_settings SET value=$2 WHERE key=$1", [key, JSON.stringify({ enabled: true, allowed_org_ids: [ORG_ID] })]);
  await db.query("UPDATE organizations SET feature_flags=feature_flags || jsonb_build_object($2::text,true) WHERE id=$1", [ORG_ID, key]);
 }
 await db.query("SELECT app.b033_org_budget_set($1,$2,date_trunc('month',now() AT TIME ZONE 'Asia/Taipei')::date,180)", [channel, ORG_ID]);
 await db.query("UPDATE app.b033_line_identities SET friend_state=true WHERE id=(SELECT login_identity_id FROM line_account_links WHERE id=$1)", [linkId]);
 await db.query("UPDATE line_account_links SET is_friend=true WHERE id=$1", [linkId]);
 const id = (await db.query(`INSERT INTO notifications(org_id,recipient_contact_id,event_type,template_key,locale)
  VALUES($1,$2,'b034_test','local-test','en') RETURNING id`, [ORG_ID, contact])).rows[0].id;
 return { orgId: ORG_ID, notificationId: id, claimId: randomUUID(), channelId: channel,
  persona: "tenant", to: sub, identityPepper: pepper, messages: [{ type: "text", text: "local test" }] };
}
async function unlinkRequest(id: string, token: string) {
 return unlink(req(`/api/line/links/${id}`, { reason: "user_request" }, { method: "DELETE", session: token }), { params: Promise.resolve({ id }) });
}
async function enableSecondOrg() {
 for (const key of ["line_platform", "line_tenant_portal", "line_owner_portal", "line_vendor_portal"]) {
  await db.query("UPDATE platform_settings SET value=$2 WHERE key=$1", [key, JSON.stringify({ enabled: true, allowed_org_ids: [ORG_ID, ORG2_ID] })]);
  await db.query("UPDATE organizations SET feature_flags=feature_flags||jsonb_build_object($2::text,true) WHERE id=$1", [ORG2_ID, key]);
 }
}
async function secondCompanyLink(token: string) {
 await enableSecondOrg();
 const cid = (await db.query("SELECT id FROM contacts WHERE org_id=$1 AND user_id=$2 AND is_tenant", [ORG2_ID, USERS.tenant])).rows[0].id;
 await db.query("DELETE FROM line_account_links WHERE contact_id=$1", [cid]);
 const f = await flow({ purpose: "bind", orgId: ORG2_ID, contactId: cid }, token);
 return parsed(await bind(req("/api/line/bind", { flow: f.flow, idToken: jwt(), consentTextKey: "line.binding.v1" }, { session: token })));
}

test("A1 LINE-first binding uses condola_session; own leases only and foreign selectors grant nothing", async () => {
 const a = await accepted();
 const cookies = a.response.headers.get("set-cookie")!;
 for (const attr of ["HttpOnly", "Secure", "SameSite=lax", "Path=/"]) assert.ok(cookies.includes(attr));
 const identity = await lineTransaction(c => sessionOn(c, a.token)); assert.equal(identity?.user_id, USERS.tenant);
 const actual = await tx(identity!.user_id, c => c.query("SELECT lease_id::text FROM app.my_tenant_leases()"), { orgId: ORG_ID, environment: "live" });
 const own = (await db.query("SELECT lp.lease_id::text FROM lease_parties lp JOIN contacts c ON c.id=lp.contact_id WHERE c.user_id=$1", [USERS.tenant])).rows;
 assert.deepEqual(actual.rows.map(r => r.lease_id).sort(), own.map(r => r.lease_id).sort()); assert.ok(actual.rows.some(r => r.lease_id === lease));
 const foreign = (await db.query("SELECT l.id FROM leases l WHERE NOT EXISTS(SELECT 1 FROM lease_parties lp JOIN contacts c ON c.id=lp.contact_id WHERE lp.lease_id=l.id AND c.user_id=$1) ORDER BY l.id LIMIT 1", [USERS.tenant])).rows[0].id;
 assert.equal((await tx(identity!.user_id, c => c.query("SELECT * FROM app.my_tenant_leases() WHERE lease_id=$1", [foreign]), { orgId: ORG2_ID, environment: "live" })).rowCount, 0);
 const resolved = await resolveIdentity(db, identity!.user_id, { path: "/o", portalCookie: "owner", preferredOrg: ORG2_ID, envCookie: "live", leaseId: foreign });
 assert.equal(resolved?.kind, "tenant"); assert.equal(resolved?.orgId, ORG_ID);
 const signed = await login(a.token); await parsed(signed.response); assert.equal(sessionCookie(signed.response), a.token);
 await parsed(await session(req("/api/line/session", { flow: signed.flow, idToken: jwt() })), 409);
});
for (const conflict of ["current account", "provider identity"] as const) test(`A2 ${conflict} conflict leaves invitation/contact/link/session atomic`, async () => {
 const f = await inviteFlow();
 const token = conflict === "current account" ? await createSession(USERS.tenant2, false, meta) : undefined;
 if (conflict === "provider identity") {
  const { providerUserHash } = await import("./line/webhook");
  await db.query("INSERT INTO app.b033_line_identities(line_channel_id,provider_user_hash,user_id,persona) VALUES($1,$2,$3,'tenant')", [channel, providerUserHash("provider-demo", sub, pepper), USERS.tenant2]);
 }
 const before = await snapshot();
 await parsed(await acceptFlow(f.flow, {}, token), 409); await unconsumed(f.id);
 const after = await snapshot();
 for (const table of ["auth.users", "contacts", "invitations", "line_account_links", "auth_sessions", "app.b033_line_identities", "consents", "audit_log"]) assert.deepEqual(after[table], before[table], table);
});
test("A3 org unlink falls back queued work to one Email, preserving the other-company link", async () => {
 const a = await accepted(), password = await steppedSession(USERS.tenant, false, meta), other = await secondCompanyLink(password);
 const work = await queued(a.linkId);
 await parsed(await unlinkRequest(a.linkId, password));
 const transport = createCapturedLineTransport({ mode: "accepted" });
 for (let i=0; i<2; i++) await dispatchLinePush(work, transport, { LINE_PLATFORM_ENABLED: "true", LINE_PUSH_QUOTA_GUARD: "true" });
 assert.equal(transport.calls.length, 0);
 assert.deepEqual((await db.query("SELECT channel,status FROM deliveries WHERE notification_id=$1 ORDER BY channel", [work.notificationId])).rows, [{ channel: "email", status: "queued" }, { channel: "line", status: "skipped" }]);
 assert.equal((await db.query("SELECT count(*)::int n FROM app.b028_delivery_attempts WHERE source_id=$1 AND channel='email'", [work.notificationId])).rows[0].n, 1);
 assert.equal((await db.query("SELECT status FROM line_account_links WHERE id=$1", [other.linkId])).rows[0].status, "linked");
 assert.ok(await lineTransaction(c => sessionOn(c, a.token)));
 const unlinkedLogin = await login(); assert.deepEqual(await parsed(unlinkedLogin.response), { action: "account_required" });
 const otherLogin = await login(undefined, { orgId: ORG2_ID }); await parsed(otherLogin.response);
});
test("A4 global unlink revokes every LINE session across orgs, retains verified Email/password and password session", async () => {
 const a = await accepted(), password = await steppedSession(USERS.tenant, false, meta);
 await secondCompanyLink(password);
 const second = await login(); await parsed(second.response);
 const third = await login(undefined, { orgId: ORG2_ID }); await parsed(third.response);
 const account = (await db.query("SELECT email,email_confirmed_at,encrypted_password FROM auth.users WHERE id=$1", [USERS.tenant])).rows[0];
 const work = await queued(a.linkId);
 await parsed(await revoke(req("/api/line/identity", {}, { method: "DELETE", session: password })));
 for (const token of [a.token, sessionCookie(second.response), sessionCookie(third.response)]) assert.equal(await lineTransaction(c => sessionOn(c, token)), null);
 assert.ok(await lineTransaction(c => sessionOn(c, password)));
 assert.deepEqual((await db.query("SELECT email,email_confirmed_at,encrypted_password FROM auth.users WHERE id=$1", [USERS.tenant])).rows[0], account);
 assert.equal((await db.query("SELECT count(*)::int n FROM line_account_links WHERE login_identity_id IS NOT NULL AND (status<>'unlinked' OR notification_opt_in)")).rows[0].n, 0);
 const transport = createCapturedLineTransport({ mode: "accepted" });
 await dispatchLinePush(work, transport, { LINE_PLATFORM_ENABLED: "true", LINE_PUSH_QUOTA_GUARD: "true" }); assert.equal(transport.calls.length, 0);
 assert.equal((await db.query("SELECT count(*)::int n FROM deliveries WHERE notification_id=$1 AND channel='email' AND status='queued'", [work.notificationId])).rows[0].n, 1);
 const { signIn } = await import("./auth");
 const result = await signIn(account.email, DEMO_PASSWORD, false, meta); assert.equal(result.ok, true);
});
test("A4 recovery and required MFA cannot be bypassed by a fresh session or a LINE token", async () => {
 const a = await accepted(); const before = await identityCounts();
 await parsed(await revoke(req("/api/line/identity", {}, { method: "DELETE", session: a.token })), 401);
 const factor = "JBSWY3DPEHPK3PXP";
 await db.query("INSERT INTO user_mfa(user_id,enabled,totp_secret) VALUES($1,true,$2)", [USERS.tenant, factor]);
 await parsed(await reauth(req("/api/line/reauth", { orgId: ORG_ID, persona: "tenant", password: DEMO_PASSWORD }, { session: a.token })), 401);
 await parsed(await reauth(req("/api/line/reauth", { orgId: ORG_ID, persona: "tenant", password: DEMO_PASSWORD, secondFactor: totpCode(factor) }, { session: a.token })));
 await db.query("UPDATE auth.users SET email_confirmed_at=NULL WHERE id=$1", [USERS.tenant]);
 await parsed(await revoke(req("/api/line/identity", {}, { method: "DELETE", session: a.token })), 401);
 assert.deepEqual(await identityCounts(), before);
});
for (const state of ["missing cookies", "wrong cookies", "expired", "consumed"] as const) test(`A5 ${state}: reopening cannot replay or expose flow scope`, async () => {
 const f = await flow();
 if (state === "expired") await db.query("UPDATE app.b033_line_flows SET expires_at=now()-interval '1 minute'");
 if (state === "consumed") await db.query("UPDATE app.b033_line_flows SET consumed_at=now()");
 const before = await snapshot();
 const request = state === "missing cookies" ? new Request(`${origin}/t/liff?flow=${f.flow}`) : req(`/t/liff?flow=${f.flow}`);
 if (state === "wrong cookies") request.headers.set("cookie", `${LINE_BROWSER_COOKIE}=${randomProof()}; ${LINE_CSRF_COOKIE}=${csrf}`);
 const response = await tenantEntry(request);
 assert.equal(response.status, state === "wrong cookies" ? 404 : 303);
 assert.equal(response.headers.get("set-cookie"), null);
 assert.ok(!JSON.stringify([...response.headers]).includes(f.flow));
 assert.deepEqual(await snapshot(), before);
 const fresh = await tenantEntry(new Request(`${origin}/t/liff?org=${ORG_ID}`)); assert.equal(fresh.status, 200);
 assert.ok(fresh.headers.get("set-cookie"));
});
test("entry and management hints recheck tenant/contact/company; foreign and missing are identical", async () => {
 await enableSecondOrg(); const token = await createSession(USERS.tenant2, false, meta);
 const ownContact = (await db.query("SELECT id FROM contacts WHERE org_id=$1 AND user_id=$2", [ORG_ID, USERS.tenant2])).rows[0].id;
 const before = await snapshot();
 const own = await tenantEntry(req(`/t/liff?org=${ORG_ID}&mode=manage&contactId=${randomUUID()}&persona=owner`, undefined, { session: token }));
 assert.equal(own.status, 200); const html = await own.text(); assert.ok(html.includes(ownContact)); assert.ok(html.includes('"persona":"tenant"'));
 const foreign = await tenantEntry(req(`/t/liff?org=${ORG2_ID}&mode=manage`, undefined, { session: token }));
 const missing = await tenantEntry(req(`/t/liff?org=${randomUUID()}&mode=manage`, undefined, { session: token }));
 assert.equal(foreign.status, 404); assert.equal(await foreign.text(), await missing.text());
 assert.deepEqual(await snapshot(), before);
});
test("foreign unlink and nonexistent link use identical denial, even on an unhealthy channel", async () => {
 const a = await accepted(); const foreign = await createSession(USERS.coastAdmin, false, meta);
 await db.query("UPDATE line_channels SET tenant_config_verified_at=NULL WHERE id=$1", [channel]);
 const before = await snapshot();
 const real = await unlinkRequest(a.linkId, foreign), missing = await unlinkRequest(randomUUID(), foreign);
 assert.equal(real.status, 404); assert.equal(await real.text(), await missing.text()); assert.deepEqual(await snapshot(), before);
});
for (const persona of ["tenant", "vendor", "owner"] as const) {
 for (const gate of ["env", "platform", "org", "portal", "malformed", "allowlist"] as const) test(`${persona} ${gate} OFF: exported routes return 404, zero writes`, async () => {
  const f = await flow({ persona });
  if (gate === "env") process.env.LINE_PLATFORM_ENABLED = "false";
  if (gate === "platform") await db.query("UPDATE platform_settings SET value='{}' WHERE key='line_platform'");
  if (gate === "org") await db.query("UPDATE organizations SET feature_flags=feature_flags||'{\"line_platform\":false}' WHERE id=$1", [ORG_ID]);
  if (gate === "portal") await enabled(persona, false);
  if (gate === "malformed") await db.query("UPDATE organizations SET feature_flags=feature_flags||jsonb_build_object($2::text,'true'::text) WHERE id=$1", [ORG_ID, `line_${persona}_portal`]);
  if (gate === "allowlist") await db.query("UPDATE platform_settings SET value='{\"enabled\":true,\"allowed_org_ids\":[]}' WHERE key=$1", [`line_${persona}_portal`]);
  const before = await snapshot();
  assert.equal((await entries[persona](req(`/${persona[0]}/liff?org=${ORG_ID}`))).status, 404);
  await parsed(await flows(req("/api/line/flows", { purpose: "login", orgId: ORG_ID, persona })), 404);
  await parsed(await session(req("/api/line/session", { flow: f.flow, idToken: jwt() })), 404);
  await parsed(await bind(req("/api/line/bind", { flow: f.flow, idToken: jwt() })), 404);
  await parsed(await accept(req("/api/line/invites/accept", { flow: f.flow, idToken: jwt() })), 404);
  await parsed(await reauth(req("/api/line/reauth", { orgId: ORG_ID, persona, password: DEMO_PASSWORD })), 404);
  assert.deepEqual(await snapshot(), before);
 });
}
test("tenant entry controls are strict gates and invitation kind fixes org/persona", async () => {
 const i = await invite(); assert.equal(await tenantLineInviteOrg(i.token), ORG_ID); assert.equal(await tenantLineEntryEnabled(ORG_ID), true);
 const f = await flow({ purpose: "invite", inviteToken: i.token, persona: "owner", orgId: ORG2_ID });
 const stored = (await db.query("SELECT org_id,persona FROM app.b033_line_flows WHERE flow_hash=$1", [lineHash(f.flow)])).rows[0];
 assert.deepEqual(stored, { org_id: ORG_ID, persona: "tenant" });
 await enabled("tenant", false); const before = await snapshot();
 assert.equal(await tenantLineInviteOrg(i.token), null); assert.equal(await tenantLineEntryEnabled(ORG_ID), false); assert.deepEqual(await snapshot(), before);
});
test("tenant identity cannot switch into owner/vendor or use a job token as an account credential", async () => {
 await accepted();
 for (const persona of ["owner", "vendor"] as const) {
  const attempt = await login(undefined, { persona }); assert.deepEqual(await parsed(attempt.response), { action: "account_required" });
 }
 const raw = await vendorAccount(new Request(`${origin}/api/vendor-account?token=${randomProof()}`));
 assert.equal(raw.status, 403);
 assert.equal((await db.query("SELECT count(*)::int n FROM org_members WHERE user_id=$1", [USERS.tenant])).rows[0].n, 0);
 assert.equal((await db.query("SELECT count(*)::int n FROM app.b026_vendor_accounts WHERE user_id=$1", [USERS.tenant])).rows[0].n, 0);
});

async function browserHarness(options: { flow?: string; dropSession?: boolean; sdk?: boolean; manageToken?: string } = {}) {
 const query = options.flow ? `flow=${options.flow}` : `org=${ORG_ID}${options.manageToken ? "&mode=manage" : ""}`;
 const entry = await tenantEntry(req(`/t/liff?${query}`, undefined, { session: options.manageToken }));
 assert.equal(entry.status, 200);
 const html = await entry.text(), raw = /id="line-bootstrap">([^<]+)<\/script>/.exec(html)![1];
 const config = JSON.parse(raw);
 if (["invite", "bind", "manage"].includes(config.purpose)) {
  assert.match(html, /id="line-confirm" method="post" action="\/api\/line\/bind"/);
  assert.match(html, /id="line-submit" type="submit" disabled/);
 }
 const jar = new Map([[LINE_BROWSER_COOKIE, browser], [LINE_CSRF_COOKIE, csrf]]);
 if (options.manageToken) jar.set("condola_session", options.manageToken);
 function takeCookies(response: Response) {
  const raw = response.headers.get("set-cookie") ?? "";
  for (const match of raw.matchAll(/(?:^|[,;]\s*)(condola_[a-z_]+)=([^;,]*)/g)) {
   if (options.dropSession && match[1] === "condola_session") continue;
   jar.set(match[1], match[2]);
  }
 }
 takeCookies(entry);
 const status = { hidden: true };
 const form = { elements: { password: { value: DEMO_PASSWORD }, secondFactor: { value: "" }, consent: { checked: false } }, onsubmit: undefined as undefined | ((e: { preventDefault(): void }) => Promise<void>) };
 const buttons = { "line-unlink": { onclick: undefined as undefined | (() => Promise<void>) }, "line-revoke": { onclick: undefined as undefined | (() => Promise<void>) } };
 const navigation: string[] = [], calls: { path: string; body: Record<string, string> }[] = [], normalized: string[] = [];
 await runInNewContext(readFileSync("public/line-bootstrap.js", "utf8"), {
  document: { getElementById: (id: string) => id === "line-bootstrap" ? { textContent: raw } : id === "line-status" ? status : id === "line-confirm" ? form : buttons[id as keyof typeof buttons] },
  window: { liff: options.sdk === false ? undefined : { init: async () => {}, isLoggedIn: () => true, getIDToken: () => jwt() } },
  location: { pathname: "/t/liff", origin, assign: (url: string) => navigation.push(url) },
  history: { replaceState: (_s: unknown, _title: string, url: string) => normalized.push(url) },
  fetch: async (path: string, opts: { method?: string; body?: string }) => {
   const body = opts.body ? JSON.parse(opts.body) : {}; calls.push({ path, body });
   const request = new Request(`${origin}${path}`, { method: opts.method ?? "GET", headers: { "Content-Type": "application/json", Origin: origin, Cookie: [...jar].map(([k,v]) => `${k}=${v}`).join("; ") }, ...(opts.body ? { body: opts.body } : {}) });
   const handler = { "/api/line/flows": flows, "/api/line/session": session, "/api/line/links": links, "/api/line/invites/accept": accept, "/api/line/bind": bind, "/api/line/reauth": reauth, "/api/line/identity": revoke }[path];
   const response = handler ? await handler(request) : path.startsWith("/api/line/links/") ? await unlink(request, { params: Promise.resolve({ id: path.split("/").at(-1)! }) }) : (() => { throw new Error("External/unexpected HTTP forbidden"); })();
   takeCookies(response); return response;
  },
 });
 return { config, jar, status, form, buttons, navigation, calls, normalized };
}
for (const dropSession of [false, true]) test(`A5 WebView fresh cookie jar ${dropSession ? "rejects" : "accepts"} session cookie: route-backed adapter`, async () => {
 await accepted();
 // Reopening has no Condola session. Fresh browser proof and verified LINE token are required.
 const h = await browserHarness({ dropSession });
 assert.deepEqual(h.calls.map(c => c.path), ["/api/line/flows", "/api/line/session", "/api/line/links"]);
 assert.deepEqual(h.navigation, dropSession ? [] : ["/t"]); assert.equal(h.status.hidden, !dropSession);
 assert.deepEqual(h.normalized, ["/t/liff"]);
 const token = h.jar.get("condola_session");
 assert.equal(Boolean(token), !dropSession);
 assert.ok(!JSON.stringify(h.navigation).includes(jwt())); assert.ok(!JSON.stringify(h.navigation).includes(token ?? "condola_session"));
});
test("invite confirmation requires explicit binding consent, uses existing acceptance handler and clears credentials", async () => {
 const f = await inviteFlow(), h = await browserHarness({ flow: f.flow });
 assert.equal(h.calls.length, 0); assert.ok(h.form.onsubmit);
 await h.form.onsubmit!({ preventDefault() {} }); assert.equal(h.calls.length, 0); await unconsumed(f.id);
 h.form.elements.consent.checked = true;
 await h.form.onsubmit!({ preventDefault() {} });
 assert.deepEqual(h.calls.map(c => c.path), ["/api/line/invites/accept", "/api/line/links"]);
 assert.deepEqual(h.navigation, ["/t"]); assert.equal(h.form.elements.password.value, "");
 assert.equal((await db.query("SELECT status FROM invitations WHERE id=$1", [f.id])).rows[0].status, "accepted");
});
test("existing-account binding requires real password step-up and fresh shared flow", async () => {
 const password = await createSession(USERS.tenant, false, meta), h = await browserHarness({ manageToken: password });
 h.form.elements.consent.checked = true;
 await h.form.onsubmit!({ preventDefault() {} });
 assert.deepEqual(h.calls.map(c => c.path), ["/api/line/reauth", "/api/line/flows", "/api/line/bind", "/api/line/links"]);
 assert.deepEqual(h.navigation, ["/t"]); assert.equal(h.jar.get("condola_session"), password);
 assert.deepEqual(await identityCounts(), { identities: 1, sessions: 1, links: 1 });
});
for (const global of [false, true]) test(`settings ${global ? "global" : "org"} unlink remains available without the SDK`, async () => {
 await accepted(); const password = await createSession(USERS.tenant, false, meta);
 const h = await browserHarness({ manageToken: password, sdk: false });
 await h.buttons[global ? "line-revoke" : "line-unlink"].onclick!();
 assert.deepEqual(h.navigation, ["/login"]);
 assert.equal((await db.query("SELECT status FROM line_account_links WHERE login_identity_id IS NOT NULL")).rows[0].status, "unlinked");
});

test("owner binding grants no property: current property_owners authority is rechecked on every read", async () => {
 const f = await inviteFlow({ persona: "owner" }), response = await acceptFlow(f.flow);
 const value = await parsed(response); assert.equal(value.next, "/o/statements");
 const actor = await lineTransaction(c => sessionOn(c, sessionCookie(response))); assert.equal(actor?.user_id, USERS.owner);
 const expected = (await db.query("SELECT po.property_id AS id FROM property_owners po JOIN contacts c ON c.id=po.owner_contact_id WHERE c.user_id=$1", [USERS.owner])).rows;
 const read = () => tx(actor!.user_id, c => c.query("SELECT id FROM properties ORDER BY id"), { orgId: ORG_ID, environment: "live" });
 assert.deepEqual((await read()).rows.map(r => r.id).sort(), expected.map(r => r.id).sort()); assert.ok(expected.length);
 await db.query("DELETE FROM property_owners WHERE owner_contact_id IN(SELECT id FROM contacts WHERE user_id=$1)", [USERS.owner]);
 assert.deepEqual((await read()).rows, []);
 const signin = await login(undefined, { persona: "owner" }); await parsed(signin.response);
 assert.deepEqual((await read()).rows, []);
});
test("multi-role switching rechecks contact role and company server-side after LINE authentication", async () => {
 const a = await accepted();
 await db.query("UPDATE contacts SET is_owner=true WHERE id=$1", [contact]);
 const ctx = { path: "/o/statements", portalCookie: "owner", preferredOrg: ORG2_ID, envCookie: "live" as const, leaseId: null };
 const first = await resolveIdentity(db, USERS.tenant, ctx); assert.equal(first?.kind, "owner"); assert.equal(first?.orgId, ORG_ID);
 await db.query("UPDATE contacts SET is_owner=false WHERE id=$1", [contact]);
 const second = await resolveIdentity(db, USERS.tenant, ctx); assert.equal(second?.kind, "tenant");
 assert.ok(await lineTransaction(c => sessionOn(c, a.token)));
});

test("a real single-job capability cannot create LINE binding, staff authority or vendor account history", async () => {
 const { dispatchVendor, approveVendorSharing, loadVendorJob, __setVendorLinkKillSwitchForTests } = await import("./vendor-repair");
 const adminToken = await createSession(USERS.admin, false, meta);
 const sid = (await lineTransaction(c => sessionOn(c, adminToken)))!.id;
 const staff = { userId: USERS.admin, sessionId: sid, orgId: ORG_ID, liveOrgId: ORG_ID, role: "admin" as const, kind: "staff" as const,
  name: "Local staff", email: "local@example.test", environment: "live" as const, locale: "en" as const, calendar: "gregorian" as const, leaseId: null };
 await db.query("UPDATE organizations SET feature_flags=feature_flags||'{\"vendor_dispatch\":true,\"vendor_link\":true}' WHERE id=$1", [ORG_ID]);
 const ticket = (await db.query(`INSERT INTO maintenance_tickets(org_id,property_id,ticket_number,category,title,description,status)
  SELECT $1,id,(SELECT coalesce(max(ticket_number),0)+1 FROM maintenance_tickets WHERE org_id=$1),'plumbing','Local repair','Local description','open'
  FROM properties WHERE org_id=$1 AND archived_at IS NULL ORDER BY id LIMIT 1 RETURNING id`, [ORG_ID])).rows[0].id;
 __setVendorLinkKillSwitchForTests(true);
 try {
  const job = await dispatchVendor(staff, ticket, { vendorName: "Local vendor", vendorPhone: "0912111222", vendorTrade: "plumbing", contactWindow: "Monday" }, origin);
  await approveVendorSharing(staff, ticket, job.jobId, { description: "Approved repair", attachmentIds: [] });
  const token = new URL(job.url).pathname.slice(3);
  assert.ok(await loadVendorJob(token));
  const before = await snapshot();
  const denied = await vendorAccount(new Request(`${origin}/api/vendor-account?token=${token}`)); assert.equal(denied.status, 403);
  const fakeSession = await vendorAccount(new Request(`${origin}/api/vendor-account`, { headers: { Cookie: `condola_session=${token}` } })); assert.equal(fakeSession.status, 403);
  await parsed(await flows(req("/api/line/flows", { purpose: "bind", orgId: ORG_ID, persona: "vendor", contactId: contact }, { session: token })), 401);
  assert.deepEqual(await snapshot(), before);
 } finally { __setVendorLinkKillSwitchForTests(false); }
});

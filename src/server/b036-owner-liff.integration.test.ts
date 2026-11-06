import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import test, { mock } from "node:test";
import { Client } from "pg";
import nextHeaders from "next/headers";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import { resetAndSeed } from "./seed";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { DEMO_PASSWORD } from "./demo-password";
import { dispatchVendor, approveVendorSharing, loadVendorJob, __setVendorLinkKillSwitchForTests } from "./vendor-repair";
import { GET as vendorAccount } from "../app/api/vendor-account/route";
import { createSession } from "./auth";
import { readSessionOn } from "./session";
import { resolveIdentity } from "./identity";
import { tenantLeases, ownerPropertyNames, ownerHome, listStatements, statementDetail, statementPdfSource } from "./queries";
import { lineHash, type LinePersona } from "./line/login-token";
import { randomProof } from "./line/login-link";
import { LINE_BROWSER_COOKIE, LINE_CSRF_COOKIE } from "./line/login-routes";
import { dispatchLinePush, type LinePush } from "./line/quota";
import { createCaptureAdapter, runDeliveryAttempts } from "./notification-delivery";
import { createCapturedLineTransport } from "./line/transport";
import { POST as flows } from "../app/api/line/flows/route";
import { POST as accept } from "../app/api/line/invites/accept/route";
import { POST as bind } from "../app/api/line/bind/route";
import { POST as session } from "../app/api/line/session/route";
import { POST as reauth } from "../app/api/line/reauth/route";
import { POST as portal } from "../app/api/line/portal/route";
import { POST as webhook } from "../app/api/line/webhook/route";
import { DELETE as unlink } from "../app/api/line/links/[id]/route";
import { DELETE as revoke } from "../app/api/line/identity/route";
import { GET as links } from "../app/api/line/links/route";
import { GET as ownerEntry } from "../app/(line)/o/liff/route";
import { GET as tenantEntry } from "../app/(line)/t/liff/route";
import { GET as vendorEntry } from "../app/(line)/v/liff/route";
import { GET as statementApi } from "../app/api/pdf/statements/[id]/route";
import type { Session } from "./types";

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
const origin = "https://app.condola.app", secret = "b036-local-secret", pepper = "b036-local-pepper";
const sub = `U${"c".repeat(32)}`, meta = { ua: "b036-local", ip: null };
const savedEnv = { ...process.env }, originalFetch = globalThis.fetch;
let db: Client, clone: Awaited<ReturnType<typeof cloneTestDatabase>>;
let channel: string, contact: string, property: string, report: string, foreignReport: string;
let browser: string, csrf: string;
const jar = new Map<string, string>();
function req(path: string, body?: Record<string, unknown>, token?: string, method?: string) {
 return new Request(origin + path, { method: method ?? (body ? "POST" : "GET"), headers: {
  "Content-Type": "application/json", Origin: origin,
  Cookie: `${LINE_BROWSER_COOKIE}=${browser}; ${LINE_CSRF_COOKIE}=${csrf}${token ? `; condola_session=${token}` : ""}`,
 }, ...(body ? { body: JSON.stringify({ csrf, ...body }) } : {}) });
}
function jwt(patch: Record<string, unknown> = {}, key = secret) {
 const now = Math.floor(Date.now() / 1000);
 const value = [{ alg: "HS256" }, { iss: "https://access.line.me", aud: "b036-login", sub, iat: now - 1, exp: now + 300, ...patch }]
  .map(v => Buffer.from(JSON.stringify(v)).toString("base64url")).join(".");
 return `${value}.${createHmac("sha256", key).update(value).digest("base64url")}`;
}
async function parsed(response: Response, status = 200) {
 assert.equal(response.status, status, await response.clone().text());
 assert.equal(response.headers.get("cache-control"), "no-store");
 assert.equal(response.headers.get("referrer-policy"), "no-referrer");
 return response.json();
}
function tokenOf(response: Response) { const value = /condola_session=([^;,]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1]; assert.ok(value); return value; }
function ownerSession(userId = USERS.owner, orgId = ORG_ID): Session {
 return { userId, orgId, liveOrgId: orgId, environment: "live", role: null, kind: "owner", sessionId: "test",
  email: "owner@local.test", name: "Owner", locale: "en", calendar: "gregorian", leaseId: null };
}
async function gate(key: string, value: unknown = true, org = ORG_ID) {
 await db.query("UPDATE platform_settings SET value=$2 WHERE key=$1", [key, JSON.stringify({ enabled: value, allowed_org_ids: [ORG_ID, ORG2_ID] })]);
 await db.query("UPDATE organizations SET feature_flags=feature_flags || jsonb_build_object($2::text,$3::jsonb) WHERE id=$1", [org, key, JSON.stringify(value)]);
}
async function flow(input: Record<string, string> = {}, token?: string) {
 return parsed(await flows(req("/api/line/flows", { purpose: "login", orgId: ORG_ID, persona: "owner", ...input }, token)), 201);
}
async function inviteFlow() {
 const raw = randomProof(), id = randomUUID();
 await db.query("UPDATE invitations SET status='revoked' WHERE contact_id=$1 AND status='pending'", [contact]);
 await db.query(`INSERT INTO invitations(id,org_id,kind,contact_id,email,code_hash,status,expires_at,invited_by)
  SELECT $1,org_id,'owner',id,email,$2,'pending',now()+interval '1 day',$3 FROM contacts WHERE id=$4`, [id, lineHash(raw), USERS.admin, contact]);
 const f = await flow({ purpose: "invite", inviteToken: raw, persona: "tenant", orgId: ORG2_ID });
 return { id, flow: f.flow as string };
}
async function accepted() {
 const f = await inviteFlow();
 const response = await accept(req("/api/line/invites/accept", { flow: f.flow, idToken: jwt(), password: DEMO_PASSWORD, consentTextKey: "line.binding.v1" }));
 const value = await parsed(response);
 return { ...f, linkId: value.linkId as string, token: tokenOf(response), response, next: value.next };
}
async function step(token: string, orgId = ORG_ID, persona: LinePersona = "owner") {
 await parsed(await reauth(req("/api/line/reauth", { orgId, persona, password: DEMO_PASSWORD }, token)));
}
async function emailSession() { const token = await createSession(USERS.owner, false, meta); await step(token); return token; }
async function unlinkWith(linkId: string, token: string) {
 return unlink(req(`/api/line/links/${linkId}`, { reason: "user_request" }, token, "DELETE"), { params: Promise.resolve({ id: linkId }) });
}
async function snapshot() {
 const names = ["auth.users", "auth_sessions", "contacts", "invitations", "property_owners", "owner_statements", "line_account_links", "audit_log", "consents",
  "app.b033_line_flows", "app.b033_line_identities", "app.b033_line_sessions", "app.b033_line_limits", "app.b033_line_stepups", "notifications", "deliveries"];
 const rows: Record<string, unknown> = {};
 for (const name of names) rows[name] = (await db.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') value FROM ${name} t`)).rows[0].value;
 return rows;
}
async function counts() { return (await db.query(`SELECT (SELECT count(*)::int FROM app.b033_line_identities) identities,
 (SELECT count(*)::int FROM auth_sessions) sessions,(SELECT count(*)::int FROM line_account_links WHERE login_identity_id IS NOT NULL) links`)).rows[0]; }
async function pdf(id: string, token: string) {
 jar.set("condola_session", token); jar.set("condola_org", ORG_ID); jar.set("condola_portal_role", "owner");
 return statementApi(req(`/api/pdf/statements/${id}`), { params: Promise.resolve({ id }) });
}
async function friend(type: "follow" | "unfollow", timestamp = Date.now(), id = randomUUID()) {
 const raw = JSON.stringify({ destination: "b036-bot", events: [{ type, timestamp, webhookEventId: id, source: { userId: sub } }] });
 return webhook(new Request(`${origin}/api/line/webhook?org=${ORG_ID}&channel=${channel}`, {
  method: "POST", headers: { "x-line-signature": createHmac("sha256", secret).update(raw).digest("base64") }, body: raw,
 }));
}
async function queued(linkId: string): Promise<LinePush> {
 for (const key of ["line_push", "notification_delivery_v2"]) await gate(key);
 await db.query("SELECT app.b033_org_budget_set($1,$2,date_trunc('month',now() AT TIME ZONE 'Asia/Taipei')::date,180)", [channel, ORG_ID]);
 await db.query("UPDATE app.b033_line_identities SET friend_state=true WHERE id=(SELECT login_identity_id FROM line_account_links WHERE id=$1)", [linkId]);
 await db.query("UPDATE line_account_links SET is_friend=true WHERE id=$1", [linkId]);
 const notificationId = (await db.query(`INSERT INTO notifications(org_id,recipient_contact_id,event_type,template_key,locale)
  VALUES($1,$2,'b036_test','local-test','en') RETURNING id`, [ORG_ID, contact])).rows[0].id;
 return { orgId: ORG_ID, notificationId, claimId: randomUUID(), channelId: channel, persona: "owner", to: sub, identityPepper: pepper, messages: [{ type: "text", text: "local fixture" }] };
}

test.before(async () => {
 clone = await cloneTestDatabase(); db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
 globalThis.fetch = async () => { throw new Error("B036 external HTTP forbidden"); };
 mock.method(nextHeaders, "cookies", async () => ({ get: (name: string) => jar.has(name) ? { value: jar.get(name) } : undefined }));
 mock.method(nextHeaders, "headers", async () => new Headers({ "x-pathname": "/o/statements" }));
});
test.beforeEach(async () => {
 process.env.DEMO_MODE = "true"; process.env.ID_DOC_ENCRYPTION_KEY = randomBytes(32).toString("hex");
 await resetAndSeed(); process.env.DEMO_MODE = "false"; process.env.LINE_PLATFORM_ENABLED = "true";
 browser = randomProof(); csrf = randomProof(); jar.clear();
 for (const key of ["line_platform", "line_owner_portal", "line_tenant_portal", "line_vendor_portal"]) await gate(key);
 channel = (await db.query("SELECT id FROM line_channels WHERE mode='platform_default' AND is_active")).rows[0].id;
 await db.query("SELECT app.b033_liff_configure($1,'b036-tenant','b036-vendor','b036-owner')", [channel]);
 await db.query("UPDATE line_channels SET login_channel_id='b036-login',login_channel_secret_ref='b036-local',messaging_channel_secret_ref='b036-local' WHERE id=$1", [channel]);
 await db.query("SELECT app.b033_channel_verify($1)", [channel]);
 process.env.LINE_CHANNEL_SECRETS = JSON.stringify({ "b036-local": { secret, identityPepper: pepper, destination: "b036-bot" } });
 contact = (await db.query("SELECT id FROM contacts WHERE org_id=$1 AND user_id=$2 AND is_owner", [ORG_ID, USERS.owner])).rows[0].id;
 property = (await db.query("SELECT property_id FROM property_owners WHERE owner_contact_id=$1 ORDER BY property_id LIMIT 1", [contact])).rows[0].property_id;
 report = (await db.query("SELECT id FROM owner_statements WHERE owner_contact_id=$1 AND status='issued' LIMIT 1", [contact])).rows[0].id;
 foreignReport = (await db.query(`INSERT INTO owner_statements(org_id,owner_contact_id,currency,period_start,period_end,status)
  SELECT org_id,id,'TWD',current_date,current_date,'issued' FROM contacts WHERE user_id=$1 RETURNING id`, [USERS.owner2])).rows[0].id;
 await db.query("DELETE FROM line_account_links WHERE contact_id=$1", [contact]);
});
test.after(async () => {
 mock.restoreAll(); globalThis.fetch = originalFetch; await db?.end(); await clone?.cleanup();
 for (const key of ["DEMO_MODE", "ID_DOC_ENCRYPTION_KEY", "LINE_PLATFORM_ENABLED", "LINE_CHANNEL_SECRETS"]) {
  if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
 }
});

test("owner invitation derives company/persona atomically; only own properties/reports and PDF are visible", async () => {
 const before = (await db.query("SELECT count(*)::int n FROM property_owners")).rows[0].n;
 const a = await accepted(); assert.equal(a.next, "/o/statements");
 assert.match(a.response.headers.get("set-cookie")!, new RegExp(`condola_org=${ORG_ID}`));
 assert.match(a.response.headers.get("set-cookie")!, /condola_portal_role=owner/);
 assert.equal((await db.query("SELECT status FROM invitations WHERE id=$1", [a.id])).rows[0].status, "accepted");
 assert.equal((await db.query("SELECT count(*)::int n FROM property_owners")).rows[0].n, before);
 const s = ownerSession(), properties = await ownerPropertyNames(s), reports = await listStatements(s);
 assert.ok(properties.some(p => p.id === property)); assert.ok(reports.some(r => r.id === report));
 assert.ok(!reports.some(r => r.id === foreignReport)); assert.ok(await statementDetail(s, report));
 assert.equal(await statementDetail(s, foreignReport), null); assert.equal(await statementPdfSource(s, foreignReport), null);
 assert.equal((await pdf(report, a.token)).status, 200);
 const foreign = await pdf(foreignReport, a.token), missing = await pdf(randomUUID(), a.token);
 assert.equal(foreign.status, 404); assert.equal(missing.status, 404); assert.equal(await foreign.text(), await missing.text());
 const ownIds = (await db.query("SELECT property_id FROM property_owners WHERE owner_contact_id=$1", [contact])).rows.map(r => r.property_id);
 assert.ok(properties.every(p => ownIds.includes(p.id)));
 const home = await ownerHome(s); assert.ok(home.length > 0);
});
test("ownership removal immediately removes property, home and reports, including previously issued PDFs", async () => {
 const a = await accepted();
 assert.equal((await pdf(report, a.token)).status, 200);
 await db.query("UPDATE property_owners SET effective_to=current_date WHERE owner_contact_id=$1", [contact]);
 assert.deepEqual(await ownerPropertyNames(ownerSession()), []); assert.deepEqual(await ownerHome(ownerSession()), []);
 assert.deepEqual(await listStatements(ownerSession()), []); assert.equal(await statementDetail(ownerSession(), report), null);
 assert.equal((await pdf(report, a.token)).status, 404);
});
test("a report with any foreign property line denies the entire aggregate", async () => {
 const other = (await db.query("SELECT id FROM properties WHERE org_id=$1 AND id NOT IN (SELECT property_id FROM property_owners WHERE owner_contact_id=$2) LIMIT 1", [ORG_ID, contact])).rows[0].id;
 await db.query("INSERT INTO owner_statement_lines(org_id,statement_id,property_id,line_type,description,amount_minor) VALUES($1,$2,$3,'adjustment','local',0)", [ORG_ID, report, other]);
 assert.equal(await statementDetail(ownerSession(), report), null); assert.equal(await statementPdfSource(ownerSession(), report), null);
 assert.ok(!(await listStatements(ownerSession())).some(r => r.id === report));
});
test("future or archived ownership never opens properties/reports", async () => {
 await db.query("UPDATE property_owners SET effective_from=current_date+1 WHERE owner_contact_id=$1", [contact]);
 assert.deepEqual(await ownerPropertyNames(ownerSession()), []); assert.equal(await statementDetail(ownerSession(), report), null);
 await db.query("UPDATE property_owners SET effective_from=current_date-1 WHERE owner_contact_id=$1", [contact]);
 await db.query("UPDATE contacts SET archived_at=now() WHERE id=$1", [contact]);
 assert.deepEqual(await ownerPropertyNames(ownerSession()), []); assert.equal(await statementDetail(ownerSession(), report), null);
});
test("late session failure rolls back invitation, mapping and link", async () => {
 const f = await inviteFlow(), before = await counts();
 await db.query("CREATE FUNCTION public.b036_fail_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'local injected fault'; END $$");
 await db.query("CREATE TRIGGER b036_fail_session BEFORE INSERT ON auth_sessions FOR EACH ROW EXECUTE FUNCTION public.b036_fail_session()");
 try {
  await parsed(await accept(req("/api/line/invites/accept", { flow: f.flow, idToken: jwt(), password: DEMO_PASSWORD, consentTextKey: "line.binding.v1" })), 503);
  assert.deepEqual(await counts(), before);
  assert.equal((await db.query("SELECT status FROM invitations WHERE id=$1", [f.id])).rows[0].status, "pending");
 } finally { await db.query("DROP TRIGGER b036_fail_session ON auth_sessions; DROP FUNCTION public.b036_fail_session()"); }
});
for (const [name, patch, key] of [["wrong channel", { aud: "foreign-channel" }, secret], ["wrong provider key", {}, "foreign-provider-secret"]] as const) {
 test(`${name} creates no identity/link/session`, async () => {
  const f = await inviteFlow(), before = await counts();
  await parsed(await accept(req("/api/line/invites/accept", { flow: f.flow, idToken: jwt(patch, key), password: DEMO_PASSWORD, consentTextKey: "line.binding.v1" })), 401);
  assert.deepEqual(await counts(), before);
 });
}
test("reused accepted owner flow creates no additional mapping", async () => {
 const a = await accepted(), before = await counts();
 await parsed(await accept(req("/api/line/invites/accept", { flow: a.flow, idToken: jwt(), password: DEMO_PASSWORD, consentTextKey: "line.binding.v1" })), 409);
 assert.deepEqual(await counts(), before);
});
for (const field of ["line_provider_id", "login_channel_id"] as const) test(`changed ${field} invalidates an outstanding owner flow before binding`, async () => {
 const f = await inviteFlow();
 await db.query(`UPDATE line_channels SET ${field}=$2 WHERE id=$1`, [channel, "changed-local-config"]);
 const before = await snapshot();
 await parsed(await accept(req("/api/line/invites/accept", { flow: f.flow, idToken: jwt(), password: DEMO_PASSWORD, consentTextKey: "line.binding.v1" })), 503);
 assert.deepEqual(await snapshot(), before);
 assert.equal((await db.query("SELECT status FROM invitations WHERE id=$1", [f.id])).rows[0].status, "pending");
});
test("existing owner binding requires step-up and never grants property authority", async () => {
 const token = await createSession(USERS.owner, false, meta), body = { purpose: "bind", orgId: ORG_ID, contactId: contact, persona: "owner" };
 await parsed(await flows(req("/api/line/flows", body, token)), 401); await step(token);
 const f = await flow(body, token), before = (await db.query("SELECT * FROM property_owners ORDER BY id")).rows;
 await parsed(await bind(req("/api/line/bind", { flow: f.flow, idToken: jwt(), consentTextKey: "line.binding.v1" }, token)));
 assert.deepEqual((await db.query("SELECT * FROM property_owners ORDER BY id")).rows, before);
});

test("multi-role switch checks actual role/company; query hints never grant access", async () => {
 const token = await emailSession();
 const body = { orgId: ORG_ID, persona: "owner" };
 const result = await portal(req("/api/line/portal?orgId=" + ORG2_ID + "&persona=vendor", body, token));
 assert.equal((await parsed(result)).next, "/o/statements");
 assert.match(result.headers.get("set-cookie")!, new RegExp(`condola_org=${ORG_ID}`));
 await parsed(await portal(req("/api/line/portal", { ...body, persona: "tenant" }, token)), 404);
 await db.query("UPDATE contacts SET is_tenant=true WHERE id=$1", [contact]);
 assert.equal((await parsed(await portal(req("/api/line/portal", { ...body, persona: "tenant" }, token)))).next, "/t");
 await db.query("UPDATE contacts SET is_owner=false WHERE id=$1", [contact]);
 const before = await snapshot();
 const denied = await parsed(await portal(req("/api/line/portal", body, token)), 404);
 assert.deepEqual(denied, { error: "not_found" }); assert.deepEqual(await snapshot(), before);
 const resolved = await resolveIdentity(db, USERS.owner, { preferredOrg: ORG_ID, path: "/o", portalCookie: "owner", envCookie: null, leaseId: null });
 assert.equal(resolved?.kind, "tenant");
});
test("multi-company owner selection rechecks current company and ignores stale tenant lease", async () => {
 for (const key of ["line_platform", "line_owner_portal"]) await gate(key, true, ORG2_ID);
 const secondContact = (await db.query(`INSERT INTO contacts(org_id,display_name,email,user_id,is_owner)
  VALUES($1,'local owner','b036-second@local.test',$2,true) RETURNING id`, [ORG2_ID, USERS.owner])).rows[0].id;
 const secondProperty = (await db.query("SELECT id FROM properties WHERE org_id=$1 LIMIT 1", [ORG2_ID])).rows[0].id;
 await db.query("INSERT INTO property_owners(org_id,property_id,owner_contact_id,is_primary) VALUES($1,$2,$3,false)", [ORG2_ID, secondProperty, secondContact]);
 const token = await emailSession();
 await parsed(await portal(req("/api/line/portal", { orgId: ORG2_ID, persona: "owner" }, token)));
 const ctx = { preferredOrg: ORG2_ID, path: "/o/statements", portalCookie: "owner", envCookie: null, leaseId: randomUUID() };
 const resolved = await resolveIdentity(db, USERS.owner, ctx);
 assert.equal(resolved?.kind, "owner"); assert.equal(resolved?.orgId, ORG2_ID);
 const properties = await ownerPropertyNames(ownerSession(USERS.owner, ORG2_ID));
 assert.deepEqual(properties.map(p => p.id), [secondProperty]);
 assert.equal(await statementDetail(ownerSession(USERS.owner, ORG2_ID), report), null);
 await db.query("UPDATE contacts SET is_owner=false WHERE id=$1", [secondContact]);
 const before = await snapshot();
 await parsed(await portal(req("/api/line/portal", { orgId: ORG2_ID, persona: "owner" }, token)), 404);
 assert.deepEqual(await snapshot(), before);
 const rechecked = await resolveIdentity(db, USERS.owner, ctx); assert.equal(rechecked?.orgId, ORG_ID);
});
test("foreign company and nonexistent company return identical denial with no writes", async () => {
 for (const key of ["line_platform", "line_owner_portal"]) await gate(key, true, ORG2_ID);
 const token = await emailSession(), before = await snapshot();
 const foreign = await parsed(await portal(req("/api/line/portal", { orgId: ORG2_ID, persona: "owner" }, token)), 404);
 const absent = await parsed(await portal(req("/api/line/portal", { orgId: randomUUID(), persona: "owner" }, token)), 404);
 assert.deepEqual(foreign, absent); assert.deepEqual(await snapshot(), before);
});
test("foreign contact binding and unlink return the same non-leaking denial", async () => {
 const a = await accepted(), token = await createSession(USERS.tenant2, false, meta); await step(token);
 const before = await snapshot();
 await parsed(await flows(req("/api/line/flows", { purpose: "bind", orgId: ORG_ID, persona: "owner", contactId: contact }, token)), 404);
 const foreign = await parsed(await unlinkWith(a.linkId, token), 404), missing = await parsed(await unlinkWith(randomUUID(), token), 404);
 assert.deepEqual(foreign, missing); assert.deepEqual(await snapshot(), before);
});
test("vendor job capabilities cannot become account, owner or staff sessions", async () => {
 const token = randomProof(), before = await snapshot();
 for (const persona of ["owner", "tenant", "vendor"]) {
  await parsed(await portal(req("/api/line/portal?token=" + token, { orgId: ORG_ID, persona }, token)), 401);
 }
 const email = await emailSession();
 await parsed(await portal(req("/api/line/portal", { orgId: ORG_ID, persona: "vendor" }, email)), 404);
 // The only new sessions/step-up rows are the explicit Email login above.
 assert.deepEqual((await snapshot())["app.b033_line_identities"], before["app.b033_line_identities"]);
});
test("portal switching requires same-origin CSRF and a readable session cookie", async () => {
 const token = await emailSession(), body = { orgId: ORG_ID, persona: "owner" }, before = await snapshot();
 const foreign = req("/api/line/portal", body, token); foreign.headers.set("origin", "https://foreign.test");
 await parsed(await portal(foreign), 403);
 await parsed(await portal(req("/api/line/portal", { ...body, csrf: "wrong" }, token)), 403);
 await parsed(await portal(req("/api/line/portal", body)), 401);
 assert.deepEqual(await snapshot(), before);
});
test("switching with stale legal consent returns the existing consent entry without accepting it", async () => {
 const token = await emailSession();
 await db.query("INSERT INTO consents(user_id,terms_version,privacy_version,source,accepted_at,recorded_at) VALUES($1,'old','old','portal',now(),now()+interval '1 second')", [USERS.owner]);
 const before = await snapshot();
 assert.equal((await parsed(await portal(req("/api/line/portal", { orgId: ORG_ID, persona: "owner" }, token)))).next, "/consent/portal?next=%2Fo%2Fstatements");
 assert.deepEqual(await snapshot(), before);
});

test("signed unfollow is monotonic, preserves account, and follow never revives an unlinked link", async () => {
 const a = await accepted(), now = Date.now();
 assert.equal((await friend("follow", now)).status, 200);
 const id = randomUUID(); assert.equal((await friend("unfollow", now + 1, id)).status, 200);
 assert.equal((await friend("unfollow", now + 1, id)).status, 200);
 assert.equal((await friend("follow", now)).status, 200);
 assert.equal((await db.query("SELECT is_friend FROM line_account_links WHERE id=$1", [a.linkId])).rows[0].is_friend, false);
 assert.equal((await db.query("SELECT count(*)::int n FROM auth.users WHERE id=$1", [USERS.owner])).rows[0].n, 1);
 const email = await emailSession(); await parsed(await unlinkWith(a.linkId, email));
 assert.equal((await friend("follow", now + 2)).status, 200);
 const link = (await db.query("SELECT status,notification_opt_in FROM line_account_links WHERE id=$1", [a.linkId])).rows[0];
 assert.deepEqual(link, { status: "unlinked", notification_opt_in: false });
});
for (const global of [false, true]) test(`${global ? "global" : "org"} unlink preserves verified Email access and queued work falls back without LINE calls`, async () => {
 const a = await accepted(), email = await emailSession(), push = await queued(a.linkId);
 if (global) await parsed(await revoke(req("/api/line/identity", {}, email, "DELETE")));
 else await parsed(await unlinkWith(a.linkId, email));
 const transport = createCapturedLineTransport({ mode: "accepted" });
 const result = await dispatchLinePush(push, transport, { LINE_PLATFORM_ENABLED: "true", LINE_PUSH_QUOTA_GUARD: "true" });
 assert.equal(result.status, "skipped"); assert.ok("emailClaim" in result && result.emailClaim); assert.equal(transport.calls.length, 0);
 const capturedEmail = createCaptureAdapter("email");
 assert.equal(await runDeliveryAttempts(ORG_ID, capturedEmail, 10), 1);
 assert.equal(await runDeliveryAttempts(ORG_ID, capturedEmail, 10), 0);
 assert.equal(capturedEmail.captures.length, 1);
 assert.equal((await dispatchLinePush(push, transport, { LINE_PLATFORM_ENABLED: "true", LINE_PUSH_QUOTA_GUARD: "true" })).status, "skipped");
 assert.equal((await db.query("SELECT count(*)::int n FROM app.b033_push_fallbacks WHERE claim_id=$1", [push.claimId])).rows[0].n, 1);
 assert.equal((await db.query("SELECT revoked_at FROM auth_sessions WHERE token_hash=$1", [lineHash(email)])).rows[0].revoked_at, null);
 assert.equal((await pdf(report, email)).status, 200);
 if (global) {
  assert.ok((await db.query("SELECT revoked_at FROM auth_sessions WHERE token_hash=$1", [lineHash(a.token)])).rows[0].revoked_at);
  await parsed(await portal(req("/api/line/portal", { orgId: ORG_ID, persona: "owner" }, a.token)), 401);
 }
 const f = await flow(); const logged = await parsed(await session(req("/api/line/session", { flow: f.flow, idToken: jwt() })));
 assert.deepEqual(logged, { action: "account_required" });
});
test("global unlink requires verified Email recovery and cannot be performed by an org admin", async () => {
 const a = await accepted(), email = await emailSession();
 const identity = (await db.query("SELECT login_identity_id FROM line_account_links WHERE id=$1", [a.linkId])).rows[0].login_identity_id;
 const admin = await createSession(USERS.admin, false, meta); await step(admin);
 await parsed(await revoke(req("/api/line/identity", { identityId: identity }, admin, "DELETE")), 404);
 await db.query("UPDATE auth.users SET email_confirmed_at=NULL WHERE id=$1", [USERS.owner]);
 const before = await snapshot(); await parsed(await revoke(req("/api/line/identity", {}, email, "DELETE")), 401);
 assert.deepEqual(await snapshot(), before);
});
test("org unlink preserves another company link and account authority", async () => {
 const a = await accepted(), email = await emailSession();
 for (const key of ["line_platform", "line_owner_portal"]) await gate(key, true, ORG2_ID);
 const cid = (await db.query("INSERT INTO contacts(org_id,display_name,email,user_id,is_owner) VALUES($1,'second','second@local.test',$2,true) RETURNING id", [ORG2_ID, USERS.owner])).rows[0].id;
 const f = await flow({ purpose: "bind", orgId: ORG2_ID, contactId: cid, persona: "owner" }, email);
 const linked = await parsed(await bind(req("/api/line/bind", { flow: f.flow, idToken: jwt(), consentTextKey: "line.binding.v1" }, email)));
 await parsed(await unlinkWith(a.linkId, email));
 assert.equal((await db.query("SELECT status FROM line_account_links WHERE id=$1", [linked.linkId])).rows[0].status, "linked");
 const login = await flow({ orgId: ORG2_ID });
 const response = await session(req("/api/line/session", { flow: login.flow, idToken: jwt() }));
 await parsed(response); assert.ok(tokenOf(response));
 await parsed(await revoke(req("/api/line/identity", {}, email, "DELETE")));
 assert.equal((await db.query("SELECT status FROM line_account_links WHERE id=$1", [linked.linkId])).rows[0].status, "unlinked");
});
test("lost WebView cookies require fresh authentication; session tokens never travel in URLs", async () => {
 const a = await accepted();
 const lost = new Request(`${origin}/o/liff?flow=${a.flow}`);
 assert.equal((await ownerEntry(lost)).status, 403);
 const f = await flow(), old = browser; browser = randomProof();
 const before = await counts();
 await parsed(await session(req("/api/line/session", { flow: f.flow, idToken: jwt() })), 404);
 assert.deepEqual(await counts(), before); browser = old;
 await parsed(await portal(req("/api/line/portal", { orgId: ORG_ID, persona: "owner" })), 401);
 const bootstrap = await ownerEntry(req(`/o/liff?org=${ORG_ID}&token=${a.token}`));
 assert.equal(bootstrap.status, 200); assert.ok(!(await bootstrap.text()).includes(a.token));
 const fresh = await flow(), response = await session(req("/api/line/session", { flow: fresh.flow, idToken: jwt() }));
 assert.equal((await parsed(response)).next, "/o/statements");
 const cookie = response.headers.get("set-cookie")!; assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=lax/i);
 assert.equal(response.headers.get("location"), null); assert.notEqual(tokenOf(response), a.token);
 jar.set("condola_session", tokenOf(response)); jar.set("condola_org", ORG_ID);
 assert.equal((await readSessionOn(db, { touch: false })).session?.kind, "owner");
});

for (const persona of ["owner", "tenant", "vendor"] as const) {
 for (const mode of ["env", "env-missing", "platform", "org", "portal", "org-portal", "platform-portal", "portal-missing", "malformed"] as const) test(`${persona} ${mode} OFF returns 404 and writes nothing`, async () => {
  const token = await emailSession(), f = await flow({ persona });
  if (mode === "env") process.env.LINE_PLATFORM_ENABLED = "TRUE";
  if (mode === "env-missing") delete process.env.LINE_PLATFORM_ENABLED;
  if (mode === "platform") await gate("line_platform", false);
  if (mode === "org") await db.query("UPDATE organizations SET feature_flags=feature_flags || '{\"line_platform\":false}' WHERE id=$1", [ORG_ID]);
  if (mode === "portal") await gate(`line_${persona}_portal`, false);
  if (mode === "org-portal") await db.query("UPDATE organizations SET feature_flags=feature_flags || jsonb_build_object($2::text,false) WHERE id=$1", [ORG_ID, `line_${persona}_portal`]);
  if (mode === "platform-portal") await db.query("UPDATE platform_settings SET value='{\"enabled\":false}'::jsonb WHERE key=$1", [`line_${persona}_portal`]);
  if (mode === "portal-missing") await db.query("UPDATE organizations SET feature_flags=feature_flags - $2::text WHERE id=$1", [ORG_ID, `line_${persona}_portal`]);
  if (mode === "malformed") await gate(`line_${persona}_portal`, "true");
  const before = await snapshot(), entry = { owner: ownerEntry, tenant: tenantEntry, vendor: vendorEntry }[persona];
  const response = await entry(req(`/${persona[0]}/liff?org=${ORG_ID}`));
  assert.equal(response.status, 404); assert.equal(response.headers.get("set-cookie"), null); assert.match(await response.text(), /href="\/login"/);
  await parsed(await portal(req("/api/line/portal", { orgId: ORG_ID, persona }, token)), 404);
  await parsed(await portal(new Request(`${origin}/api/line/portal`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orgId: ORG_ID, persona }) })), 404);
  await parsed(await flows(req("/api/line/flows", { orgId: ORG_ID, persona, purpose: "login" })), 404);
  for (const handler of [session, accept, bind]) await parsed(await handler(req("/api/line/session", { flow: f.flow, idToken: jwt() }, token)), 404);
  assert.deepEqual(await snapshot(), before);
 });
}
test("owner portal OFF also denies link listing, unlink and revoke with zero writes", async () => {
 const a = await accepted(), token = await emailSession(); await gate("line_owner_portal", false); const before = await snapshot();
 await parsed(await links(req("/api/line/links", undefined, token)), 404);
 await parsed(await unlinkWith(a.linkId, token), 404);
 await parsed(await revoke(req("/api/line/identity", {}, token, "DELETE")), 404);
 assert.deepEqual(await snapshot(), before);
});

test("owner bootstrap offers only current authorized roles; chooser POST rechecks removed authority", async () => {
 const token = await emailSession();
 await db.query("UPDATE contacts SET is_tenant=true WHERE id=$1", [contact]);
 const before = await snapshot();
 const result = await ownerEntry(req(`/o/liff?org=${ORG_ID}`, undefined, token));
 assert.equal(result.status, 200); const html = await result.text();
 assert.match(html, /data-line-portal="owner"/); assert.match(html, /data-line-portal="tenant"/);
 assert.doesNotMatch(html, /data-line-portal="vendor"/); assert.ok(!html.includes(ORG2_ID)); assert.ok(!html.includes(token));
 assert.deepEqual(await snapshot(), before);
 await db.query("UPDATE contacts SET is_owner=false WHERE id=$1", [contact]);
 await parsed(await portal(req("/api/line/portal", { orgId: ORG_ID, persona: "owner" }, token)), 404);
});
test("tenant selection keeps the existing my-lease picker limited to the authenticated tenant", async () => {
 const token = await createSession(USERS.tenant, false, meta);
 assert.equal((await parsed(await portal(req("/api/line/portal", { orgId: ORG_ID, persona: "tenant" }, token)))).next, "/t");
 const s: Session = { ...ownerSession(), userId: USERS.tenant, kind: "tenant" };
 const own = (await db.query(`SELECT lp.lease_id FROM lease_parties lp JOIN contacts c ON c.id=lp.contact_id WHERE c.user_id=$1`, [USERS.tenant])).rows.map(r => r.lease_id);
 const actual = await tenantLeases(s); assert.ok(actual.length > 0); assert.ok(actual.every(l => own.includes(l.lease_id)));
 await parsed(await portal(req("/api/line/portal", { orgId: ORG_ID, persona: "owner" }, token)), 404);
});
test("vendor portal requires the current B-026 account mapping and flag, without assigning jobs", async () => {
 const token = await emailSession(), cid = (await db.query("SELECT id FROM contacts WHERE org_id=$1 AND is_vendor LIMIT 1", [ORG_ID])).rows[0].id;
 for (const key of ["vendor_account", "vendor_dispatch"]) await gate(key);
 const inviteId = randomUUID();
 await db.query(`INSERT INTO app.b026_vendor_account_invites(id,org_id,contact_id,user_id,token_hash,created_by,expires_at,claimed_at)
  VALUES($1,$2,$3,$4,$5,$6,now()+interval '1 day',now())`, [inviteId, ORG_ID, cid, USERS.owner, lineHash(randomProof()), USERS.admin]);
 await db.query("INSERT INTO app.b026_vendor_accounts(org_id,contact_id,user_id,invite_id) VALUES($1,$2,$3,$4)", [ORG_ID, cid, USERS.owner, inviteId]);
 const before = await snapshot();
 assert.equal((await parsed(await portal(req("/api/line/portal", { orgId: ORG_ID, persona: "vendor" }, token)))).next, "/vendor-account");
 assert.deepEqual(await snapshot(), before);
 await gate("vendor_account", false);
 await parsed(await portal(req("/api/line/portal", { orgId: ORG_ID, persona: "vendor" }, token)), 404);
 await gate("vendor_account", true); await db.query("DELETE FROM app.b026_vendor_accounts WHERE contact_id=$1", [cid]);
 await parsed(await portal(req("/api/line/portal", { orgId: ORG_ID, persona: "vendor" }, token)), 404);
});
test("a foreign unhealthy company does not disclose its LINE configuration", async () => {
 for (const key of ["line_platform", "line_owner_portal"]) await gate(key, true, ORG2_ID);
 const token = await emailSession();
 await db.query("SELECT app.b033_liff_configure($1,'changed','b036-vendor','b036-owner')", [channel]);
 const before = await snapshot();
 await parsed(await portal(req("/api/line/portal", { orgId: ORG2_ID, persona: "owner" }, token)), 404);
 assert.deepEqual(await snapshot(), before);
});

test("a real single-job capability opens only its job and cannot authenticate a portal/account", async () => {
 await db.query("UPDATE organizations SET feature_flags=feature_flags || '{\"vendor_link\":true}'::jsonb WHERE id=$1", [ORG_ID]);
 const adminToken = await createSession(USERS.admin, false, meta);
 const sid = (await db.query("SELECT id FROM auth_sessions WHERE token_hash=$1", [lineHash(adminToken)])).rows[0].id;
 const admin: Session = { ...ownerSession(), userId: USERS.admin, sessionId: sid, kind: "staff", role: "admin" };
 const ticket = randomUUID();
 await db.query(`INSERT INTO maintenance_tickets(id,org_id,property_id,ticket_number,category,title,description,status)
  VALUES($1,$2,$3,(SELECT coalesce(max(ticket_number),0)+1 FROM maintenance_tickets WHERE org_id=$2),'plumbing','Local fixture','Local fixture','open')`, [ticket, ORG_ID, property]);
 __setVendorLinkKillSwitchForTests(true);
 try {
  const job = await dispatchVendor(admin, ticket, { vendorName: "Local vendor", vendorPhone: "0912111222", vendorTrade: "plumbing", contactWindow: "Monday" }, origin);
  __setVendorLinkKillSwitchForTests(true);
  await approveVendorSharing(admin, ticket, job.jobId, { description: "Local approved", attachmentIds: [] });
  const capability = new URL(job.url).pathname.slice(3);
  assert.ok(await loadVendorJob(capability));
  const before = await snapshot();
  for (const persona of ["owner", "tenant", "vendor"]) {
   await parsed(await portal(req("/api/line/portal", { orgId: ORG_ID, persona }, capability)), 401);
  }
  const response = await vendorAccount(req("/api/vendor-account", undefined, capability));
  assert.ok([403, 404].includes(response.status));
  assert.deepEqual(await snapshot(), before);
 } finally { __setVendorLinkKillSwitchForTests(false); }
});

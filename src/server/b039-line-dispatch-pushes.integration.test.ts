import "next/dist/server/node-environment-baseline";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { Client } from "pg";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import { resetAndSeed } from "./seed";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { createSession } from "./auth";
import { DEMO_PASSWORD } from "./demo-password";
import { approveVendorSharing, dispatchVendor, revokeVendorJob, __setVendorLinkKillSwitchForTests } from "./vendor-repair";
import { claimVendorAccount, inviteVendorAccount } from "./vendor-accounts";
import type { Session } from "./types";
import { lineHash } from "./line/login-token";
import { randomProof } from "./line/login-link";
import { LINE_JOB_COOKIE } from "./line/vendor-scope";
import { LINE_BROWSER_COOKIE, LINE_CSRF_COOKIE } from "./line/login-routes";
import { runVendorDispatchPushes, vendorDispatchEmailContent, vendorDispatchEmailTemplate, vendorDispatchMessages } from "./line/dispatch-push";
import { expireLinePushes } from "./line/quota";
import { createCaptureAdapter, runDeliveryAttempts } from "./notification-delivery";
import { recordVendorDispatchEvent } from "./line/dispatch-events";
import { svc } from "./db";
import { hashVendorToken } from "./vendor-repair-rules";
import { createCapturedLineTransport, type LineTransport, type PushOutcome } from "./line/transport";
import { createWebhookPost } from "./line/webhook";
import { resolveLocalLineSecret } from "./line/secrets";
import { POST as flows } from "../app/api/line/flows/route";
import { POST as exchange } from "../app/api/line/session/route";
import { POST as bind } from "../app/api/line/bind/route";
import { POST as reauth } from "../app/api/line/reauth/route";
import { POST as webhook } from "../app/api/line/webhook/route";
import { POST as entryProof } from "../app/(line)/v/liff/route";
import { GET as read, POST as report } from "../app/api/line/vendor-job/route";

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
const origin = "https://app.condola.app", secret = "b039-local-secret", pepper = "b039-local-pepper";
const hookSecret = "b039-webhook-secret", destination = "b039-local-bot";
const subA = `U${"c".repeat(32)}`, subB = `U${"d".repeat(32)}`, subForeign = `U${"e".repeat(32)}`;
const meta = { ua: "local-b039", ip: null };
const dispatchEnv = { LINE_PLATFORM_ENABLED: "true", LINE_PUSH_QUOTA_GUARD: "true" };
let db: Client, clone: Awaited<ReturnType<typeof cloneTestDatabase>>, channel: string, browser: string, csrf: string;
let admin: Session, foreignAdmin: Session, fetchCalls = 0, seq = 0;
const recipients = new Map<string, string>();
const previous = { ...process.env }, savedFetch = globalThis.fetch;

function jwt(sub: string) {
 const now = Math.floor(Date.now()/1000);
 const raw = [{ alg: "HS256" }, { iss: "https://access.line.me", aud: "b039-login", sub, iat: now-1, exp: now+300 }].map(v => Buffer.from(JSON.stringify(v)).toString("base64url")).join(".");
 return `${raw}.${createHmac("sha256",secret).update(raw).digest("base64url")}`;
}
function req(path: string, input?: Record<string, unknown>, opts: { claim?: string; session?: string; method?: string; bodyOnly?: boolean } = {}) {
 return new Request(origin+path, { method: opts.method ?? (input ? "POST" : "GET"), headers: { Origin: origin, "Content-Type": "application/json",
  Cookie: `${LINE_BROWSER_COOKIE}=${browser}; ${LINE_CSRF_COOKIE}=${csrf}${opts.claim ? `; ${LINE_JOB_COOKIE}=${opts.claim}` : ""}${opts.session ? `; condola_session=${opts.session}` : ""}` },
  ...(input ? { body: JSON.stringify(opts.bodyOnly ? input : { csrf, ...input }) } : {}) });
}
async function parsed(r: Response, status = 200) { assert.equal(r.status, status, await r.clone().text()); assert.ok(r.status < 500); return r.json(); }
const cookieValue = (r: Response, name: string) => new RegExp(`${name}=([^;,]+)`).exec(r.headers.get("set-cookie") ?? "")?.[1];
async function flag(key: string, value: unknown = true, orgValue: unknown = true, org = ORG_ID) {
 await db.query("INSERT INTO platform_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[key,JSON.stringify({ enabled: value, allowed_org_ids: [ORG_ID,ORG2_ID] })]);
 await db.query("UPDATE organizations SET feature_flags=feature_flags||jsonb_build_object($2::text,$3::jsonb) WHERE id=$1",[org,key,JSON.stringify(orgValue)]);
}
const lineTables = ["notifications","deliveries","app.b039_dispatch_events","app.b033_push_reservations","app.b033_push_fallbacks",
 "line_push_usage","app.b033_org_push_budgets","app.b028_delivery_attempts","app.b033_quota_alerts"];
async function snapshot(tables = lineTables) {
 const result: Record<string,unknown> = {};
 for (const table of tables) result[table] = (await db.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') data FROM ${table} t`)).rows[0].data;
 return result;
}
async function ticket(staff = admin) {
 const id = randomUUID();
 await db.query(`INSERT INTO maintenance_tickets(id,org_id,property_id,ticket_number,category,title,description,status)
  SELECT $1,$2,id,(SELECT coalesce(max(ticket_number),0)+1 FROM maintenance_tickets WHERE org_id=$2),'plumbing','PRIVATE INTERNAL TITLE','PRIVATE INTERNAL DESCRIPTION','open'
  FROM properties WHERE org_id=$2 AND archived_at IS NULL ORDER BY id LIMIT 1`,[id,staff.orgId]);
 return id;
}
type Job = { jobId: string; url: string; ticketId: string; contact: string; token: string };
async function withKill<T>(work: () => Promise<T>) { __setVendorLinkKillSwitchForTests(true); try { return await work(); } finally { __setVendorLinkKillSwitchForTests(false); } }
async function dispatchTo(ticketId: string, input: { vendorId?: string; window?: string } = {}, staff = admin): Promise<Job> {
 const job = await withKill(() => dispatchVendor(staff,ticketId,{ vendorId: input.vendorId, vendorName: input.vendorId ? "" : `B039-${randomUUID()}`,
  vendorPhone:"0912111222",vendorTrade:"plumbing",contactWindow: input.window ?? "Monday" },origin));
 const contact = (await db.query("SELECT vendor_contact_id FROM repair_vendor_jobs WHERE id=$1",[job.jobId])).rows[0].vendor_contact_id as string;
 await db.query("UPDATE contacts SET email=$2 WHERE id=$1",[contact,`vendor-${contact.slice(0,8)}@local.test`]);
 return { ...job, ticketId, contact, token: new URL(job.url).pathname.slice(3) };
}
const share = (job: Job, staff = admin) => withKill(() => approveVendorSharing(staff,job.ticketId,job.jobId,{ description:"Approved scoped repair",attachmentIds:[] }));
const revokeJob = (job: Job, staff = admin) => withKill(() => revokeVendorJob(staff,job.ticketId,job.jobId));
async function friend(userId: string, type: "follow" | "unfollow", org = ORG_ID) {
 const raw = JSON.stringify({ destination, events: [{ webhookEventId: randomUUID(), type, timestamp: Date.now() + (seq++), source: { userId } }] });
 const response = await webhook(new Request(`${origin}/api/line/webhook?org=${org}&channel=${channel}`, { method: "POST",
  headers: { "x-line-signature": createHmac("sha256", hookSecret).update(raw).digest("base64") }, body: raw }));
 assert.equal(response.status, 200);
}
async function bindVendor(job: Job, user: string, sub: string, org = ORG_ID, staff = admin) {
 await flag("vendor_account",true,true,org);
 const email = await createSession(user,false,meta);
 const invitation = await inviteVendorAccount(staff,job.contact,user); assert.ok(invitation.invitation);
 await claimVendorAccount(email,invitation.invitation);
 await parsed(await reauth(req("/api/line/reauth",{orgId:org,persona:"vendor",password:DEMO_PASSWORD},{session:email})));
 const f = await parsed(await flows(req("/api/line/flows",{purpose:"bind",contactId:job.contact,orgId:org,persona:"vendor"},{session:email})),201);
 const result = await parsed(await bind(req("/api/line/bind",{flow:f.flow,idToken:jwt(sub),consentTextKey:"line.binding.v1"},{session:email})));
 recipients.set(result.linkId, sub); await friend(sub, "follow", org);
 return { email, linkId: result.linkId as string };
}
function transportFor(mode: PushOutcome["status"]) { return createCapturedLineTransport({ mode }); }
const run = (transport: Pick<LineTransport,"push">, org = ORG_ID, env: Record<string,string|undefined> = dispatchEnv) =>
 runVendorDispatchPushes(org, { transport, origin, env, resolveRecipient: async ({ linkId }) => recipients.has(linkId) ? { to: recipients.get(linkId)!, identityPepper: pepper } : null });
const pushes = (t: ReturnType<typeof transportFor>) => t.calls.flatMap(c => c.method === "push" ? [c.request] : []);
const linkIn = (text: string) => /https:\/\/app\.condola\.app\/v\/([A-Za-z0-9_-]+)/.exec(text)?.[1];
async function events(org = ORG_ID) { return (await db.query("SELECT kind,status,reason,job_id FROM app.b039_dispatch_events WHERE org_id=$1 ORDER BY created_at",[org])).rows; }
async function usage(pushed: number) {
 await db.query(`INSERT INTO line_push_usage(line_channel_id,period_month,pushed_count) VALUES($1,date_trunc('month',now() AT TIME ZONE 'Asia/Taipei')::date,$2)
  ON CONFLICT(line_channel_id,period_month) DO UPDATE SET pushed_count=$2`,[channel,pushed]);
}
async function fallbackRows(notification: string) {
 return (await db.query("SELECT channel,status,error,counts_toward_quota FROM deliveries WHERE notification_id=$1 AND b033_claim_id IS NOT NULL ORDER BY channel",[notification])).rows;
}
async function claimFrom(token: string) {
 const proof = await entryProof(req("/v/liff",{jobToken:token},{bodyOnly:true}));
 if (proof.status !== 200) return { status: proof.status };
 const f = await parsed(await flows(req("/api/line/flows",{purpose:"login",persona:"vendor",orgId:ORG_ID,jobToken:token})),201);
 const response = await exchange(req("/api/line/session",{flow:f.flow,idToken:jwt(subA)}));
 await parsed(response); return { status: 200, credential: cookieValue(response,LINE_JOB_COOKIE)! };
}
/** Evidence under e2e/results/B-039/ is written only with B039_WRITE_EVIDENCE=1; LINE ids and job tokens are redacted. */
const evidence: Record<string, unknown[]> = {};
function record(file: string, entry: unknown) { (evidence[file] ??= []).push(entry); }
function redact(value: unknown, tokens: string[] = []) {
 let text = JSON.stringify(value);
 for (const token of tokens) text = text.replaceAll(token, "<job-token>");
 return JSON.parse(text.replace(/U[0-9a-f]{32}/g, "<line-user>").replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>"));
}
const due = () => db.query("UPDATE app.b039_dispatch_events SET next_attempt_at=clock_timestamp() WHERE status='pending'");
/** Fails app.open_vendor_job (used only by the authorize recheck) with a synthetic 57014 for the given job hashes. */
async function injectAuthorizeTimeout(hashes: string[]) {
 const original = (await db.query("SELECT pg_get_functiondef('app.open_vendor_job(text)'::regprocedure) def")).rows[0].def as string;
 await db.query(original.replace("app.open_vendor_job(", "app.b039_probe_open_vendor_job("));
 await db.query("CREATE TABLE app.b039_probe_fail(token_hash text PRIMARY KEY)");
 await db.query("INSERT INTO app.b039_probe_fail SELECT unnest($1::text[])",[hashes]);
 await db.query(`CREATE OR REPLACE FUNCTION app.open_vendor_job(p_token_hash text) RETURNS TABLE(job_id uuid, org_id uuid, ticket_id uuid,
  vendor_name text, contact_window text, expires_at timestamptz, reported_at timestamptz, reported_cost_minor bigint)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $f$ BEGIN
  IF EXISTS(SELECT 1 FROM app.b039_probe_fail f WHERE f.token_hash=p_token_hash) THEN RAISE EXCEPTION 'synthetic statement timeout' USING ERRCODE='57014'; END IF;
  RETURN QUERY SELECT * FROM app.b039_probe_open_vendor_job(p_token_hash); END $f$`);
 return async () => { await db.query(original); await db.query("DROP FUNCTION app.b039_probe_open_vendor_job(text)"); await db.query("DROP TABLE app.b039_probe_fail"); };
}
/** A dispatched, bound, friended and shared job for vendor A, i.e. one pending `assigned` event. */
async function assignedA() { const j = await dispatchTo(await ticket()); const b = await bindVendor(j,USERS.tenant,subA); await share(j); return { j, b }; }

test.before(async () => { clone = await cloneTestDatabase(); db = new Client({connectionString:process.env.DATABASE_URL}); await db.connect();
 globalThis.fetch = async () => { fetchCalls++; throw new Error("B039 network forbidden"); }; });
test.beforeEach(async () => {
 process.env.DEMO_MODE="true"; process.env.ID_DOC_ENCRYPTION_KEY=randomBytes(32).toString("hex"); await resetAndSeed(); process.env.DEMO_MODE="false";
 process.env.LINE_PLATFORM_ENABLED="true"; browser=randomProof(); csrf=randomProof(); recipients.clear();
 for (const org of [ORG_ID,ORG2_ID]) {
  for (const key of ["line_platform","line_vendor_portal","line_tenant_portal","line_owner_portal","line_push","notification_delivery_v2","line_dispatch_push"]) await flag(key,true,true,org);
  await db.query("UPDATE organizations SET feature_flags=feature_flags||'{\"vendor_dispatch\":true,\"vendor_link\":true}' WHERE id=$1",[org]);
 }
 channel=(await db.query("SELECT id FROM line_channels WHERE mode='platform_default' AND is_active")).rows[0].id;
 await db.query("SELECT app.b033_liff_configure($1,'local-tenant','local-vendor','local-owner')",[channel]);
 await db.query("UPDATE line_channels SET login_channel_id='b039-login',login_channel_secret_ref='b039-local' WHERE id=$1",[channel]);
 await db.query("SELECT app.b033_channel_verify($1)",[channel]);
 const ref = (await db.query("SELECT messaging_channel_secret_ref FROM line_channels WHERE id=$1",[channel])).rows[0].messaging_channel_secret_ref;
 process.env.LINE_CHANNEL_SECRETS=JSON.stringify({ "b039-local": { secret, identityPepper: pepper, destination }, [ref]: { secret: hookSecret, identityPepper: pepper, destination } });
 for (const org of [ORG_ID,ORG2_ID]) await db.query("SELECT app.b033_org_budget_set($1,$2,date_trunc('month',now() AT TIME ZONE 'Asia/Taipei')::date,180)",[channel,org]);
 const staff = async (user:string,org:string):Promise<Session> => {
  const token=await createSession(user,false,meta); const sid=(await db.query("SELECT id FROM auth_sessions WHERE token_hash=$1",[lineHash(token)])).rows[0].id;
  return {userId:user,sessionId:sid,orgId:org,liveOrgId:org,kind:"staff",role:"admin",environment:"live",locale:"zh-TW",calendar:"gregorian",email:"local@example.test",name:"Local",leaseId:null};
 };
 admin=await staff(USERS.admin,ORG_ID); foreignAdmin=await staff(USERS.coastAdmin,ORG2_ID);
});
test.afterEach(() => assert.equal(fetchCalls, 0, "no network call is permitted"));
test.after(async () => {
 if (process.env.B039_WRITE_EVIDENCE === "1") {
  mkdirSync("e2e/results/B-039", { recursive: true });
  for (const [file, entries] of Object.entries(evidence)) writeFileSync(`e2e/results/B-039/${file}`, JSON.stringify(entries, null, 1) + "\n");
 }
 globalThis.fetch=savedFetch; __setVendorLinkKillSwitchForTests(false); await db?.end(); await clone?.cleanup();
 for (const key of ["DEMO_MODE","ID_DOC_ENCRYPTION_KEY","LINE_PLATFORM_ENABLED","LINE_CHANNEL_SECRETS"]) { if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key]; } });

for (const locale of ["zh-TW","en"] as const) test(`${locale}: committed assignment pushes only to the current vendor with a job-scoped LIFF link that opens only that job`, async () => {
 const j = await dispatchTo(await ticket()); await db.query("UPDATE contacts SET locale=$2 WHERE id=$1",[j.contact,locale]);
 await bindVendor(j,USERS.tenant,subA); const other = await dispatchTo(await ticket());
 assert.deepEqual(await events(), []); // dispatch alone is not openable through the B-035 scope
 await share(j);
 const notification = (await db.query("SELECT * FROM notifications WHERE event_type='dispatch_assigned'")).rows;
 assert.equal(notification.length,1); assert.equal(notification[0].lease_id,null); assert.equal(notification[0].recipient_contact_id,j.contact);
 assert.equal(notification[0].related_id,j.jobId); assert.deepEqual(notification[0].payload,{}); assert.equal(notification[0].locale,locale);
 const t = transportFor("accepted"), results = await run(t);
 assert.deepEqual(results.map(r => [r.kind,r.status]),[["assigned","sent"]]);
 const [push] = pushes(t); assert.equal(pushes(t).length,1); assert.equal(push.to,subA);
 const claim = (await db.query("SELECT claim_id FROM app.b039_dispatch_events")).rows[0].claim_id;
 assert.equal(push.headers["X-Line-Retry-Key"],claim);
 assert.deepEqual(push.messages, vendorDispatchMessages("assigned",locale,`${origin}/v/${j.token}`));
 assert.match(push.messages[0].text, locale === "en" ? /^Condola: You have a new repair job/ : /^【Condola】您有一件新的維修工作/);
 for (const leak of ["PRIVATE",other.token,"0912111222",subA]) assert.ok(!push.messages[0].text.includes(leak));
 assert.equal(linkIn(push.messages[0].text),j.token);
 record("dispatch-payloads.json", redact({ locale, kind: "assigned", push }, [j.token]));
 assert.deepEqual(await fallbackRows(notification[0].id),[{channel:"line",status:"sent",error:null,counts_toward_quota:true}]);
 assert.deepEqual((await db.query("SELECT pushed_count,reserved_count FROM line_push_usage")).rows,[{pushed_count:1,reserved_count:0}]);
 assert.equal((await db.query("SELECT status FROM notifications WHERE id=$1",[notification[0].id])).rows[0].status,"succeeded");
 // The pushed link is the job capability; B-035 opens exactly this job.
 const opened = await claimFrom(linkIn(push.messages[0].text)!); assert.equal(opened.status,200);
 const view = await parsed(await read(req("/api/line/vendor-job",undefined,{claim:opened.credential})));
 assert.equal(view.description,"Approved scoped repair");
 await parsed(await read(req(`/api/line/vendor-job?jobId=${other.jobId}`,undefined,{claim:opened.credential})),404);
 const before = await snapshot(); assert.deepEqual(await run(t),[]); assert.equal(pushes(t).length,1); assert.deepEqual(await snapshot(),before);
 await share(j); assert.equal((await events()).length,1); // re-approval never re-notifies
});

for (const mode of ["redispatch","reassigned","revoked","sharing","archived"] as const) test(`assignment/authority change before claim (${mode}) supersedes with zero push, reservation or Email`, async () => {
 const { j } = await assignedA();
 if (mode === "redispatch") await dispatchTo(j.ticketId);
 if (mode === "reassigned") await db.query("UPDATE maintenance_tickets SET assigned_vendor_contact_id=NULL WHERE id=$1",[j.ticketId]);
 if (mode === "revoked") await db.query("UPDATE repair_vendor_jobs SET active=false,revoked_at=now() WHERE id=$1",[j.jobId]);
 if (mode === "sharing") await db.query("UPDATE repair_vendor_jobs SET sharing_approved_at=NULL WHERE id=$1",[j.jobId]);
 if (mode === "archived") await db.query("UPDATE contacts SET archived_at=now() WHERE id=$1",[j.contact]);
 const tables = ["app.b033_push_reservations","app.b033_push_fallbacks","deliveries","line_push_usage","app.b028_delivery_attempts"], before = await snapshot(tables);
 const t = transportFor("accepted"), results = await run(t);
 assert.deepEqual(results.map(r => [r.kind,r.status]),[["assigned","superseded"]]);
 assert.equal(pushes(t).length,0); assert.deepEqual(await snapshot(tables),before);
 assert.deepEqual((await events()).map(e => [e.kind,e.status,e.reason]),[["assigned","superseded","stale_authority"]]);
 assert.equal((await db.query("SELECT status FROM notifications WHERE event_type='dispatch_assigned'")).rows[0].status,"cancelled");
});

test("reassignment to another vendor: only the new current assignee is pushed, with its own link; the old link is denied", async () => {
 const { j } = await assignedA(), first = transportFor("accepted"); await run(first);
 const oldLink = linkIn(pushes(first)[0].messages[0].text)!, held = await claimFrom(oldLink); assert.equal(held.status,200);
 const next = await dispatchTo(j.ticketId); await bindVendor(next,USERS.tenant2,subB); await share(next);
 const t = transportFor("accepted"), results = await run(t);
 assert.deepEqual(results.map(r => [r.kind,r.status]),[["assigned","sent"]]);
 assert.deepEqual(pushes(t).map(p => p.to),[subB]); assert.equal(linkIn(pushes(t)[0].messages[0].text),next.token);
 assert.ok(!pushes(t).some(p => p.to === subA)); // no LINE cancel to a vendor who is no longer assigned
 // Old recipient opens the previously pushed link: denied at entry, at flow creation, and for a claim taken earlier.
 const before = await snapshot();
 assert.deepEqual(await parsed(await entryProof(req("/v/liff",{jobToken:oldLink},{bodyOnly:true})),404),{error:"not_found"});
 assert.deepEqual(await parsed(await flows(req("/api/line/flows",{purpose:"login",persona:"vendor",orgId:ORG_ID,jobToken:oldLink})),404),{error:"not_found"});
 assert.deepEqual(await parsed(await read(req("/api/line/vendor-job",undefined,{claim:held.credential})),404),{error:"not_found"});
 assert.deepEqual(await parsed(await report(req("/api/line/vendor-job",{done:"true",cost:"100"},{claim:held.credential})),404),{error:"not_found"});
 assert.deepEqual(await snapshot(),before);
});

test("revoke pushes a link-free cancellation to the still-assigned vendor and the old link is denied", async () => {
 const { j } = await assignedA(), first = transportFor("accepted"); await run(first);
 const oldLink = linkIn(pushes(first)[0].messages[0].text)!;
 await revokeJob(j);
 const t = transportFor("accepted"), results = await run(t);
 assert.deepEqual(results.map(r => [r.kind,r.status]),[["cancelled","sent"]]);
 const [cancel] = pushes(t); assert.equal(cancel.to,subA); assert.equal(linkIn(cancel.messages[0].text),undefined);
 assert.deepEqual(cancel.messages, vendorDispatchMessages("cancelled","zh-TW",null));
 record("dispatch-payloads.json", redact({ locale: "zh-TW", kind: "cancelled", push: cancel }));
 assert.equal((await claimFrom(oldLink)).status,404);
 await revokeJob(j).catch(() => undefined); assert.equal((await events()).filter(e => e.kind === "cancelled").length,1);
 // A never-notified job's revoke produces no cancellation.
 const silent = await dispatchTo(await ticket()); await revokeJob(silent); assert.equal((await events()).length,2);
});

test("same-vendor re-dispatch sends a rescheduled push with the new link while the old link is denied", async () => {
 const { j } = await assignedA(), first = transportFor("accepted"); await run(first);
 const again = await dispatchTo(j.ticketId,{ vendorId: j.contact, window: "Thursday afternoon" });
 assert.equal(again.contact,j.contact); await share(again);
 const t = transportFor("accepted"), results = await run(t);
 assert.deepEqual(results.map(r => [r.kind,r.status]),[["rescheduled","sent"]]);
 const [push] = pushes(t); assert.equal(push.to,subA); assert.equal(linkIn(push.messages[0].text),again.token);
 assert.deepEqual(push.messages, vendorDispatchMessages("rescheduled","zh-TW",`${origin}/v/${again.token}`));
 record("dispatch-payloads.json", redact({ locale: "zh-TW", kind: "rescheduled", push }, [again.token]));
 assert.equal((await claimFrom(j.token)).status,404); assert.equal((await claimFrom(again.token)).status,200);
});

test("timeout retries reuse the claim, X-Line-Retry-Key and reservation, then settle exactly once", async () => {
 await assignedA();
 const timeout = transportFor("timeout"), first = await run(timeout);
 assert.ok((await db.query("SELECT next_attempt_at>clock_timestamp() later FROM app.b039_dispatch_events")).rows[0].later); // unknown is backed off
 assert.deepEqual(await run(transportFor("accepted")),[]); await due();
 assert.deepEqual(first.map(r => [r.kind,r.status]),[["assigned","unknown"]]);
 assert.deepEqual((await db.query("SELECT status,attempt_count FROM app.b033_push_reservations")).rows,[{status:"unknown",attempt_count:1}]);
 assert.deepEqual((await db.query("SELECT pushed_count,reserved_count FROM line_push_usage")).rows,[{pushed_count:0,reserved_count:1}]);
 const duplicate = transportFor("duplicateAccepted"), second = await run(duplicate);
 assert.deepEqual(second.map(r => [r.kind,r.status]),[["assigned","sent"]]);
 assert.equal(pushes(timeout)[0].headers["X-Line-Retry-Key"],pushes(duplicate)[0].headers["X-Line-Retry-Key"]);
 assert.deepEqual((await db.query("SELECT status,attempt_count FROM app.b033_push_reservations")).rows,[{status:"settled",attempt_count:2}]);
 assert.deepEqual((await db.query("SELECT pushed_count,reserved_count FROM line_push_usage")).rows,[{pushed_count:1,reserved_count:0}]);
 assert.equal((await db.query("SELECT count(*)::int n FROM app.b028_delivery_attempts")).rows[0].n,0);
 const t = transportFor("accepted"); assert.deepEqual(await run(t),[]); assert.equal(t.calls.length,0);
});

test("quota-full skips LINE with line_quota and queues exactly one deduplicated Email; replay adds nothing", async () => {
 await assignedA(); await usage(180);
 const t = transportFor("accepted"), results = await run(t);
 assert.deepEqual(results.map(r => [r.kind,r.status,r.reason]),[["assigned","fallback","line_quota"]]);
 assert.equal(t.calls.length,0);
 const n = (await db.query("SELECT notification_id FROM app.b039_dispatch_events")).rows[0].notification_id;
 assert.deepEqual(await fallbackRows(n),[{channel:"email",status:"queued",error:"line_quota",counts_toward_quota:false},{channel:"line",status:"skipped",error:"line_quota",counts_toward_quota:false}]);
 assert.equal((await db.query("SELECT count(*)::int n FROM app.b028_delivery_attempts WHERE source_id=$1 AND channel='email'",[n])).rows[0].n,1);
 assert.equal((await db.query("SELECT count(*)::int n FROM app.b033_quota_alerts")).rows[0].n,1);
 const before = await snapshot(); assert.deepEqual(await run(t),[]); assert.deepEqual(await snapshot(),before);
});

for (const mode of ["unfollow","failed","unlinked"] as const) test(`${mode} follows the shared Email fallback policy with its reason`, async () => {
 const j = await dispatchTo(await ticket()), b = await bindVendor(j,USERS.tenant,subA);
 if (mode === "unfollow") await friend(subA,"unfollow");
 if (mode === "unlinked") await db.query("UPDATE line_account_links SET status='unlinked',unlinked_at=now(),notification_opt_in=false WHERE id=$1",[b.linkId]);
 await share(j);
 const t = transportFor(mode === "failed" ? "failed" : "accepted"), results = await run(t);
 const reason = mode === "failed" ? "line_failed" : "line_guard";
 assert.deepEqual(results.map(r => [r.kind,r.status,r.reason]),[["assigned","fallback",reason]]);
 assert.equal(pushes(t).length, mode === "failed" ? 1 : 0);
 const n = (await db.query("SELECT notification_id FROM app.b039_dispatch_events")).rows[0].notification_id;
 assert.deepEqual(await fallbackRows(n),[{channel:"email",status:"queued",error:reason,counts_toward_quota:false},
  {channel:"line",status:mode === "failed" ? "failed" : "skipped",error:reason,counts_toward_quota:false}]);
 assert.deepEqual((await db.query("SELECT pushed_count,reserved_count FROM line_push_usage")).rows, mode === "failed" ? [{pushed_count:0,reserved_count:0}] : []);
 const before = await snapshot(); assert.deepEqual(await run(t),[]); assert.deepEqual(await snapshot(),before);
});

test("full quota: message/postback still replies through the Reply API with its token and never pushes or falls back", async () => {
 await assignedA(); await usage(180);
 const pushAttempts: unknown[] = [], captured = transportFor("accepted");
 const transport = { reply: captured.reply.bind(captured), push: async (r: unknown) => { pushAttempts.push(r); throw new Error("push forbidden in webhook"); } };
 const post = createWebhookPost({ resolveSecret: resolveLocalLineSecret, transport, env: dispatchEnv, replyMessages: () => [{ type: "text", text: "local ack" }] });
 const raw = JSON.stringify({ destination, events: [
  { webhookEventId: randomUUID(), type: "message", timestamp: Date.now(), source: { userId: subA }, replyToken: "reply-message" },
  { webhookEventId: randomUUID(), type: "postback", timestamp: Date.now(), source: { userId: subA }, replyToken: "reply-postback" }] });
 const before = await snapshot();
 const response = await post(new Request(`${origin}/api/line/webhook?org=${ORG_ID}&channel=${channel}`, { method: "POST",
  headers: { "x-line-signature": createHmac("sha256", hookSecret).update(raw).digest("base64") }, body: raw }));
 assert.equal(response.status,200);
 assert.deepEqual(captured.calls.map(c => c.method === "reply" ? c.replyToken : "push"),["reply-message","reply-postback"]);
 assert.equal(pushAttempts.length,0); assert.deepEqual(await snapshot(),before);
 assert.deepEqual((await db.query("SELECT pushed_count,reserved_count FROM line_push_usage")).rows,[{pushed_count:180,reserved_count:0}]);
});

const offGates: Array<[string, () => Promise<void>, Record<string,string>?]> = [
 ["environment", async () => { process.env.LINE_PLATFORM_ENABLED = "false"; }, { LINE_PLATFORM_ENABLED: "false", LINE_PUSH_QUOTA_GUARD: "true" }],
 ["line_platform", () => flag("line_platform",false)], ["line_push", () => flag("line_push",true,false)],
 ["notification_delivery_v2", () => flag("notification_delivery_v2",false)], ["line_vendor_portal", () => flag("line_vendor_portal",true,false)],
 ["dispatch platform false", () => flag("line_dispatch_push",false)], ["dispatch platform malformed", () => flag("line_dispatch_push","true")],
 ["dispatch org false", () => flag("line_dispatch_push",true,false)], ["dispatch org malformed", () => flag("line_dispatch_push",true,"true")],
 ["dispatch org missing", async () => { await db.query("UPDATE organizations SET feature_flags=feature_flags-'line_dispatch_push' WHERE id=$1",[ORG_ID]); }],
 ["dispatch setting missing", async () => { await db.query("DELETE FROM platform_settings WHERE key='line_dispatch_push'"); }],
 ["dispatch empty allowlist", async () => { await db.query("UPDATE platform_settings SET value='{\"enabled\":true,\"allowed_org_ids\":[]}' WHERE key='line_dispatch_push'"); }],
];
for (const [name, off, env] of offGates) test(`OFF (${name}) writes nothing and leaves existing dispatch, sharing and revoke unchanged`, async () => {
 let writes = -1;
 const notified = await assignedA(); const j = await dispatchTo(await ticket()); await bindVendor(j,USERS.tenant2,subB);
 await off(); const before = await snapshot();
 await share(j); await revokeJob(notified.j);
 const t = transportFor("accepted"); assert.deepEqual(await run(t,ORG_ID,env ?? dispatchEnv),[]);
 assert.equal(t.calls.length,0); assert.deepEqual(await snapshot(),before); writes = 0;
 record("off-matrix.json", { gate: name, lineWrites: writes, pushes: t.calls.length, dispatchSharedAndRevoked: true });
 const jobs = (await db.query("SELECT id,sharing_approved_at IS NOT NULL shared,revoked_at IS NOT NULL revoked FROM repair_vendor_jobs WHERE id=ANY($1) ORDER BY id",[[j.jobId,notified.j.jobId]])).rows;
 assert.deepEqual(Object.fromEntries(jobs.map(r => [r.id,[r.shared,r.revoked]])),{[j.jobId]:[true,false],[notified.j.jobId]:[false,true]});
});

test("cross-organization: foreign jobs, tickets, claims and active-org scope never produce or move events; privileges are service-only", async () => {
 const foreign = await dispatchTo(await ticket(foreignAdmin),{},foreignAdmin); await bindVendor(foreign,USERS.tenant2,subForeign,ORG2_ID,foreignAdmin); await share(foreign,foreignAdmin);
 const { j } = await assignedA(); const before = await snapshot();
 for (const [org,ticketId,jobId] of [[ORG_ID,foreign.ticketId,foreign.jobId],[ORG_ID,j.ticketId,foreign.jobId],[ORG2_ID,j.ticketId,j.jobId]])
  assert.equal((await db.query("SELECT app.b039_dispatch_event_record($1,$2,$3,'shared') id",[org,ticketId,jobId])).rows[0].id,null);
 await db.query("BEGIN"); await db.query("SELECT set_config('app.active_org_id',$1,true)",[ORG2_ID]);
 assert.equal((await db.query("SELECT app.b039_dispatch_push_enabled($1) ok",[ORG_ID])).rows[0].ok,false);
 const own = (await db.query("SELECT notification_id,claim_id FROM app.b039_dispatch_events WHERE org_id=$1",[ORG_ID])).rows[0];
 assert.equal((await db.query("SELECT app.b039_dispatch_finish($1,$2,'sent',NULL) ok",[own.notification_id,own.claim_id])).rows[0].ok,false);
 await db.query("ROLLBACK");
 assert.equal((await db.query("SELECT app.b039_dispatch_finish($1,$2,'sent',NULL) ok",[own.notification_id,randomUUID()])).rows[0].ok,false);
 assert.deepEqual(await snapshot(),before);
 const t = transportFor("accepted"), results = await run(t);
 assert.deepEqual(results.map(r => r.kind+":"+r.status),["assigned:sent"]); assert.deepEqual(pushes(t).map(p => p.to),[subA]);
 assert.deepEqual((await events(ORG2_ID)).map(e => e.status),["pending"]);
 const foreignRun = transportFor("accepted"); await run(foreignRun,ORG2_ID);
 assert.deepEqual(pushes(foreignRun).map(p => p.to),[subForeign]); assert.equal(linkIn(pushes(foreignRun)[0].messages[0].text),foreign.token);
 await assert.rejects(db.query(`INSERT INTO notifications(org_id,event_type,template_key,recipient_contact_id,locale,lease_id,related_table,related_id)
  SELECT $1,'dispatch_assigned','line_dispatch_assigned',$2,'zh-TW',id,'repair_vendor_jobs',$3 FROM leases WHERE org_id=$1 LIMIT 1`,[ORG_ID,j.contact,j.jobId]),/notifications_b039_vendor_dispatch_ck/);
 assert.equal((await db.query("SELECT relrowsecurity FROM pg_class WHERE oid='app.b039_dispatch_events'::regclass")).rows[0].relrowsecurity,true);
 for (const role of ["anon","authenticated"]) assert.equal((await db.query("SELECT has_table_privilege($1,'app.b039_dispatch_events','SELECT,INSERT,UPDATE,DELETE') ok",[role])).rows[0].ok,false);
 for (const privilege of ["INSERT","UPDATE","DELETE"]) assert.equal((await db.query("SELECT has_table_privilege('service_role','app.b039_dispatch_events',$1) ok",[privilege])).rows[0].ok,false);
 for (const fn of ["app.b039_dispatch_push_enabled(uuid)","app.b039_dispatch_event_record(uuid,uuid,uuid,text)","app.b039_dispatch_finish(uuid,uuid,text,text)",
  "app.b039_dispatch_backoff(uuid,uuid)","app.b039_dispatch_no_channel(uuid,uuid)","app.b039_dispatch_close_stale(uuid,uuid)","app.b039_dispatch_replay(app.b039_dispatch_events,text)"]) {
  const internal = fn.includes("_replay(");
  for (const role of ["anon","authenticated","service_role"]) assert.equal((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') ok",[role,fn])).rows[0].ok,role==="service_role" && !internal,`${role} ${fn}`);
  const config = (await db.query("SELECT proconfig,prosecdef FROM pg_proc WHERE oid=$1::regprocedure",[fn])).rows[0];
  assert.equal(config.prosecdef,true); assert.ok(config.proconfig.includes("search_path=pg_catalog, public, app, pg_temp"));
 }
 assert.deepEqual((await db.query("SELECT value FROM platform_settings WHERE key='line_dispatch_push'")).rows.length,1);
});

test("migration seeds line_dispatch_push OFF with an empty allowlist and no forbidden copy", () => {
 const sql = readFileSync(new URL("../../supabase/migrations/20261107105000_b039_line_dispatch_pushes.sql", import.meta.url), "utf8");
 assert.match(sql, /\('line_dispatch_push','\{"enabled":false,"allowed_org_ids":\[\]\}'::jsonb\)\nON CONFLICT \(key\) DO NOTHING/);
 for (const banned of ["房東","收款","收租","入帳","已收","統一編號"]) assert.ok(!sql.includes(banned));
});

test("share then revoke before the worker runs: the assignment is superseded and the cancellation closes silently", async () => {
 const { j } = await assignedA(); await revokeJob(j);
 const before = await snapshot(["app.b033_push_reservations","app.b033_push_fallbacks","deliveries","line_push_usage","app.b028_delivery_attempts"]);
 const t = transportFor("accepted"), results = await run(t);
 assert.deepEqual(results.map(r => [r.kind,r.status,r.reason]),[["assigned","superseded","stale_authority"],["cancelled","superseded","never_announced"]]);
 assert.equal(t.calls.length,0);
 assert.deepEqual(await snapshot(["app.b033_push_reservations","app.b033_push_fallbacks","deliveries","line_push_usage","app.b028_delivery_attempts"]),before);
 // Revoking a job whose announcement was already superseded records nothing at all.
 const again = await dispatchTo(await ticket()); await bindVendor(again,USERS.tenant2,subB); await share(again);
 await db.query("UPDATE repair_vendor_jobs SET sharing_approved_at=NULL WHERE id=$1",[again.jobId]); await run(t);
 await share(again); await revokeJob(again);
 assert.equal((await db.query("SELECT count(*)::int n FROM app.b039_dispatch_events WHERE job_id=$1 AND kind='cancelled'",[again.jobId])).rows[0].n,0);
});

test("a reschedule whose previous announcement never went out is delivered as the first assignment notice", async () => {
 const { j } = await assignedA();
 const again = await dispatchTo(j.ticketId,{ vendorId: j.contact, window: "Friday" }); await share(again);
 assert.deepEqual((await events()).map(e => e.kind),["assigned","rescheduled"]);
 const t = transportFor("accepted"), results = await run(t);
 assert.deepEqual(results.map(r => [r.kind,r.status,r.reason]),[["assigned","superseded","stale_authority"],["rescheduled","sent","announced_as_assigned"]]);
 assert.deepEqual(pushes(t).map(p => p.messages),[vendorDispatchMessages("assigned","zh-TW",`${origin}/v/${again.token}`)]);
});

test("a reschedule/cancellation waits while its announcement is pending (deferred, no writes)", async () => {
 const { j } = await assignedA(); const timeout = transportFor("timeout"); await run(timeout);
 await revokeJob(j); const cancel = (await db.query("SELECT notification_id FROM app.b039_dispatch_events WHERE kind='cancelled'")).rows[0].notification_id;
 // Hold the announcement pending by backing it off, then run: the cancellation must defer.
 await db.query("UPDATE app.b039_dispatch_events SET next_attempt_at=now()+interval '1 hour' WHERE kind='assigned'");
 const before = await snapshot(), t = transportFor("accepted"), results = await run(t);
 assert.deepEqual(results.map(r => [r.kind,r.status]),[["cancelled","deferred"]]); assert.equal(t.calls.length,0); assert.deepEqual(await snapshot(),before);
 assert.equal((await db.query("SELECT status FROM app.b039_dispatch_events WHERE notification_id=$1",[cancel])).rows[0].status,"pending");
});

test("synthetic 57014 inside re-authorization: no LINE, no Email, backed off and retried later; other rows still flow", async () => {
 const first = await assignedA(), second = await dispatchTo(await ticket()); await bindVendor(second,USERS.tenant2,subB); await share(second);
 const restore = await injectAuthorizeTimeout([hashVendorToken(first.j.token)]);
 const tables = ["app.b033_push_reservations","app.b033_push_fallbacks","deliveries","app.b028_delivery_attempts"];
 try {
  const before = await snapshot(tables), t = transportFor("accepted"), results = await run(t);
  assert.deepEqual(results.map(r => [r.kind,r.status]),[["assigned","retry"],["assigned","sent"]]);
  assert.deepEqual(pushes(t).map(p => p.to),[subB]); // the failing row did not block the queue
  const after = await snapshot(tables);
  for (const table of tables) assert.equal((after[table] as unknown[]).filter(r => JSON.stringify(r).includes(first.j.contact)).length,
   (before[table] as unknown[]).filter(r => JSON.stringify(r).includes(first.j.contact)).length, table);
  const row = (await db.query("SELECT status,attempts,next_attempt_at>clock_timestamp() later FROM app.b039_dispatch_events WHERE job_id=$1",[first.j.jobId])).rows[0];
  assert.deepEqual(row,{ status: "pending", attempts: 1, later: true });
  assert.deepEqual(await run(transportFor("accepted")),[]); // not yet due
 } finally { await restore(); }
 await due(); const t = transportFor("accepted");
 assert.deepEqual((await run(t)).map(r => [r.kind,r.status]),[["assigned","sent"]]); assert.deepEqual(pushes(t).map(p => p.to),[subA]);
});

test("no selected OA while enabled: exactly one Email fallback with reason line_unavailable, never pending forever", async () => {
 await assignedA(); await db.query("UPDATE line_channels SET is_active=false");
 const t = transportFor("accepted"), results = await run(t);
 assert.deepEqual(results.map(r => [r.kind,r.status,r.reason]),[["assigned","fallback","line_unavailable"]]); assert.equal(t.calls.length,0);
 const n = (await db.query("SELECT notification_id FROM app.b039_dispatch_events")).rows[0].notification_id;
 assert.deepEqual((await db.query("SELECT channel,status,error FROM deliveries WHERE notification_id=$1",[n])).rows,[{channel:"email",status:"queued",error:"line_unavailable"}]);
 assert.equal((await db.query("SELECT count(*)::int n FROM app.b028_delivery_attempts WHERE source_id=$1",[n])).rows[0].n,1);
 const before = await snapshot(); assert.deepEqual(await run(t),[]); assert.deepEqual(await snapshot(),before);
});

test("revoke in the decision-commit to provider gap: the push goes out, the link is still denied, and the cancellation follows", async () => {
 const { j } = await assignedA(); const captured = transportFor("accepted");
 const racing = { push: async (request: Parameters<typeof captured.push>[0]) => { await revokeJob(j); return captured.push(request); } };
 assert.deepEqual((await run(racing)).map(r => [r.kind,r.status]),[["assigned","sent"]]);
 // Accepted residual risk: authority is rechecked at the decision commit, then again by B-035 whenever the link opens.
 assert.equal((await claimFrom(j.token)).status,404);
 const t = transportFor("accepted"); assert.deepEqual((await run(t)).map(r => [r.kind,r.status]),[["cancelled","sent"]]);
 assert.equal(pushes(t)[0].to,subA);
});

test("archived vendor contact before claim supersedes the cancellation", async () => {
 const { j } = await assignedA(); await run(transportFor("accepted")); await revokeJob(j);
 await db.query("UPDATE contacts SET archived_at=now() WHERE id=$1",[j.contact]);
 const t = transportFor("accepted"); assert.deepEqual((await run(t)).map(r => [r.kind,r.status,r.reason]),[["cancelled","superseded","stale_authority"]]);
 assert.equal(t.calls.length,0);
});

test("concurrent workers deliver one push, settle once and finish once", async () => {
 await assignedA(); const a = transportFor("accepted"), b = transportFor("accepted");
 await Promise.all([run(a), run(b)]);
 assert.equal(pushes(a).length + pushes(b).length,1);
 assert.deepEqual((await db.query("SELECT pushed_count,reserved_count FROM line_push_usage")).rows,[{pushed_count:1,reserved_count:0}]);
 assert.deepEqual((await events()).map(e => e.status),["sent"]);
 assert.equal((await db.query("SELECT count(*)::int n FROM deliveries WHERE channel='line' AND status='sent'")).rows[0].n,1);
});

test("a rolled-back business transaction leaves no event or notification", async () => {
 const j = await dispatchTo(await ticket());
 await db.query("UPDATE repair_vendor_jobs SET sharing_approved_at=now(),sharing_approved_by=$2,shared_description='x' WHERE id=$1",[j.jobId,USERS.admin]);
 let produced: string | null = null;
 await assert.rejects(svc(null, async c => { produced = await recordVendorDispatchEvent(c,ORG_ID,j.ticketId,j.jobId,"shared"); throw new Error("rollback"); }));
 assert.ok(produced);
 assert.deepEqual(await events(),[]); assert.equal((await db.query("SELECT count(*)::int n FROM notifications WHERE related_id=$1",[j.jobId])).rows[0].n,0);
});

test("Taipei month boundary: a retry settles the reservation's original month even when the current month is full", async () => {
 assert.deepEqual((await db.query(`SELECT date_trunc('month','2026-11-30 16:00Z'::timestamptz AT TIME ZONE 'Asia/Taipei')::date::text a,
  date_trunc('month','2026-11-30 15:59:59Z'::timestamptz AT TIME ZONE 'Asia/Taipei')::date::text b`)).rows[0],{ a: "2026-12-01", b: "2026-11-01" });
 await assignedA();
 const e = (await db.query("SELECT notification_id,claim_id FROM app.b039_dispatch_events")).rows[0];
 const prior = (await db.query("SELECT (date_trunc('month',now() AT TIME ZONE 'Asia/Taipei')-interval '1 month')::date::text m")).rows[0].m;
 await db.query("INSERT INTO line_push_usage(line_channel_id,period_month,pushed_count,reserved_count) VALUES($1,$2,5,1)",[channel,prior]);
 await db.query("SELECT app.b033_org_budget_set($1,$2,$3,180)",[channel,ORG_ID,prior]);
 await db.query("UPDATE app.b033_org_push_budgets SET reserved=1 WHERE line_channel_id=$1 AND org_id=$2 AND period_month=$3",[channel,ORG_ID,prior]);
 await db.query(`INSERT INTO app.b033_push_reservations(claim_id,line_channel_id,org_id,notification_id,period_month,status,attempt_count,has_unknown,notification_deadline)
  VALUES($1,$2,$3,$4,$5,'unknown',1,true,now()+interval '4 minutes')`,[e.claim_id,channel,ORG_ID,e.notification_id,prior]);
 await usage(180);
 const t = transportFor("accepted"); assert.deepEqual((await run(t)).map(r => [r.kind,r.status]),[["assigned","sent"]]);
 assert.equal(pushes(t)[0].headers["X-Line-Retry-Key"],e.claim_id);
 assert.deepEqual((await db.query("SELECT period_month::text m,pushed_count,reserved_count FROM line_push_usage ORDER BY period_month")).rows.map(r => [r.m === prior,r.pushed_count,r.reserved_count]),
  [[true,6,0],[false,180,0]]);
 assert.deepEqual((await db.query("SELECT used,reserved FROM app.b033_org_push_budgets WHERE period_month=$1 AND org_id=$2",[prior,ORG_ID])).rows,[{ used: 1, reserved: 0 }]);
});

async function expireAndDrainEmail() {
 await db.query("UPDATE app.b033_push_reservations SET notification_deadline=now()-interval '1 second'");
 await expireLinePushes(ORG_ID, dispatchEnv);
 const email = createCaptureAdapter("email"); await runDeliveryAttempts(ORG_ID, email, 20); return email.captures;
}
const possibleDuplicates = async () => (await db.query("SELECT count(*)::int n FROM deliveries WHERE error='line_unknown_possible_duplicate'")).rows[0].n;

test("timeout, then revoke: the uncertain announcement still gets exactly one cancellation and no possible-duplicate Email", async () => {
 const { j } = await assignedA(); const timeout = transportFor("timeout"); await run(timeout); assert.equal(pushes(timeout).length,1); await due();
 await revokeJob(j);
 const t = transportFor("accepted"), results = await run(t);
 assert.deepEqual(results.map(r => [r.kind,r.status,r.reason]),[["assigned","uncertain","stale_after_unknown"],["cancelled","sent",undefined]]);
 assert.deepEqual(pushes(t).map(p => [p.to,p.messages]),[[subA,vendorDispatchMessages("cancelled","zh-TW",null)]]);
 const assigned = (await db.query("SELECT notification_id,claim_id FROM app.b039_dispatch_events WHERE kind='assigned'")).rows[0];
 assert.deepEqual((await db.query("SELECT status,has_unknown FROM app.b033_push_reservations WHERE claim_id=$1",[assigned.claim_id])).rows,[{status:"expired",has_unknown:true}]);
 assert.deepEqual((await db.query("SELECT status,error FROM deliveries WHERE b033_claim_id=$1",[assigned.claim_id])).rows,[{status:"failed",error:"line_unknown_suppressed"}]);
 assert.equal((await db.query("SELECT status FROM notifications WHERE id=$1",[assigned.notification_id])).rows[0].status,"cancelled");
 const captures = await expireAndDrainEmail();
 assert.deepEqual(captures,[]); assert.equal(await possibleDuplicates(),0);
 // Uncertain quota stays counted; the cancellation settled once.
 assert.deepEqual((await db.query("SELECT pushed_count,reserved_count FROM line_push_usage")).rows,[{pushed_count:1,reserved_count:1}]);
 const again = transportFor("accepted"); assert.deepEqual(await run(again),[]); assert.equal(again.calls.length,0);
});

test("timeout, then same-vendor re-dispatch: the reschedule keeps the updated wording (no double announce) and no possible-duplicate Email", async () => {
 const { j } = await assignedA(); await run(transportFor("timeout")); await due();
 const next = await dispatchTo(j.ticketId,{ vendorId: j.contact, window: "Saturday" }); await share(next);
 const t = transportFor("accepted"), results = await run(t);
 assert.deepEqual(results.map(r => [r.kind,r.status]),[["assigned","uncertain"],["rescheduled","sent"]]);
 assert.deepEqual(pushes(t).map(p => p.messages),[vendorDispatchMessages("rescheduled","zh-TW",`${origin}/v/${next.token}`)]);
 assert.deepEqual(await expireAndDrainEmail(),[]); assert.equal(await possibleDuplicates(),0);
});

test("Email fallback template rule per dispatch_* event: same key and wording as LINE; link only for an open job; never for cancellation", async () => {
 const link = `${origin}/v/token`;
 assert.deepEqual(vendorDispatchEmailTemplate({ kind: "assigned", dependency: null, locale: "en", link }),
  { templateKey: "line_dispatch_assigned", locale: "en", text: vendorDispatchMessages("assigned","en",link)[0].text, link });
 assert.deepEqual(vendorDispatchEmailTemplate({ kind: "rescheduled", dependency: "sent", locale: "zh-TW", link }),
  { templateKey: "line_dispatch_rescheduled", locale: "zh-TW", text: vendorDispatchMessages("rescheduled","zh-TW",link)[0].text, link });
 assert.equal((vendorDispatchEmailTemplate({ kind: "rescheduled", dependency: "uncertain", locale: "zh-TW", link }) as { templateKey: string }).templateKey,"line_dispatch_rescheduled");
 assert.equal((vendorDispatchEmailTemplate({ kind: "rescheduled", dependency: "superseded", locale: "zh-TW", link }) as { templateKey: string }).templateKey,"line_dispatch_assigned");
 assert.deepEqual(vendorDispatchEmailTemplate({ kind: "cancelled", dependency: "sent", locale: "en", link }),
  { templateKey: "line_dispatch_cancelled", locale: "en", text: vendorDispatchMessages("cancelled","en",null)[0].text, link: null });
 for (const kind of ["assigned","rescheduled"] as const) assert.deepEqual(vendorDispatchEmailTemplate({ kind, dependency: "sent", locale: "en", link: null }),{ suppressed: true });
 // DB-backed: a quota-full fallback Email for an open job carries its link; after revoke it is suppressed; the cancellation has none.
 const { j } = await assignedA(); await usage(180); await run(transportFor("accepted"));
 const assigned = (await db.query("SELECT notification_id FROM app.b039_dispatch_events WHERE kind='assigned'")).rows[0].notification_id;
 const open = await vendorDispatchEmailContent(ORG_ID, assigned, origin) as { templateKey: string; link: string };
 assert.equal(open.templateKey,"line_dispatch_assigned"); assert.equal(open.link,`${origin}/v/${j.token}`);
 assert.equal(await vendorDispatchEmailContent(ORG2_ID, assigned, origin),null);
 await revokeJob(j);
 assert.deepEqual(await vendorDispatchEmailContent(ORG_ID, assigned, origin),{ suppressed: true });
 const cancel = (await db.query("SELECT notification_id FROM app.b039_dispatch_events WHERE kind='cancelled'")).rows[0].notification_id;
 assert.deepEqual(await vendorDispatchEmailContent(ORG_ID, cancel, origin),
  { templateKey: "line_dispatch_cancelled", locale: "zh-TW", text: vendorDispatchMessages("cancelled","zh-TW",null)[0].text, link: null });
});

async function eventRow(kind: string) { return (await db.query("SELECT notification_id,claim_id,status,reason FROM app.b039_dispatch_events WHERE kind=$1",[kind])).rows[0]; }
const emailAttempts = async (notification: string) => (await db.query("SELECT count(*)::int n FROM app.b028_delivery_attempts WHERE source_id=$1 AND channel='email'",[notification])).rows[0].n;

test("close_stale replays settled, terminal-fallback and expired claims instead of superseding (race: expiry between decision and close)", async () => {
 // (a) decision saw prior=unknown, then another row's expiry expired the reservation before close_stale.
 const { j } = await assignedA(); await run(transportFor("timeout")); await revokeJob(j);
 const assigned = await eventRow("assigned");
 await db.query("UPDATE app.b033_push_reservations SET notification_deadline=now()-interval '1 second' WHERE claim_id=$1",[assigned.claim_id]);
 await expireLinePushes(ORG_ID, dispatchEnv); assert.equal(await emailAttempts(assigned.notification_id),1); // B-033's single notice
 assert.equal((await db.query("SELECT app.b039_dispatch_close_stale($1,$2) s",[assigned.notification_id,assigned.claim_id])).rows[0].s,"uncertain");
 assert.deepEqual(await eventRow("assigned"),{ ...assigned, status: "uncertain", reason: "expired_after_unknown" });
 const t = transportFor("accepted"); assert.deepEqual((await run(t)).map(r => [r.kind,r.status]),[["cancelled","sent"]]);
 assert.equal(pushes(t)[0].to,subA); assert.equal(await emailAttempts(assigned.notification_id),1);
 // Settled and terminal-fallback claims replay as delivered.
 for (const mode of ["settled","fallback"] as const) {
  const other = await dispatchTo(await ticket(),{ vendorId: j.contact }); await share(other);
  if (mode === "fallback") await usage(180);
  await run(transportFor("accepted"));
  const e = (await db.query("SELECT notification_id,claim_id FROM app.b039_dispatch_events WHERE job_id=$1",[other.jobId])).rows[0];
  await db.query("UPDATE app.b039_dispatch_events SET status='pending',reason=NULL,completed_at=NULL WHERE notification_id=$1",[e.notification_id]);
  assert.equal((await db.query("SELECT app.b039_dispatch_close_stale($1,$2) s",[e.notification_id,e.claim_id])).rows[0].s, mode === "settled" ? "sent" : "fallback");
  await usage(0);
 }
});

test("no selected OA replays a settled attempt: no line_unavailable Email on top of LINE, and a revoke still sends the cancellation", async () => {
 const { j } = await assignedA(); await run(transportFor("accepted"));
 const assigned = await eventRow("assigned");
 await db.query("UPDATE app.b039_dispatch_events SET status='pending',reason=NULL,completed_at=NULL WHERE notification_id=$1",[assigned.notification_id]); // crash before finish
 await revokeJob(j); await db.query("UPDATE line_channels SET is_active=false");
 const t = transportFor("accepted"), results = await run(t);
 assert.deepEqual(results.map(r => [r.kind,r.status,r.reason]),[["assigned","sent","replayed_settled"],["cancelled","fallback","line_unavailable"]]);
 assert.equal(t.calls.length,0); assert.equal(await emailAttempts(assigned.notification_id),0);
 assert.equal(await emailAttempts((await eventRow("cancelled")).notification_id),1);
});

test("no selected OA without revoke: settled replays as sent (no double announce); expired-after-unknown is uncertain with no new Email; open unknown waits", async () => {
 const first = await assignedA(); await run(transportFor("accepted"));
 const a = await eventRow("assigned");
 await db.query("UPDATE app.b039_dispatch_events SET status='pending',reason=NULL,completed_at=NULL WHERE notification_id=$1",[a.notification_id]);
 await db.query("UPDATE line_channels SET is_active=false");
 assert.deepEqual((await run(transportFor("accepted"))).map(r => [r.status,r.reason]),[["sent","replayed_settled"]]);
 assert.equal(await emailAttempts(a.notification_id),0);
 await db.query("UPDATE line_channels SET is_active=true"); await db.query("SELECT app.b033_channel_verify($1)",[channel]);
 // Second job: unknown attempt, then the OA is deselected.
 const second = await dispatchTo(await ticket(),{ vendorId: first.j.contact }); await share(second); await run(transportFor("timeout")); await due();
 const b = (await db.query("SELECT notification_id,claim_id FROM app.b039_dispatch_events WHERE job_id=$1",[second.jobId])).rows[0];
 await db.query("UPDATE line_channels SET is_active=false");
 assert.deepEqual((await run(transportFor("accepted"))).map(r => r.status),["wait"]); await due(); assert.equal(await emailAttempts(b.notification_id),0);
 await db.query("UPDATE app.b033_push_reservations SET notification_deadline=now()-interval '1 second' WHERE claim_id=$1",[b.claim_id]);
 await expireLinePushes(ORG_ID, dispatchEnv); await due();
 assert.deepEqual((await run(transportFor("accepted"))).map(r => [r.status,r.reason]),[["uncertain","expired_after_unknown"]]);
 assert.equal(await emailAttempts(b.notification_id),1); // only B-033's single possible-duplicate notice
});

async function switchChannel() {
 const y = (await db.query(`INSERT INTO line_channels(org_id,mode,display_name,line_provider_id,messaging_channel_id,messaging_channel_secret_ref,messaging_access_token_ref,is_active)
  VALUES($1,'org_owned','B039 Y','provider-y','b039-y-messaging','vault://b039/y/secret','vault://b039/y/token',true) RETURNING id`,[ORG_ID])).rows[0].id;
 await db.query("SELECT app.b033_liff_configure($1,'y-tenant','y-vendor','y-owner')",[y]);
 await db.query("SELECT app.b033_channel_verify($1)",[y]);
 await db.query("UPDATE organizations SET line_channel_id=$2 WHERE id=$1",[ORG_ID,y]);
 assert.equal((await db.query("SELECT app.b033_selected_channel($1) id",[ORG_ID])).rows[0].id,y);
 return y;
}

test("unknown attempt on OA X, switch to OA Y, revoke: event closes uncertain, the cancel is delivered exactly once, no double announce", async () => {
 const { j } = await assignedA(); await run(transportFor("timeout")); await revokeJob(j); await switchChannel(); await due();
 const t = transportFor("accepted"), results = await run(t);
 assert.deepEqual(results.map(r => [r.kind,r.status,r.reason]),[["assigned","uncertain","stale_after_unknown"],["cancelled","fallback","line_guard"]]);
 assert.equal(t.calls.length,0); // vendor's trusted link is on X; the cancel follows the shared policy to Email
 const assigned = await eventRow("assigned"), cancel = await eventRow("cancelled");
 assert.equal(await emailAttempts(assigned.notification_id),0); assert.equal(await emailAttempts(cancel.notification_id),1);
 await db.query("UPDATE app.b033_push_reservations SET notification_deadline=now()-interval '1 second'"); await expireLinePushes(ORG_ID, dispatchEnv);
 assert.equal(await possibleDuplicates(),0); await due(); assert.deepEqual(await run(t),[]);
});

test("unknown attempt on OA X, switch to OA Y, no revoke: never stuck; waits with backoff, then B-033's single notice and a terminal uncertain event", async () => {
 await assignedA(); await run(transportFor("timeout")); await switchChannel(); await due();
 const assigned = await eventRow("assigned");
 assert.deepEqual((await run(transportFor("accepted"))).map(r => r.status),["wait"]);
 assert.ok((await db.query("SELECT next_attempt_at>clock_timestamp() later FROM app.b039_dispatch_events")).rows[0].later);
 assert.equal(await emailAttempts(assigned.notification_id),0);
 await db.query("UPDATE app.b033_push_reservations SET notification_deadline=now()-interval '1 second'"); await expireLinePushes(ORG_ID, dispatchEnv); await due();
 const t = transportFor("accepted");
 assert.deepEqual((await run(t)).map(r => [r.status,r.reason]),[["uncertain","expired_after_unknown"]]); assert.equal(t.calls.length,0);
 assert.equal(await emailAttempts(assigned.notification_id),1);
});

test("an unattempted claim already given B-033's expiry Email replays as fallback (Email delivered), not uncertain", async () => {
 await assignedA(); const e = await eventRow("assigned");
 const month = (await db.query("SELECT date_trunc('month',now() AT TIME ZONE 'Asia/Taipei')::date::text m")).rows[0].m;
 await usage(0);
 await db.query(`INSERT INTO app.b033_push_reservations(claim_id,line_channel_id,org_id,notification_id,period_month,status,notification_deadline)
  VALUES($1,$2,$3,$4,$5,'reserved',now()-interval '1 second')`,[e.claim_id,channel,ORG_ID,e.notification_id,month]);
 await expireLinePushes(ORG_ID, dispatchEnv); assert.equal(await emailAttempts(e.notification_id),1);
 assert.equal((await db.query("SELECT app.b039_dispatch_close_stale($1,$2) s",[e.notification_id,e.claim_id])).rows[0].s,"fallback");
 assert.deepEqual(await eventRow("assigned"),{ ...e, status: "fallback", reason: "line_unknown_possible_duplicate" });
 assert.equal(await emailAttempts(e.notification_id),1);
});

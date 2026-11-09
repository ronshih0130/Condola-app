import "next/dist/server/node-environment-baseline";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
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
import { createCaptureAdapter, runDeliveryAttempts } from "./notification-delivery";
import type { Session } from "./types";
import { lineHash, type LinePersona } from "./line/login-token";
import { randomProof } from "./line/login-link";
import { LINE_JOB_COOKIE } from "./line/vendor-scope";
import { LINE_BROWSER_COOKIE, LINE_CSRF_COOKIE } from "./line/login-routes";
import { dispatchLinePush, type LinePush } from "./line/quota";
import { runVendorDispatchPushes } from "./line/dispatch-push";
import { createCapturedLineTransport } from "./line/transport";
import { createWebhookPost } from "./line/webhook";
import { resolveLocalLineSecret } from "./line/secrets";
import { POST as flows } from "../app/api/line/flows/route";
import { POST as session } from "../app/api/line/session/route";
import { POST as accept } from "../app/api/line/invites/accept/route";
import { POST as bind } from "../app/api/line/bind/route";
import { POST as reauth } from "../app/api/line/reauth/route";
import { GET as links } from "../app/api/line/links/route";
import { DELETE as unlink } from "../app/api/line/links/[id]/route";
import { DELETE as revoke } from "../app/api/line/identity/route";
import { POST as webhook } from "../app/api/line/webhook/route";
import { GET as tenantEntry } from "../app/(line)/t/liff/route";
import { GET as ownerEntry } from "../app/(line)/o/liff/route";
import { GET as vendorEntry, POST as vendorEntryProof } from "../app/(line)/v/liff/route";
import { GET as vendorJobPage } from "../app/(line)/v/liff/job/route";
import { GET as vendorJob, POST as vendorReport } from "../app/api/line/vendor-job/route";

// Local-only rehearsal of the hosted J1/J3/J5 LINE checks. ALL LINE flags ON, but only inside this disposable
// clone; captured transports; fetch throws. The hosted staging rehearsal is a separate, pending step.
disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
const origin = "https://app.condola.app", secret = "b039r-login-secret", pepper = "b039r-pepper";
const hookSecret = "b039r-webhook-secret", destination = "b039r-bot";
const subs = { tenant: `U${"1".repeat(32)}`, owner: `U${"2".repeat(32)}`, vendor: `U${"3".repeat(32)}` } as const;
const meta = { ua: "local-b039-rehearsal", ip: null }, pushEnv = { LINE_PLATFORM_ENABLED: "true", LINE_PUSH_QUOTA_GUARD: "true" };
let db: Client, clone: Awaited<ReturnType<typeof cloneTestDatabase>>, channel: string, browser: string, csrf: string, admin: Session;
let fetchCalls = 0, seq = 0;
const statuses: Array<[string, number]> = [], recipients = new Map<string, string>();
const previous = { ...process.env }, savedFetch = globalThis.fetch;

function jwt(sub: string) {
 const now = Math.floor(Date.now()/1000);
 const raw = [{ alg: "HS256" }, { iss: "https://access.line.me", aud: "b039r-login", sub, iat: now-1, exp: now+300 }].map(v => Buffer.from(JSON.stringify(v)).toString("base64url")).join(".");
 return `${raw}.${createHmac("sha256",secret).update(raw).digest("base64url")}`;
}
function req(path: string, input?: Record<string, unknown>, opts: { session?: string; claim?: string; method?: string; bodyOnly?: boolean } = {}) {
 return new Request(origin+path, { method: opts.method ?? (input ? "POST" : "GET"), headers: { Origin: origin, "Content-Type": "application/json",
  Cookie: `${LINE_BROWSER_COOKIE}=${browser}; ${LINE_CSRF_COOKIE}=${csrf}${opts.session ? `; condola_session=${opts.session}` : ""}${opts.claim ? `; ${LINE_JOB_COOKIE}=${opts.claim}` : ""}` },
  ...(input ? { body: JSON.stringify(opts.bodyOnly ? input : { csrf, ...input }) } : {}) });
}
/** Every exported handler call is recorded so the rehearsal can assert zero 5xx. */
async function call(label: string, response: Response | Promise<Response>, status = 200) {
 const r = await response; statuses.push([label, r.status]);
 assert.equal(r.status, status, `${label}: ${await r.clone().text()}`); return r;
}
const json = async (label: string, response: Response | Promise<Response>, status = 200) => (await call(label, response, status)).json();
const cookieValue = (r: Response, name: string) => new RegExp(`${name}=([^;,]+)`).exec(r.headers.get("set-cookie") ?? "")?.[1];
async function flag(key: string, org = ORG_ID) {
 await db.query("INSERT INTO platform_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[key,JSON.stringify({ enabled: true, allowed_org_ids: [ORG_ID,ORG2_ID] })]);
 await db.query("UPDATE organizations SET feature_flags=feature_flags||jsonb_build_object($2::text,true) WHERE id=$1",[org,key]);
}
async function friend(sub: string, type: "follow" | "unfollow") {
 const raw = JSON.stringify({ destination, events: [{ webhookEventId: randomUUID(), type, timestamp: Date.now() + (seq++), source: { userId: sub } }] });
 await call(`webhook ${type}`, webhook(new Request(`${origin}/api/line/webhook?org=${ORG_ID}&channel=${channel}`, { method: "POST",
  headers: { "x-line-signature": createHmac("sha256", hookSecret).update(raw).digest("base64") }, body: raw })));
}
async function stepped(user: string, persona: LinePersona) {
 const token = await createSession(user, false, meta);
 await json(`${persona} reauth`, reauth(req("/api/line/reauth", { orgId: ORG_ID, persona, password: DEMO_PASSWORD }, { session: token })));
 return token;
}
async function notify(contact: string, event: string, lease: string | null) {
 return (await db.query("INSERT INTO notifications(org_id,recipient_contact_id,event_type,template_key,locale,lease_id) VALUES($1,$2,$3,$4,'zh-TW',$5) RETURNING id",
  [ORG_ID, contact, event, `notifications.${event}`, lease])).rows[0].id as string;
}
const push = (notificationId: string, persona: LinePush["persona"], to: string): LinePush =>
 ({ orgId: ORG_ID, notificationId, claimId: randomUUID(), channelId: channel, persona, to, identityPepper: pepper, messages: [{ type: "text", text: "local rehearsal" }] });
const kill = async <T>(work: () => Promise<T>) => { __setVendorLinkKillSwitchForTests(true); try { return await work(); } finally { __setVendorLinkKillSwitchForTests(false); } };
async function newJob(ticketId?: string, vendorId?: string) {
 const id = ticketId ?? randomUUID();
 if (!ticketId) await db.query(`INSERT INTO maintenance_tickets(id,org_id,property_id,ticket_number,category,title,description,status)
  SELECT $1,$2,id,(SELECT coalesce(max(ticket_number),0)+1 FROM maintenance_tickets WHERE org_id=$2),'plumbing','PRIVATE TITLE','PRIVATE DESCRIPTION','open'
  FROM properties WHERE org_id=$2 AND archived_at IS NULL ORDER BY id LIMIT 1`,[id,ORG_ID]);
 const job = await kill(() => dispatchVendor(admin,id,{ vendorId, vendorName: vendorId ? "" : `B039R-${randomUUID()}`,vendorPhone:"0912111222",vendorTrade:"plumbing",contactWindow:"Monday" },origin));
 const contact = (await db.query("SELECT vendor_contact_id FROM repair_vendor_jobs WHERE id=$1",[job.jobId])).rows[0].vendor_contact_id as string;
 await db.query("UPDATE contacts SET email=$2 WHERE id=$1",[contact,`vendor-${contact.slice(0,8)}@local.test`]);
 return { ...job, ticketId: id, contact, token: new URL(job.url).pathname.slice(3) };
}
const share = (j: { ticketId: string; jobId: string }) => kill(() => approveVendorSharing(admin,j.ticketId,j.jobId,{ description:"Approved scoped repair",attachmentIds:[] }));
const dispatchWorker = (transport: ReturnType<typeof createCapturedLineTransport>) => runVendorDispatchPushes(ORG_ID, { transport, origin, env: pushEnv,
 resolveRecipient: async ({ linkId }) => recipients.has(linkId) ? { to: recipients.get(linkId)!, identityPepper: pepper } : null });
const pushedTo = (t: ReturnType<typeof createCapturedLineTransport>) => t.calls.flatMap(c => c.method === "push" ? [c.request] : []);
const linkIn = (text: string) => /https:\/\/app\.condola\.app\/v\/([A-Za-z0-9_-]+)/.exec(text)?.[1];

test.before(async () => { clone = await cloneTestDatabase(); db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
 globalThis.fetch = async () => { fetchCalls++; throw new Error("B039 rehearsal network forbidden"); };
 process.env.DEMO_MODE="true"; process.env.ID_DOC_ENCRYPTION_KEY=randomBytes(32).toString("hex"); await resetAndSeed(); process.env.DEMO_MODE="false";
 process.env.LINE_PLATFORM_ENABLED="true"; browser=randomProof(); csrf=randomProof();
 for (const key of ["line_platform","line_push","notification_delivery_v2","line_tenant_portal","line_vendor_portal","line_owner_portal","line_dispatch_push","vendor_account"]) await flag(key);
 await db.query("UPDATE organizations SET feature_flags=feature_flags||'{\"vendor_dispatch\":true,\"vendor_link\":true}' WHERE id=$1",[ORG_ID]);
 channel=(await db.query("SELECT id FROM line_channels WHERE mode='platform_default' AND is_active")).rows[0].id;
 await db.query("SELECT app.b033_liff_configure($1,'local-tenant','local-vendor','local-owner')",[channel]);
 await db.query("UPDATE line_channels SET login_channel_id='b039r-login',login_channel_secret_ref='b039r-local' WHERE id=$1",[channel]);
 await db.query("SELECT app.b033_channel_verify($1)",[channel]);
 const ref = (await db.query("SELECT messaging_channel_secret_ref FROM line_channels WHERE id=$1",[channel])).rows[0].messaging_channel_secret_ref;
 process.env.LINE_CHANNEL_SECRETS=JSON.stringify({ "b039r-local": { secret, identityPepper: pepper, destination }, [ref]: { secret: hookSecret, identityPepper: pepper, destination } });
 await db.query("SELECT app.b033_org_budget_set($1,$2,date_trunc('month',now() AT TIME ZONE 'Asia/Taipei')::date,180)",[channel,ORG_ID]);
 const token = await createSession(USERS.admin,false,meta), sid = (await db.query("SELECT id FROM auth_sessions WHERE token_hash=$1",[lineHash(token)])).rows[0].id;
 admin = { userId:USERS.admin,sessionId:sid,orgId:ORG_ID,liveOrgId:ORG_ID,kind:"staff",role:"admin",environment:"live",locale:"zh-TW",calendar:"gregorian",email:"local@example.test",name:"Local",leaseId:null };
});
test.after(async () => { globalThis.fetch=savedFetch; __setVendorLinkKillSwitchForTests(false); await db?.end(); await clone?.cleanup();
 for (const key of ["DEMO_MODE","ID_DOC_ENCRYPTION_KEY","LINE_PLATFORM_ENABLED","LINE_CHANNEL_SECRETS"]) { if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key]; } });

// The journeys share state and run in order (node:test is sequential within a file).
const state: { tenantContact?: string; lease?: string; ownerContact?: string; tenantLink?: string; ownerLink?: string; ownerSession?: string;
 vendorLink?: string; vendorSession?: string; job?: Awaited<ReturnType<typeof newJob>> } = {};

test("J1 /t /o /v: LIFF bootstraps, tenant invite acceptance, owner and vendor binding, follow events, scope denials", async () => {
 for (const [persona, entry] of [["t", tenantEntry], ["o", ownerEntry], ["v", vendorEntry]] as const) {
  const r = await call(`/${persona}/liff`, entry(req(`/${persona}/liff?org=${ORG_ID}`)));
  assert.match(r.headers.get("set-cookie") ?? "", /Secure/); assert.match(await r.text(), new RegExp(`local-${persona === "t" ? "tenant" : persona === "o" ? "owner" : "vendor"}`));
 }
 // Tenant: Email invitation continued in LINE (existing account password), atomic link + session.
 state.tenantContact = (await db.query("SELECT id FROM contacts WHERE org_id=$1 AND user_id=$2 AND is_tenant",[ORG_ID,USERS.tenant])).rows[0].id;
 state.lease = (await db.query("SELECT lease_id FROM lease_parties WHERE org_id=$1 AND contact_id=$2 AND role='primary'",[ORG_ID,state.tenantContact])).rows[0].lease_id;
 await db.query("DELETE FROM line_account_links WHERE contact_id=$1",[state.tenantContact]);
 const inviteToken = randomProof(), email = (await db.query("SELECT email FROM contacts WHERE id=$1",[state.tenantContact])).rows[0].email;
 await db.query("UPDATE invitations SET status='revoked' WHERE contact_id=$1 AND status='pending'",[state.tenantContact]);
 await db.query(`INSERT INTO invitations(id,org_id,kind,contact_id,lease_id,email,code_hash,status,expires_at,invited_by)
  VALUES($1,$2,'tenant',$3,$4,$5,$6,'pending',now()+interval '1 day',$7)`,[randomUUID(),ORG_ID,state.tenantContact,state.lease,email,lineHash(inviteToken),USERS.admin]);
 const invite = await json("tenant invite flow", flows(req("/api/line/flows",{ purpose:"invite",orgId:ORG_ID,persona:"tenant",inviteToken })),201);
 assert.match(invite.liffUrl,/^\/t\/liff/);
 const accepted = await json("tenant invite accept", accept(req("/api/line/invites/accept",{ flow:invite.flow,idToken:jwt(subs.tenant),password:DEMO_PASSWORD,consentTextKey:"line.binding.v1" })));
 assert.equal(accepted.next,"/t"); state.tenantLink = accepted.linkId; recipients.set(accepted.linkId,subs.tenant);
 // Owner: password session + explicit step-up + bind.
 state.ownerContact = (await db.query("SELECT id FROM contacts WHERE org_id=$1 AND user_id=$2 AND is_owner",[ORG_ID,USERS.owner])).rows[0].id;
 await db.query("DELETE FROM line_account_links WHERE contact_id=$1",[state.ownerContact]);
 state.ownerSession = await stepped(USERS.owner,"owner");
 const ownerFlow = await json("owner bind flow", flows(req("/api/line/flows",{ purpose:"bind",orgId:ORG_ID,persona:"owner",contactId:state.ownerContact },{ session:state.ownerSession })),201);
 state.ownerLink = (await json("owner bind", bind(req("/api/line/bind",{ flow:ownerFlow.flow,idToken:jwt(subs.owner),consentTextKey:"line.binding.v1" },{ session:state.ownerSession })))).linkId;
 recipients.set(state.ownerLink!,subs.owner);
 // Vendor: dispatch creates the job contact; B-026 account mapping; then LINE bind.
 state.job = await newJob();
 state.vendorSession = await createSession(USERS.tenant2,false,meta);
 const invitation = await inviteVendorAccount(admin,state.job.contact,USERS.tenant2); assert.ok(invitation.invitation);
 await claimVendorAccount(state.vendorSession,invitation.invitation!);
 await json("vendor reauth", reauth(req("/api/line/reauth",{ orgId:ORG_ID,persona:"vendor",password:DEMO_PASSWORD },{ session:state.vendorSession })));
 const vendorFlow = await json("vendor bind flow", flows(req("/api/line/flows",{ purpose:"bind",orgId:ORG_ID,persona:"vendor",contactId:state.job.contact },{ session:state.vendorSession })),201);
 state.vendorLink = (await json("vendor bind", bind(req("/api/line/bind",{ flow:vendorFlow.flow,idToken:jwt(subs.vendor),consentTextKey:"line.binding.v1" },{ session:state.vendorSession })))).linkId;
 recipients.set(state.vendorLink!,subs.vendor);
 for (const sub of Object.values(subs)) await friend(sub,"follow");
 assert.equal((await db.query("SELECT count(*)::int n FROM line_account_links WHERE id=ANY($1) AND is_friend AND notification_opt_in",[[state.tenantLink,state.ownerLink,state.vendorLink]])).rows[0].n,3);
 // LINE sign-in on each portal reuses the trusted identity and lands on that portal.
 for (const [persona, portal] of [["tenant","/t"],["owner","/o/statements"],["vendor","/vendor-account"]] as const) {
  const f = await json(`${persona} login flow`, flows(req("/api/line/flows",{ purpose:"login",orgId:ORG_ID,persona })),201);
  const signed = await json(`${persona} LINE session`, session(req("/api/line/session",{ flow:f.flow,idToken:jwt(subs[persona]) })));
  assert.ok(signed.next === portal || signed.next === `/consent?next=${encodeURIComponent(portal)}`, `${persona} -> ${signed.next}`);
 }
 // Scope checks: another user, another organization, another persona.
 const stranger = await stepped(USERS.tenant2,"tenant");
 await json("foreign tenant contact", flows(req("/api/line/flows",{ purpose:"bind",orgId:ORG_ID,persona:"tenant",contactId:state.tenantContact },{ session:stranger })),404);
 await json("cross-org bind", flows(req("/api/line/flows",{ purpose:"bind",orgId:ORG2_ID,persona:"tenant",contactId:state.tenantContact },{ session:stranger })),404);
 await json("owner as vendor", flows(req("/api/line/flows",{ purpose:"bind",orgId:ORG_ID,persona:"vendor",contactId:state.job.contact },{ session:state.ownerSession })),404);
 const listed = await json("owner links", links(req("/api/line/links",undefined,{ session:state.ownerSession })));
 assert.deepEqual(listed.links.map((l: { id: string }) => l.id),[state.ownerLink]);
});

test("J3 /t /o: event delivery through the captured transport, then quota-full Email fallback captured by the B-028 worker", async () => {
 const t = createCapturedLineTransport({ mode: "accepted" });
 const rent = push(await notify(state.tenantContact!,"rent_due",state.lease!),"tenant",subs.tenant);
 assert.deepEqual(await dispatchLinePush(rent,t,pushEnv),{ status: "accepted" });
 const statement = push(await notify(state.ownerContact!,"b039_owner_rehearsal",null),"owner",subs.owner);
 assert.deepEqual(await dispatchLinePush(statement,t,pushEnv),{ status: "accepted" });
 assert.deepEqual(pushedTo(t).map(p => [p.to,p.headers["X-Line-Retry-Key"]]),[[subs.tenant,rent.claimId],[subs.owner,statement.claimId]]);
 // Owner portal access is still the owner's own: the tenant's identity cannot drive an owner push.
 const crossed = push(await notify(state.ownerContact!,"b039_owner_rehearsal",null),"owner",subs.tenant);
 const crossedResult = await dispatchLinePush(crossed,t,pushEnv); assert.equal(crossedResult.status,"skipped"); assert.equal(pushedTo(t).length,2);
 // Fill the shared channel counter: the next rent event skips LINE with line_quota and queues one Email.
 await db.query("UPDATE line_push_usage SET pushed_count=180 WHERE line_channel_id=$1",[channel]);
 const overdue = push(await notify(state.tenantContact!,"rent_overdue",state.lease!),"tenant",subs.tenant);
 const blocked = await dispatchLinePush(overdue,t,pushEnv);
 assert.equal(blocked.status,"skipped"); assert.equal("reason" in blocked && blocked.reason,"line_quota"); assert.equal(pushedTo(t).length,2);
 assert.deepEqual(await dispatchLinePush(overdue,t,pushEnv),blocked); // replay is deduplicated
 // Message/postback under full quota still replies through the Reply API only.
 const replyTransport = createCapturedLineTransport({ mode: "accepted" }), pushes: unknown[] = [];
 const guarded = { reply: replyTransport.reply.bind(replyTransport), push: async (r: unknown) => { pushes.push(r); throw new Error("no push"); } };
 const post = createWebhookPost({ resolveSecret: resolveLocalLineSecret, env: pushEnv, replyMessages: () => [{ type: "text", text: "local ack" }], transport: guarded });
 const raw = JSON.stringify({ destination, events: [{ webhookEventId: randomUUID(), type: "message", timestamp: Date.now(), source: { userId: subs.tenant }, replyToken: "rehearsal-reply" }] });
 await call("webhook message at full quota", post(new Request(`${origin}/api/line/webhook?org=${ORG_ID}&channel=${channel}`,{ method:"POST",
  headers:{ "x-line-signature": createHmac("sha256",hookSecret).update(raw).digest("base64") },body:raw })));
 assert.deepEqual(replyTransport.calls.map(c => c.method),["reply"]); assert.equal(pushes.length,0);
 const email = createCaptureAdapter("email"); await runDeliveryAttempts(ORG_ID,email,10);
 const captured = email.captures.map(c => [c.sourceKind,c.sourceId]);
 assert.ok(captured.some(([kind,id]) => kind === "line_notification" && id === overdue.notificationId), JSON.stringify(captured));
 assert.ok(captured.some(([,id]) => id === crossed.notificationId)); // guard fallback for the mismatched identity
 assert.ok(!captured.some(([,id]) => id === rent.notificationId || id === statement.notificationId)); // accepted LINE pushes are not doubled
 await db.query("UPDATE line_push_usage SET pushed_count=2 WHERE line_channel_id=$1",[channel]);
});

test("J5 /v: dispatch push opens only the shared job, reschedule and cancel follow the current assignment, old links are denied", async () => {
 const job = state.job!; await share(job);
 const first = createCapturedLineTransport({ mode: "accepted" });
 assert.deepEqual((await dispatchWorker(first)).map(r => [r.kind,r.status]),[["assigned","sent"]]);
 const link = linkIn(pushedTo(first)[0].messages[0].text)!; assert.equal(link,job.token); assert.equal(pushedTo(first)[0].to,subs.vendor);
 // Open the pushed link through B-035: entry proof -> flow -> LINE verification -> job claim -> read/report.
 await json("vendor entry proof", vendorEntryProof(req("/v/liff",{ jobToken:link },{ bodyOnly:true })));
 const f = await json("vendor job flow", flows(req("/api/line/flows",{ purpose:"login",persona:"vendor",orgId:ORG_ID,jobToken:link })),201);
 const exchanged = await call("vendor job exchange", session(req("/api/line/session",{ flow:f.flow,idToken:jwt(subs.vendor) })));
 const claim = cookieValue(exchanged,LINE_JOB_COOKIE)!; assert.ok(claim); assert.ok(!cookieValue(exchanged,"condola_session"));
 await call("vendor job page", vendorJobPage(req("/v/liff/job",undefined,{ claim })));
 const view = await json("vendor job read", vendorJob(req("/api/line/vendor-job",undefined,{ claim })));
 assert.equal(view.description,"Approved scoped repair"); assert.ok(!JSON.stringify(view).includes("PRIVATE"));
 await json("vendor job without claim", vendorJob(req("/api/line/vendor-job")),401);
 // Same-vendor re-dispatch: rescheduled push with the new link; the old link and old claim are denied.
 const again = await newJob(job.ticketId,job.contact); await share(again);
 const second = createCapturedLineTransport({ mode: "accepted" });
 assert.deepEqual((await dispatchWorker(second)).map(r => [r.kind,r.status]),[["rescheduled","sent"]]);
 assert.equal(linkIn(pushedTo(second)[0].messages[0].text),again.token);
 await json("old link entry", vendorEntryProof(req("/v/liff",{ jobToken:link },{ bodyOnly:true })),404);
 await json("old claim read", vendorJob(req("/api/line/vendor-job",undefined,{ claim })),404);
 // The current job's report goes through the existing writer.
 await json("new link entry", vendorEntryProof(req("/v/liff",{ jobToken:again.token },{ bodyOnly:true })));
 const f2 = await json("new job flow", flows(req("/api/line/flows",{ purpose:"login",persona:"vendor",orgId:ORG_ID,jobToken:again.token })),201);
 const claim2 = cookieValue(await call("new job exchange", session(req("/api/line/session",{ flow:f2.flow,idToken:jwt(subs.vendor) }))),LINE_JOB_COOKIE)!;
 await json("vendor report", vendorReport(req("/api/line/vendor-job",{ done:"true",cost:"1200" },{ claim:claim2 })));
 // Cancel a separate notified job: link-free cancellation push to the still-assigned vendor.
 const other = await newJob(undefined,job.contact); await share(other);
 const third = createCapturedLineTransport({ mode: "accepted" }); await dispatchWorker(third);
 await kill(() => revokeVendorJob(admin,other.ticketId,other.jobId));
 assert.deepEqual((await dispatchWorker(third)).map(r => [r.kind,r.status]),[["cancelled","sent"]]);
 assert.equal(linkIn(pushedTo(third)[1].messages[0].text),undefined);
 await json("cancelled link entry", vendorEntryProof(req("/v/liff",{ jobToken:other.token },{ bodyOnly:true })),404);
});

test("J1/J5 unlinking: tenant org unlink, owner global revoke and vendor unlink all route later events to Email", async () => {
 const tenantPassword = await stepped(USERS.tenant,"tenant");
 await json("tenant unlink", unlink(req(`/api/line/links/${state.tenantLink}`,{ reason:"user_request" },{ method:"DELETE",session:tenantPassword }),{ params: Promise.resolve({ id: state.tenantLink! }) }));
 await json("owner global revoke", revoke(req("/api/line/identity",{},{ method:"DELETE",session:state.ownerSession })));
 await json("vendor unlink", unlink(req(`/api/line/links/${state.vendorLink}`,{ reason:"user_request" },{ method:"DELETE",session:state.vendorSession }),{ params: Promise.resolve({ id: state.vendorLink! }) }));
 const t = createCapturedLineTransport({ mode: "accepted" });
 const rent = push(await notify(state.tenantContact!,"rent_due",state.lease!),"tenant",subs.tenant);
 const owner = push(await notify(state.ownerContact!,"b039_owner_rehearsal",null),"owner",subs.owner);
 for (const request of [rent, owner]) { const r = await dispatchLinePush(request,t,pushEnv); assert.equal(r.status,"skipped"); assert.equal("reason" in r && r.reason,"line_guard"); }
 const job = await newJob(undefined,state.job!.contact); await share(job);
 assert.deepEqual((await dispatchWorker(t)).map(r => [r.kind,r.status,r.reason]),[["assigned","fallback","line_guard"]]);
 assert.equal(pushedTo(t).length,0);
 const email = createCaptureAdapter("email"); await runDeliveryAttempts(ORG_ID,email,10);
 const ids = email.captures.map(c => c.sourceId), dispatchNotification = (await db.query("SELECT notification_id FROM app.b039_dispatch_events WHERE job_id=$1",[job.jobId])).rows[0].notification_id;
 for (const id of [rent.notificationId, owner.notificationId, dispatchNotification]) assert.ok(ids.includes(id), id);
 // A follow after unlinking never restores LINE delivery.
 await friend(subs.tenant,"follow");
 const later = await dispatchLinePush(push(await notify(state.tenantContact!,"rent_due",state.lease!),"tenant",subs.tenant),t,pushEnv);
 assert.equal(later.status,"skipped"); assert.equal(pushedTo(t).length,0);
});

test("rehearsal summary: zero 5xx across every exported handler call and zero network", () => {
 assert.ok(statuses.length >= 30, `exercised ${statuses.length} handler calls`);
 assert.deepEqual(statuses.filter(([, status]) => status >= 500), []);
 assert.equal(fetchCalls, 0);
 if (process.env.B039_WRITE_EVIDENCE === "1") {
  mkdirSync("e2e/results/B-039", { recursive: true });
  const byStatus: Record<string, number> = {};
  for (const [, status] of statuses) byStatus[status] = (byStatus[status] ?? 0) + 1;
  writeFileSync("e2e/results/B-039/rehearsal-summary.json", JSON.stringify({ scope: "local disposable clone; hosted staging pending",
   journeys: ["J1 /t /o /v binding, LINE sign-in, scope denials", "J3 tenant/owner captured pushes, quota-full Email fallback, Reply-only webhook",
    "J5 vendor dispatch push, B-035 open/read/report, reschedule, cancel, old link denied", "unlink/revoke routes later events to Email"],
   handlerCalls: statuses.length, byStatus, fiveHundreds: statuses.filter(([, status]) => status >= 500).length, networkCalls: fetchCalls,
   calls: statuses.map(([label, status]) => ({ label, status })) }, null, 1) + "\n");
 }
});

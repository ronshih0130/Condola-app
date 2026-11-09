import "next/dist/server/node-environment-baseline";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import React from "react";
import test from "node:test";
import { Client } from "pg";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import { resetAndSeed } from "./seed";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { createSession } from "./auth";
import { DEMO_PASSWORD } from "./demo-password";
import { approveVendorSharing, dispatchVendor } from "./vendor-repair";
import { claimVendorAccount, inviteVendorAccount, syncVendorAccount } from "./vendor-accounts";
import type { Session } from "./types";
import { lineHash } from "./line/login-token";
import { randomProof } from "./line/login-link";
import { LINE_JOB_COOKIE } from "./line/vendor-scope";
import { createLineHandlers, LINE_BROWSER_COOKIE, LINE_CSRF_COOKIE, LINE_FLOW_COOKIE, LINE_PKCE_COOKIE } from "./line/login-routes";
import { createLineCodeExchange } from "./line/oauth-exchange";
import { dispatchLinePush, type LinePush } from "./line/quota";
import { createCapturedLineTransport } from "./line/transport";
import { POST as flows } from "../app/api/line/flows/route";
import { POST as exchange } from "../app/api/line/session/route";
import { POST as bind } from "../app/api/line/bind/route";
import { POST as reauth } from "../app/api/line/reauth/route";
import { GET as start } from "../app/api/line/login/start/route";
import { DELETE as unlink } from "../app/api/line/links/[id]/route";
import { DELETE as revoke } from "../app/api/line/identity/route";
import { GET as entry, POST as entryProof } from "../app/(line)/v/liff/route";
import { continueInLine } from "../app/v/[token]/continue-in-line";
import { GET as page } from "../app/(line)/v/liff/job/route";
import { GET as read, POST as report } from "../app/api/line/vendor-job/route";
import { GET as history, POST as accountWrite } from "../app/api/vendor-account/route";
import { POST as staffWrite } from "../app/api/vendor-account-staff/route";

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
const origin = "https://app.condola.app", secret = "b035-local-secret", pepper = "b035-local-pepper", sub = `U${"b".repeat(32)}`;
const meta = { ua: "local-b035", ip: null };
let db: Client, clone: Awaited<ReturnType<typeof cloneTestDatabase>>, channel: string, browser: string, csrf: string;
let admin: Session, foreignAdmin: Session;
const previous = { ...process.env }, savedFetch = globalThis.fetch;
function jwt(patch: Record<string, unknown> = {}) {
 const now = Math.floor(Date.now()/1000);
 const raw = [{ alg: "HS256" }, { iss: "https://access.line.me", aud: "b035-login", sub, iat: now-1, exp: now+300, ...patch }].map(v => Buffer.from(JSON.stringify(v)).toString("base64url")).join(".");
 return `${raw}.${createHmac("sha256",secret).update(raw).digest("base64url")}`;
}
function req(path: string, input?: Record<string, unknown>, opts: { claim?: string; session?: string; browser?: string; csrf?: string; extra?: string; method?: string; origin?: string; bare?: boolean } = {}) {
 return new Request(origin+path, { method: opts.method ?? (input ? "POST" : "GET"), headers: { Origin: opts.origin ?? origin, "Content-Type": "application/json",
  Cookie: opts.bare ? "" : `${LINE_BROWSER_COOKIE}=${opts.browser ?? browser}; ${LINE_CSRF_COOKIE}=${csrf}${opts.claim ? `; ${LINE_JOB_COOKIE}=${opts.claim}` : ""}${opts.session ? `; condola_session=${opts.session}` : ""}${opts.extra ? `; ${opts.extra}` : ""}` },
  ...(input ? { body: JSON.stringify({ csrf: opts.csrf ?? csrf, ...input }) } : {}) });
}
async function parsed(r: Response, status = 200) {
 assert.equal(r.status,status,await r.clone().text()); assert.equal(r.headers.get("Cache-Control"),"no-store");
 assert.equal(r.headers.get("Referrer-Policy"),"no-referrer"); return r.json();
}
const cookieValue = (r: Response, name: string) => new RegExp(`${name}=([^;,]+)`).exec(r.headers.get("set-cookie") ?? "")?.[1];
async function flag(key: string, value: unknown = true, orgValue: unknown = true, org = ORG_ID) {
 await db.query("INSERT INTO platform_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[key,JSON.stringify({ enabled: value, allowed_org_ids: [ORG_ID,ORG2_ID] })]);
 await db.query("UPDATE organizations SET feature_flags=feature_flags||jsonb_build_object($2::text,$3::jsonb) WHERE id=$1",[org,key,JSON.stringify(orgValue)]);
}
async function snapshot() {
 const result: Record<string,unknown> = {};
 const tables = ["auth.users","contacts","org_members","auth_sessions","consents","audit_log","repair_vendor_jobs","repair_vendor_secrets","maintenance_tickets","line_account_links","notifications","deliveries",
  "app.b033_line_flows","app.b033_line_limits","app.b033_line_identities","app.b033_line_sessions","app.b035_vendor_flows","app.b026_vendor_accounts","app.b026_vendor_job_accounts","app.b026_vendor_link_events","app.b033_push_reservations","app.b033_push_fallbacks"];
 for (const table of tables) result[table] = (await db.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') data FROM ${table} t`)).rows[0].data;
 return result;
}
async function issue(staff = admin) {
 const ticketId = randomUUID();
 await db.query(`INSERT INTO maintenance_tickets(id,org_id,property_id,ticket_number,category,title,description,status)
  SELECT $1,$2,id,(SELECT coalesce(max(ticket_number),0)+1 FROM maintenance_tickets WHERE org_id=$2),'plumbing','PRIVATE INTERNAL TITLE','PRIVATE INTERNAL DESCRIPTION','open'
  FROM properties WHERE org_id=$2 ORDER BY id LIMIT 1`,[ticketId,staff.orgId]);
 await flag("vendor_link");
 try {
  const job = await dispatchVendor(staff,ticketId,{ vendorName: `B035-${randomUUID()}`,vendorPhone:"0912111222",vendorTrade:"plumbing",contactWindow:"Monday" },origin);
  await approveVendorSharing(staff,ticketId,job.jobId,{ description:"Approved scoped repair",attachmentIds:[] });
  const contact = (await db.query("SELECT vendor_contact_id FROM repair_vendor_jobs WHERE id=$1",[job.jobId])).rows[0].vendor_contact_id as string;
  return { ...job,ticketId,contact,token:new URL(job.url).pathname.slice(3) };
 } finally { await flag("vendor_link", false); }
}
async function flow(token?: string, input: Record<string,string> = {}) {
 return parsed(await flows(req("/api/line/flows",{ purpose:"login",persona:"vendor",orgId:ORG_ID,...(token ? {jobToken:token}:{}),...input })),201);
}
async function claim(token: string) {
 const f = await flow(token), response = await exchange(req("/api/line/session",{ flow:f.flow,idToken:jwt() }));
 assert.deepEqual(await parsed(response),{next:"/v/liff/job"});
 assert.ok(!cookieValue(response,"condola_session"));
 const credential = cookieValue(response,LINE_JOB_COOKIE); assert.ok(credential);
 assert.match(response.headers.get("set-cookie")!,/HttpOnly/); assert.match(response.headers.get("set-cookie")!,/Secure/); assert.match(response.headers.get("set-cookie")!,/SameSite=lax/i);
 return { credential,flow:f.flow };
}
async function bindJob(job: Awaited<ReturnType<typeof issue>>, org = ORG_ID, staff = admin) {
 await flag("vendor_account",true,true,org);
 const email = await createSession(USERS.tenant,false,meta);
 const invitation = await inviteVendorAccount(staff,job.contact,USERS.tenant); assert.ok(invitation.invitation);
 await claimVendorAccount(email,invitation.invitation);
 await parsed(await reauth(req("/api/line/reauth",{orgId:org,persona:"vendor",password:DEMO_PASSWORD},{session:email})));
 const f = await parsed(await flows(req("/api/line/flows",{purpose:"bind",contactId:job.contact,orgId:org,persona:"vendor"},{session:email})),201);
 const result = await parsed(await bind(req("/api/line/bind",{flow:f.flow,idToken:jwt(),consentTextKey:"line.binding.v1"},{session:email})));
 return {email,linkId:result.linkId as string};
}
async function pending(job: Awaited<ReturnType<typeof issue>>, linkId: string): Promise<LinePush> {
 for (const key of ["line_push","notification_delivery_v2"]) await flag(key);
 await db.query("UPDATE contacts SET email='vendor@local.test' WHERE id=$1",[job.contact]);
 await db.query("SELECT app.b033_org_budget_set($1,$2,date_trunc('month',now() AT TIME ZONE 'Asia/Taipei')::date,180)",[channel,ORG_ID]);
 await db.query("UPDATE app.b033_line_identities SET friend_state=true WHERE id=(SELECT login_identity_id FROM line_account_links WHERE id=$1)",[linkId]);
 await db.query("UPDATE line_account_links SET is_friend=true WHERE id=$1",[linkId]);
 const notificationId = (await db.query("INSERT INTO notifications(org_id,recipient_contact_id,event_type,template_key,locale) VALUES($1,$2,'b035_test','local-test','en') RETURNING id",[ORG_ID,job.contact])).rows[0].id;
 return {orgId:ORG_ID,notificationId,claimId:randomUUID(),channelId:channel,persona:"vendor",to:sub,identityPepper:pepper,messages:[{type:"text",text:"local"}]};
}

test.before(async () => { clone = await cloneTestDatabase(); db = new Client({connectionString:process.env.DATABASE_URL}); await db.connect();
 globalThis.fetch = async () => { throw new Error("B035 HTTP forbidden"); }; });
test.beforeEach(async () => {
 process.env.DEMO_MODE="true"; process.env.ID_DOC_ENCRYPTION_KEY=randomBytes(32).toString("hex"); await resetAndSeed(); process.env.DEMO_MODE="false";
 process.env.LINE_PLATFORM_ENABLED="true"; browser=randomProof();csrf=randomProof();
 for (const org of [ORG_ID,ORG2_ID]) {
  for (const key of ["line_platform","line_vendor_portal","line_tenant_portal","line_owner_portal"]) await flag(key,true,true,org);
  await db.query("UPDATE organizations SET feature_flags=feature_flags||'{\"vendor_dispatch\":true,\"vendor_link\":true}' WHERE id=$1",[org]);
 }
 await flag("vendor_link", false);
 channel=(await db.query("SELECT id FROM line_channels WHERE mode='platform_default' AND is_active")).rows[0].id;
 await db.query("SELECT app.b033_liff_configure($1,'local-tenant','local-vendor','local-owner')",[channel]);
 await db.query("UPDATE line_channels SET login_channel_id='b035-login',login_channel_secret_ref='b035-local' WHERE id=$1",[channel]);
 await db.query("SELECT app.b033_channel_verify($1)",[channel]);
 process.env.LINE_CHANNEL_SECRETS=JSON.stringify({"b035-local":{secret,identityPepper:pepper,destination:"local"}});
 const staff = async (user:string,org:string):Promise<Session> => {
  const token=await createSession(user,false,meta); const sid=(await db.query("SELECT id FROM auth_sessions WHERE token_hash=$1",[lineHash(token)])).rows[0].id;
  return {userId:user,sessionId:sid,orgId:org,liveOrgId:org,kind:"staff",role:"admin",environment:"live",locale:"zh-TW",calendar:"gregorian",email:"local@example.test",name:"Local",leaseId:null};
 };
 admin=await staff(USERS.admin,ORG_ID); foreignAdmin=await staff(USERS.coastAdmin,ORG2_ID);
});
test.after(async () => { globalThis.fetch=savedFetch;if(baselineDir)rmSync(baselineDir,{recursive:true,force:true});await db?.end();await clone?.cleanup();
 for (const key of ["DEMO_MODE","ID_DOC_ENCRYPTION_KEY","LINE_PLATFORM_ENABLED","LINE_CHANNEL_SECRETS"]) { if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key]; } });

test("valid assigned LINE flow opens only its shared job, without account identity promotion",async()=>{
 const job=await issue(), foreign=await issue(foreignAdmin), before=await snapshot();
 const c=await claim(job.token), view=await parsed(await read(req("/api/line/vendor-job",undefined,{claim:c.credential})));
 assert.equal(view.description,"Approved scoped repair");assert.equal(view.capability,"write");assert.ok(Date.parse(view.expiresAt)>Date.now());
 const html=await page(req("/v/liff/job",undefined,{claim:c.credential})); assert.equal(html.status,200);
 const text=JSON.stringify(view)+await html.text();
 for(const value of [job.token,foreign.token,foreign.jobId,foreign.ticketId,"PRIVATE",sub])assert.ok(!text.includes(value));
 for(const table of ["auth.users","org_members","auth_sessions","app.b026_vendor_accounts","app.b026_vendor_job_accounts","app.b033_line_identities","line_account_links"])assert.deepEqual((await snapshot())[table],before[table]);
 await parsed(await read(req(`/api/line/vendor-job?jobId=${foreign.jobId}`,undefined,{claim:c.credential})),404);
 await parsed(await exchange(req("/api/line/session",{flow:c.flow,idToken:jwt()})),409);
});
test("generic vendor entry offers existing Email guidance and unknown LINE identity gets no job/account session",async()=>{
 const before=await snapshot(),res=await entry(req("/v/liff"));assert.equal(res.status,200);assert.match(await res.text(),/href="\/login"/);assert.equal(res.headers.get("set-cookie"),null);assert.deepEqual(await snapshot(),before);
 const f=await flow(),r=await exchange(req("/api/line/session",{flow:f.flow,idToken:jwt()}));assert.deepEqual(await parsed(r),{action:"account_required"});assert.equal(r.headers.get("set-cookie"),null);
 await parsed(await read(req("/api/line/vendor-job")),401);
});
for (const locale of ["zh-TW", "en"]) test(`${locale} job page escapes shared content and reuses only local brand assets when enabled`, async () => {
 const job = await issue(), c = await claim(job.token), previousBrand = process.env.BRAND_V2;
 await db.query("UPDATE repair_vendor_jobs SET shared_description=$2 WHERE id=$1", [job.jobId, '<script>alert("private")</script>']);
 try {
  for (const enabled of [false, true]) {
   process.env.BRAND_V2 = String(enabled);
   const response = await page(req("/v/liff/job", undefined, {claim:c.credential,extra:`condola_locale=${locale}`}));
   assert.equal(response.status,200);
   const html = await response.text();
   assert.ok(html.includes(`lang="${locale}"`));
   assert.ok(html.includes('&lt;script&gt;alert(&quot;private&quot;)&lt;/script&gt;'));
   assert.ok(!html.includes('<script>alert'));
   assert.equal(html.includes('data-brand="v2"'),enabled);
   assert.equal(html.includes('href="/brand/v2/pages/v-job.css"'),enabled);
   assert.equal(html.includes('href="/brand/v2/theme.css"'),enabled);
   assert.ok(!/\b(?:src|href)="https?:/.test(html));
   assert.match(response.headers.get("Content-Security-Policy")!, /style-src 'self'; font-src 'self'/);
  }
 } finally { if (previousBrand === undefined) delete process.env.BRAND_V2; else process.env.BRAND_V2 = previousBrand; }
});
test("job-only cookie cannot read account history, claim account invitations or mutate staff scope",async()=>{
 const j=await issue(),c=await claim(j.token),before=await snapshot();
 for(const token of [undefined,c.credential,j.token]) {
  assert.equal((await history(req("/api/vendor-account",undefined,{claim:c.credential,session:token}))).status,403);
  assert.equal((await accountWrite(req("/api/vendor-account",{action:"claim",invitation:j.token},{claim:c.credential,session:token}))).status,403);
  assert.equal((await staffWrite(req("/api/vendor-account-staff",{action:"correct",jobId:j.jobId,userId:USERS.tenant},{claim:c.credential,session:token,extra:`condola_org=${ORG_ID}`}))).status,403);
 }
 assert.deepEqual(await snapshot(),before);
});
test("account history remains B026-only after LINE job claim and current account removal",async()=>{
 const j=await issue(),other=await issue(),b=await bindJob(j),c=await claim(j.token);
 await syncVendorAccount(b.email);
 const r=await history(req("/api/vendor-account",undefined,{session:b.email,claim:c.credential}));assert.equal(r.status,200);
 const data=await r.json();assert.ok(data.jobs.some((x:{jobId:string})=>x.jobId===j.jobId));assert.ok(!JSON.stringify(data).includes(other.jobId));
 await db.query("UPDATE app.b026_vendor_job_accounts SET user_id=NULL,manual=true WHERE job_id=$1",[j.jobId]);
 const after=await history(req("/api/vendor-account",undefined,{session:b.email,claim:c.credential}));assert.equal((await after.json()).jobs.length,0);
});
for(const mode of ["expired","revoked","reassigned","sharing","hash","archived"] as const)test(`${mode} after LINE authentication denies reads and writes identically without leaks`,async()=>{
 const j=await issue(),c=await claim(j.token);
 if(mode==="expired")await db.query("UPDATE repair_vendor_jobs SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[j.jobId]);
 if(mode==="revoked")await db.query("UPDATE repair_vendor_jobs SET active=false,revoked_at=now() WHERE id=$1",[j.jobId]);
 if(mode==="reassigned")await db.query("UPDATE maintenance_tickets SET assigned_vendor_contact_id=NULL WHERE id=$1",[j.ticketId]);
 if(mode==="sharing")await db.query("UPDATE repair_vendor_jobs SET sharing_approved_at=NULL WHERE id=$1",[j.jobId]);
 if(mode==="hash")await db.query("UPDATE repair_vendor_jobs SET token_hash=$2 WHERE id=$1",[j.jobId,lineHash(randomProof())]);
 if(mode==="archived")await db.query("UPDATE contacts SET archived_at=now() WHERE id=$1",[j.contact]);
 const before=await snapshot();
 assert.deepEqual(await parsed(await read(req("/api/line/vendor-job",undefined,{claim:c.credential})),404),{error:"not_found"});
 assert.deepEqual(await parsed(await report(req("/api/line/vendor-job",{done:"true",cost:"100"},{claim:c.credential})),404),{error:"not_found"});
 assert.deepEqual(await snapshot(),before);
});
test("real re-dispatch to another vendor denies the old claim and new flows from the old token with zero writes",async()=>{
 const j=await issue(),c=await claim(j.token);
 await flag("vendor_link");
 let next:Awaited<ReturnType<typeof dispatchVendor>>;
 try { next=await dispatchVendor(admin,j.ticketId,{vendorName:`B035-next-${randomUUID()}`,vendorPhone:"0912333444",vendorTrade:"plumbing",contactWindow:"Tuesday"},origin); }
 finally { await flag("vendor_link", false); }
 assert.notEqual(next.jobId,j.jobId);
 const ticket=(await db.query("SELECT assigned_vendor_contact_id FROM maintenance_tickets WHERE id=$1",[j.ticketId])).rows[0].assigned_vendor_contact_id;
 assert.ok(ticket);assert.notEqual(ticket,j.contact);
 const before=await snapshot();
 assert.deepEqual(await parsed(await read(req("/api/line/vendor-job",undefined,{claim:c.credential})),404),{error:"not_found"});
 assert.deepEqual(await parsed(await report(req("/api/line/vendor-job",{done:"true",cost:"100"},{claim:c.credential})),404),{error:"not_found"});
 assert.deepEqual(await parsed(await flows(req("/api/line/flows",{purpose:"login",persona:"vendor",jobToken:j.token})),404),{error:"not_found"});
 assert.deepEqual(await parsed(await flows(req("/api/line/flows",{purpose:"login",persona:"vendor",orgId:ORG_ID,jobToken:j.token})),404),{error:"not_found"});
 assert.deepEqual(await snapshot(),before);
});
test("closed job stays read-only; successful report reuses writer and replay creates no second report",async()=>{
 const j=await issue(),c=await claim(j.token);
 await parsed(await report(req("/api/line/vendor-job",{done:"true",cost:"100"},{claim:c.credential})));
 const before=await snapshot();await parsed(await report(req("/api/line/vendor-job",{done:"true",cost:"100"},{claim:c.credential})));assert.deepEqual(await snapshot(),before);
 assert.equal((await parsed(await read(req("/api/line/vendor-job",undefined,{claim:c.credential})))).reported,true);
 await db.query("UPDATE maintenance_tickets SET status='closed' WHERE id=$1",[j.ticketId]);
 assert.equal((await parsed(await read(req("/api/line/vendor-job",undefined,{claim:c.credential})))).capability,"read_only");
 const closed=await snapshot();await parsed(await report(req("/api/line/vendor-job",{done:"true",cost:"200"},{claim:c.credential})),404);assert.deepEqual(await snapshot(),closed);
});
test("scope mismatch, missing token, foreign browser and invalid LINE proof never gain a claim",async()=>{
 const j=await issue(),foreign=await issue(foreignAdmin);
 for(const fields of [{jobToken:randomProof()},{jobToken:j.token,orgId:ORG2_ID},{jobToken:foreign.token,orgId:ORG_ID},{jobToken:j.token,persona:"tenant"},{jobToken:j.token,persona:"owner"},{jobToken:j.token,contactId:j.contact}]) {
  const before=await snapshot();await parsed(await flows(req("/api/line/flows",{purpose:"login",persona:"vendor",orgId:ORG_ID,...fields})),404);assert.deepEqual(await snapshot(),before);
 }
 const f=await flow(j.token);await parsed(await exchange(req("/api/line/session",{flow:f.flow,idToken:jwt()},{browser:randomProof()})),404);
 await parsed(await exchange(req("/api/line/session",{flow:f.flow,idToken:jwt({aud:"wrong"})})),401);
 assert.equal((await db.query("SELECT count(*)::int n FROM app.b035_vendor_flows WHERE claim_hash IS NOT NULL")).rows[0].n,0);
});
test("token revoked between flow and verification cannot create a claim",async()=>{
 const j=await issue(),f=await flow(j.token);await db.query("UPDATE repair_vendor_jobs SET revoked_at=now(),active=false WHERE id=$1",[j.jobId]);
 await parsed(await exchange(req("/api/line/session",{flow:f.flow,idToken:jwt()})),404);
 assert.equal((await db.query("SELECT claim_hash FROM app.b035_vendor_flows")).rows[0].claim_hash,null);
});
test("concurrent flow consumption has one winner and no account session",async()=>{
 const j=await issue(),f=await flow(j.token);const responses=await Promise.all([1,2].map(()=>exchange(req("/api/line/session",{flow:f.flow,idToken:jwt()}))));
 assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);assert.equal((await db.query("SELECT count(*)::int n FROM app.b035_vendor_flows WHERE claim_hash IS NOT NULL")).rows[0].n,1);
});
test("lost WebView cookies reauthenticate at a clean URL; other cookie jars and stale claims fail",async()=>{
 const j=await issue(),f=await flow(j.token);
 const lost=await entry(req(`/v/liff?flow=${f.flow}`,undefined,{bare:true}));assert.equal(lost.status,303);assert.equal(lost.headers.get("location"),"/login");
 const c=await claim(j.token);const res=await page(req("/v/liff/job",undefined,{bare:true}));assert.equal(res.status,303);assert.equal(res.headers.get("location"),"/login");
 await parsed(await read(req("/api/line/vendor-job",undefined,{claim:c.credential,browser:randomProof()})),401);
 await db.query("UPDATE app.b035_vendor_flows SET claim_expires_at=now()-interval '1 second' WHERE claim_hash=$1",[lineHash(c.credential)]);
 await parsed(await read(req("/api/line/vendor-job",undefined,{claim:c.credential})),404);
});
test("OAuth callback reuses state nonce PKCE flow and emits only a cookie job claim",async()=>{
 const j=await issue(),f=await flow(j.token),s=await start(req(`/api/line/login/start?flow=${f.flow}`));assert.equal(s.status,302);
 const url=new URL(s.headers.get("location")!),verifier=cookieValue(s,LINE_PKCE_COOKIE)!;
 const handlers=createLineHandlers({exchangeCode:async()=>jwt({nonce:url.searchParams.get("nonce")})});
 const res=await handlers.callback(req(`/api/line/login/callback?state=${url.searchParams.get("state")}&code=local`,undefined,{extra:`${LINE_FLOW_COOKIE}=${f.flow}; ${LINE_PKCE_COOKIE}=${verifier}`}));
 assert.equal(res.status,303);assert.equal(res.headers.get("location"),origin+"/v/liff/job");assert.ok(cookieValue(res,LINE_JOB_COOKIE));assert.ok(!cookieValue(res,"condola_session"));
});
for(const key of ["line_platform","line_vendor_portal"])for(const [name,value,orgValue] of [["platform false",false,true],["platform malformed","true",true],["org false",true,false],["org malformed",true,"true"]] as const)test(`${key} ${name} OFF gives 404 and zero writes across vendor handlers`,async()=>{
 const j=await issue(),c=await claim(j.token),f=await flow(j.token);await flag(key,value,orgValue);const before=await snapshot();
 assert.equal((await entry(req(`/v/liff?org=${ORG_ID}`))).status,404);
 await parsed(await flows(req("/api/line/flows",{purpose:"login",persona:"vendor",orgId:ORG_ID,jobToken:j.token})),404);
 await parsed(await exchange(req("/api/line/session",{flow:f.flow,idToken:jwt()})),404);
 await parsed(await read(req("/api/line/vendor-job",undefined,{claim:c.credential})),404);
 await parsed(await report(req("/api/line/vendor-job",{done:"true",cost:"100"},{claim:c.credential})),404);
 assert.equal((await page(req("/v/liff/job",undefined,{claim:c.credential}))).status,404);assert.deepEqual(await snapshot(),before);
});
test("environment OFF precedes all reads and writes; missing settings fail closed",async()=>{
 const j=await issue(),c=await claim(j.token);process.env.LINE_PLATFORM_ENABLED="false";const before=await snapshot();
 for(const handler of [entry,read,page])assert.equal((await handler(req("/v/liff",undefined,{claim:c.credential}))).status,404);
 await parsed(await report(req("/api/line/vendor-job",{done:"true",cost:"100"},{claim:c.credential})),404);assert.deepEqual(await snapshot(),before);
 process.env.LINE_PLATFORM_ENABLED="true";await db.query("DELETE FROM platform_settings WHERE key='line_vendor_portal'");const missing=await snapshot();
 await parsed(await read(req("/api/line/vendor-job",undefined,{claim:c.credential})),404);assert.deepEqual(await snapshot(),missing);
});
test("cross-origin and CSRF writes are rejected before job mutation",async()=>{
 const j=await issue(),c=await claim(j.token),before=await snapshot();
 for(const opts of [{origin:"https://foreign.test"},{csrf:"invalid"}])await parsed(await report(req("/api/line/vendor-job",{done:"true",cost:"100"},{claim:c.credential,...opts})),403);
 await parsed(await report(req("/api/line/vendor-job",{done:"true",cost:"100",jobId:randomUUID()},{claim:c.credential})),400);assert.deepEqual(await snapshot(),before);
});
for(const mode of ["org","global"] as const)test(`${mode} unlink keeps queued Email fallback and revokes applicable LINE access, preserving Email recovery`,async()=>{
 const j=await issue(),b=await bindJob(j),c=await claim(j.token),push=await pending(j,b.linkId);
 const f=await flow(),login=await exchange(req("/api/line/session",{flow:f.flow,idToken:jwt()}));await parsed(login);const lineSession=cookieValue(login,"condola_session")!;assert.ok(lineSession);
 const other=await issue(foreignAdmin),otherBinding=await bindJob(other,ORG2_ID,foreignAdmin);
 if(mode==="org")await parsed(await unlink(req("/api/line/links/"+b.linkId,{reason:"user_request"},{session:b.email,method:"DELETE"}),{params:Promise.resolve({id:b.linkId})}));
 else await parsed(await revoke(req("/api/line/identity",{},{session:b.email,method:"DELETE"})));
 await parsed(await read(req("/api/line/vendor-job",undefined,{claim:c.credential})),404);
 const transport=createCapturedLineTransport({mode:"accepted"});const result=await dispatchLinePush(push,transport,{LINE_PLATFORM_ENABLED:"true",LINE_PUSH_QUOTA_GUARD:"true"});
 assert.equal(result.status,"skipped");assert.equal(result.reason,"line_guard");assert.ok("emailClaim" in result && result.emailClaim);assert.equal(transport.calls.length,0);
 assert.equal((await db.query("SELECT status FROM deliveries WHERE notification_id=$1 AND channel='email'",[push.notificationId])).rows[0].status,"queued");
 assert.equal((await db.query("SELECT revoked_at FROM auth_sessions WHERE token_hash=$1",[lineHash(b.email)])).rows[0].revoked_at,null);
 const lineRevoked=(await db.query("SELECT revoked_at FROM auth_sessions WHERE token_hash=$1",[lineHash(lineSession)])).rows[0].revoked_at;
 if(mode==="global")assert.ok(lineRevoked);
 const otherLink=(await db.query("SELECT status FROM line_account_links WHERE id=$1",[otherBinding.linkId])).rows[0].status;assert.equal(otherLink,mode==="org"?"linked":"unlinked");
 assert.equal((await history(req("/api/vendor-account",undefined,{session:b.email}))).status,200);
});
test("global unlink without verified Email recovery cannot revoke identity",async()=>{
 const j=await issue(),b=await bindJob(j);await db.query("UPDATE auth.users SET email_confirmed_at=NULL WHERE id=$1",[USERS.tenant]);const before=await snapshot();
 await parsed(await revoke(req("/api/line/identity",{},{session:b.email,method:"DELETE"})),401);assert.deepEqual(await snapshot(),before);
});
test("private job-flow extension has RLS, client denial and pinned service-only definer",async()=>{
 assert.equal((await db.query("SELECT relrowsecurity FROM pg_class WHERE oid='app.b035_vendor_flows'::regclass")).rows[0].relrowsecurity,true);
 for(const role of ["anon","authenticated"])assert.equal((await db.query("SELECT has_table_privilege($1,'app.b035_vendor_flows','SELECT,INSERT,UPDATE,DELETE') ok",[role])).rows[0].ok,false);
 for(const role of ["anon","authenticated","service_role"])assert.equal((await db.query("SELECT has_function_privilege($1,'app.b035_vendor_flow_guard()','EXECUTE') ok",[role])).rows[0].ok,role==="service_role");
 const config=(await db.query("SELECT proconfig,prosecdef FROM pg_proc WHERE oid='app.b035_vendor_flow_guard()'::regprocedure")).rows[0];assert.equal(config.prosecdef,true);assert.ok(config.proconfig.includes("search_path=pg_catalog, public, app"));
 const j=await issue(),f=await flow(j.token),other=await issue();await assert.rejects(db.query("UPDATE app.b035_vendor_flows SET job_id=$2 WHERE flow_id=(SELECT id FROM app.b033_line_flows WHERE flow_hash=$1)",[lineHash(f.flow),other.jobId]),/not_found/);
});

test("anonymous claim cannot survive subsequent account binding and org unlink",async()=>{
 const j=await issue(),c=await claim(j.token),b=await bindJob(j);
 await parsed(await read(req("/api/line/vendor-job",undefined,{claim:c.credential})),404);
 await parsed(await unlink(req("/api/line/links/"+b.linkId,{reason:"user_request"},{session:b.email,method:"DELETE"}),{params:Promise.resolve({id:b.linkId})}));
 const before=await snapshot();
 await parsed(await read(req("/api/line/vendor-job",undefined,{claim:c.credential})),404);
 await parsed(await report(req("/api/line/vendor-job",{done:"true",cost:"100"},{claim:c.credential})),404);
 assert.deepEqual(await snapshot(),before);
});
for(const mode of ["missing","null","missing enabled","empty allowlist","malformed allowlist","org missing"] as const)test(`strict vendor setting ${mode} cannot create or use a job claim`,async()=>{
 const j=await issue(),c=await claim(j.token),f=await flow(j.token);
 if(mode==="missing")await db.query("DELETE FROM platform_settings WHERE key='line_vendor_portal'");
 else if(mode==="org missing")await db.query("UPDATE organizations SET feature_flags=feature_flags-'line_vendor_portal' WHERE id=$1",[ORG_ID]);
 else await db.query("UPDATE platform_settings SET value=$1 WHERE key='line_vendor_portal'",[JSON.stringify(mode==="null"?null:mode==="missing enabled"?{}:{enabled:true,allowed_org_ids:mode==="empty allowlist"?[]:{}})]);
 const before=await snapshot();
 await parsed(await flows(req("/api/line/flows",{purpose:"login",persona:"vendor",orgId:ORG_ID,jobToken:j.token})),404);
 await parsed(await exchange(req("/api/line/session",{flow:f.flow,idToken:jwt()})),404);
 await parsed(await read(req("/api/line/vendor-job",undefined,{claim:c.credential})),404);
 await parsed(await report(req("/api/line/vendor-job",{done:"true",cost:"100"},{claim:c.credential})),404);
 assert.equal((await entry(req(`/v/liff?flow=${f.flow}`,undefined,{bare:true}))).status,404);
 assert.deepEqual(await snapshot(),before);
});
test("expired flow and claim cannot be replayed even with a valid LINE token",async()=>{
 const j=await issue(),f=await flow(j.token);await db.query("UPDATE app.b033_line_flows SET expires_at=now()-interval '1 second' WHERE flow_hash=$1",[lineHash(f.flow)]);
 const before=await snapshot();await parsed(await exchange(req("/api/line/session",{flow:f.flow,idToken:jwt()})),410);assert.deepEqual(await snapshot(),before);
});

for(const key of ["line_platform","line_vendor_portal"])test(`${key} OFF rejects bare cookie-free entry/read/write before recovery`,async()=>{
 await flag(key,false);const before=await snapshot();
 for(const handler of [entry,page,read])assert.equal((await handler(req("/v/liff/job",undefined,{bare:true}))).status,404);
 await parsed(await report(req("/api/line/vendor-job",{done:"true",cost:"100"},{bare:true})),404);
 assert.deepEqual(await snapshot(),before);
});

test("anonymous report waits for concurrent real binding and rechecks identity after commit",async t=>{
 const j=await issue(),c=await claim(j.token);
 const original=Client.prototype.query;
 let release!:()=>void,ready!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const bound=new Promise<void>(resolve=>{ready=resolve;});
 const spy=t.mock.method(Client.prototype,"query",async function(this:Client,...args:unknown[]){
  const result=await Reflect.apply(original,this,args);
  if(String(args[0]).startsWith("SELECT app.b033_link(")){ready();await gate;}
  return result;
 });
 const binding=bindJob(j);
 let response:Promise<Response>|undefined;
 try {
  await Promise.race([bound,binding.then(()=>{throw new Error("binding did not reach shared gateway");})]);
  response=report(req("/api/line/vendor-job",{done:"true",cost:"100"},{claim:c.credential}));
  let waiting=false;
  for(let n=0;n<60;n++){
   waiting=(await db.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE '%$1::text||$2::text,33%') yes")).rows[0].yes;
   if(waiting)break;
   await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(waiting,true,"report must wait for the B033 provider identity lock");
 } finally {release();spy.mock.restore();}
 await binding;assert.ok(response);await parsed(await response,404);
 assert.equal((await db.query("SELECT reported_at FROM repair_vendor_jobs WHERE id=$1",[j.jobId])).rows[0].reported_at,null);
});

const pageDir = new URL("../app/v/[token]/", import.meta.url);
let baselineDir: string | undefined;
/** The pre-B-035 page: the current source with exactly the B-035 entry edits reverted (count-checked). */
async function preB035Page() {
 let source = readFileSync(new URL("page.tsx", pageDir), "utf8");
 const revert = (pattern: RegExp, replacement: string, count: number) => {
  const hits = source.match(pattern)?.length ?? 0; assert.equal(hits, count, String(pattern)); source = source.replace(pattern, replacement);
 };
 revert(/^import \{ vendorLineEntryEnabled \} from "@\/server\/line\/vendor-entry";\n/gm, "", 1);
 revert(/^import \{ VendorLineEntry \} from "\.\/vendor-line-entry";\n/gm, "", 1);
 revert(/^  \/\/ B-035:[^\n]*\n  const showLine = [^\n]*\n  const lineEntry = [^\n]*\n[^\n]*\n    : null;\n/gm, "", 1);
 revert(/\{lineEntry \? <>(<VendorNotificationCenterEntry [^>]*\/>)\{lineEntry\}<\/>\n +: \1\}/g, "$1", 2);
 assert.doesNotMatch(source, /lineEntry|showLine|VendorLineEntry|vendor-entry/);
 source = source.replace(/from "\.\/([^"]+)"/g, (_, file: string) => `from ${JSON.stringify(fileURLToPath(new URL(file, pageDir)))}`);
 baselineDir ??= mkdtempSync(join(tmpdir(), "b035-page-"));
 const file = join(baselineDir, "page.tsx"); writeFileSync(file, source);
 return import(pathToFileURL(file).href);
}
/** Renders the real /v/[token] server page outside Next with the request cookie store it reads. */
async function vendorPageHtml(token: string, locale = "zh-TW", baseline = false) {
 (globalThis as Record<string, unknown>).React ??= React;
 const [{ workAsyncStorage }, { workUnitAsyncStorage }, { RequestCookies }, { RequestCookiesAdapter }, { AppRouterContext }, { renderToReadableStream }, { default: VendorJobPage }] = await Promise.all([
  import("next/dist/server/app-render/work-async-storage.external"), import("next/dist/server/app-render/work-unit-async-storage.external"),
  import("next/dist/server/web/spec-extension/cookies"), import("next/dist/server/web/spec-extension/adapters/request-cookies"),
  import("next/dist/shared/lib/app-router-context.shared-runtime"), import("react-dom/server.edge"), baseline ? preB035Page() : import("../app/v/[token]/page")]);
 const cookies = RequestCookiesAdapter.seal(new RequestCookies(new Headers({ cookie: `condola_locale=${locale}` })));
 const router = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} };
 return workAsyncStorage.run({ route: "/v/[token]" } as never, () => workUnitAsyncStorage.run({ type: "private-cache", cookies } as never, async () => {
  const element = await VendorJobPage({ params: Promise.resolve({ token }), searchParams: Promise.resolve({}) });
  const stream = await renderToReadableStream(React.createElement(AppRouterContext.Provider, { value: router as never }, element));
  await stream.allReady;
  return new Response(stream).text();
 }));
}
const LINE_ENTRY = /<div data-testid="vendor-line-entry">[\s\S]*?<\/button><\/div>/;
/** One browser: same-origin requests carry only this jar; every exported handler sees exactly what a browser would send. */
function browserJar() {
 const jar = new Map<string, string>(), calls: { path: string; init: RequestInit }[] = [];
 const header = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
 const absorb = (r: Response) => { for (const line of r.headers.getSetCookie()) {
  const pair = line.split(";")[0], at = pair.indexOf("="), key = pair.slice(0, at), value = pair.slice(at + 1);
  if (!value || /Max-Age=0/i.test(line)) jar.delete(key); else jar.set(key, value);
 } };
 const routes: Record<string, (r: Request) => Promise<Response>> = { "/v/liff": entryProof, "/api/line/flows": flows, "/api/line/session": exchange, "/api/line/vendor-job": report };
 const fetch = async (path: string, init: RequestInit) => {
  calls.push({ path, init });
  assert.match(path, /^\/(?!\/)/); const handler = routes[path]; assert.ok(handler, path);
  const headers = new Headers(init.headers); headers.set("Origin", origin); headers.set("Sec-Fetch-Site", "same-origin"); headers.set("Cookie", header());
  const response = await handler(new Request(origin + path, { method: init.method, headers, body: init.body as string }));
  absorb(response); return response;
 };
 const get = async (handler: (r: Request) => Promise<Response>, path: string) => {
  const response = await handler(new Request(origin + path, { headers: { Cookie: header() } })); absorb(response); return response;
 };
 return { jar, calls, fetch, get };
}

test("existing /v/[token] continue-in-LINE entry opens only its job via proof, flow, bootstrap and exchange; token stays in POST bodies",async()=>{
 const j=await issue(),other=await issue(),before=await snapshot();
 const html=await vendorPageHtml(j.token,"en");
 const entryHtml=LINE_ENTRY.exec(html)?.[0];assert.ok(entryHtml);assert.ok(entryHtml.includes("Continue in LINE"));assert.ok(!entryHtml.includes(j.token));
 const browser=browserJar(),navigated:string[]=[];
 assert.equal(await continueInLine(j.token,{fetch:browser.fetch,navigate:path=>navigated.push(path)}),true);
 assert.deepEqual(browser.calls.map(c=>c.path),["/v/liff","/api/line/flows"]);
 for(const call of browser.calls){
  assert.equal(call.init.method,"POST");assert.equal(call.init.referrerPolicy,"no-referrer");assert.equal(call.init.credentials,"same-origin");
  assert.ok(!call.path.includes(j.token));assert.equal(JSON.parse(String(call.init.body)).jobToken,j.token);
 }
 assert.deepEqual(Object.keys(JSON.parse(String(browser.calls[0].init.body))),["jobToken"]);
 assert.equal(navigated.length,1);assert.match(navigated[0],/^\/v\/liff\?flow=[\w-]{43}$/);assert.ok(!navigated[0].includes(j.token));
 for(const value of browser.jar.values())assert.ok(!value.includes(j.token));
 const boot=await browser.get(entry,navigated[0]);assert.equal(boot.status,200);const bootHtml=await boot.text();assert.ok(!bootHtml.includes(j.token));
 const config=JSON.parse(/<script type="application\/json" id="line-bootstrap">([^<]*)<\/script>/.exec(bootHtml)![1]);
 assert.equal(config.flow,new URL(origin+navigated[0]).searchParams.get("flow"));assert.equal(config.csrf,browser.jar.get(LINE_CSRF_COOKIE));
 const urls:string[]=[],next:string[]=[];
 await runInNewContext(readFileSync("public/line-bootstrap.js","utf8"),{
  document:{getElementById:()=>({textContent:JSON.stringify(config)})},
  window:{liff:{init:async()=>{},isLoggedIn:()=>true,getIDToken:()=>jwt()}},
  history:{replaceState:(_:unknown,__:string,url:string)=>urls.push(url)},location:{origin,pathname:"/v/liff",assign:(path:string)=>next.push(path)},
  fetch:browser.fetch,
 });
 assert.deepEqual(next,["/v/liff/job"]);for(const url of urls)assert.ok(!url.includes(j.token));
 assert.deepEqual(browser.calls.slice(2).map(c=>c.path),["/api/line/session"]);
 assert.ok(browser.jar.get(LINE_JOB_COOKIE));assert.ok(!browser.jar.has("condola_session"));
 const jobPage=await browser.get(page,"/v/liff/job");assert.equal(jobPage.status,200);const jobHtml=await jobPage.text();
 const view=await parsed(await browser.get(read,"/api/line/vendor-job"));assert.equal(view.capability,"write");
 for(const value of [j.token,other.token,other.jobId,"PRIVATE"])assert.ok(!(jobHtml+JSON.stringify(view)).includes(value));
 assert.equal((await db.query("SELECT v.job_id FROM app.b035_vendor_flows v JOIN app.b033_line_flows f ON f.id=v.flow_id WHERE f.flow_hash=$1",[lineHash(config.flow)])).rows[0].job_id,j.jobId);
 await parsed(await browser.fetch("/api/line/vendor-job",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({csrf:browser.jar.get(LINE_CSRF_COOKIE),done:"true",cost:"100"})}));
 const reported=(await db.query("SELECT id,reported_at IS NOT NULL done FROM repair_vendor_jobs WHERE id=ANY($1)",[[j.jobId,other.jobId]])).rows;
 assert.deepEqual(Object.fromEntries(reported.map(r=>[r.id,r.done])),{[j.jobId]:true,[other.jobId]:false});
 const after=await snapshot();
 for(const table of ["auth.users","org_members","auth_sessions","app.b026_vendor_accounts","app.b026_vendor_job_accounts","app.b033_line_identities","line_account_links"])assert.deepEqual(after[table],before[table]);
});
test("job-entry proof is same-origin, body-only and write-free; OFF or invalid tokens return 404 with zero writes",async()=>{
 const j=await issue();
 const proof=(input:unknown,headers:Record<string,string>={},path="/v/liff")=>entryProof(new Request(origin+path,{method:"POST",headers:{Origin:origin,"Content-Type":"application/json",...headers},body:JSON.stringify(input)}));
 let before=await snapshot();
 const ok=await proof({jobToken:j.token});const value=await parsed(ok);assert.match(value.csrf,/^[\w-]{43}$/);assert.ok(!JSON.stringify(value).includes(j.token));
 assert.equal(cookieValue(ok,LINE_CSRF_COOKIE),value.csrf);assert.ok(cookieValue(ok,LINE_BROWSER_COOKIE));assert.deepEqual(await snapshot(),before);
 for(const [input,headers,status,path] of [[{jobToken:j.token},{Origin:"https://foreign.test"},403],[{jobToken:j.token},{"Sec-Fetch-Site":"cross-site"},403],
  [{jobToken:j.token,orgId:ORG_ID},{},400],[{jobToken:randomProof()},{},404],[{},{},400],[{jobToken:j.token},{},404,`/v/liff?jobToken=${j.token}`]] as const){
  const r=await proof(input,headers,path);assert.equal(r.status,status);assert.equal(r.headers.get("set-cookie"),null);
 }
 assert.deepEqual(await snapshot(),before);
 for(const key of ["line_platform","line_vendor_portal"]){await flag(key,false);before=await snapshot();
  const r=await proof({jobToken:j.token});assert.equal(r.status,404);assert.equal(r.headers.get("set-cookie"),null);assert.deepEqual(await snapshot(),before);await flag(key);}
 process.env.LINE_PLATFORM_ENABLED="false";before=await snapshot();
 assert.equal((await proof({jobToken:j.token})).status,404);assert.deepEqual(await snapshot(),before);
});
for(const branch of ["classic","enhanced"] as const)test(`${branch} /v/[token] page HTML is byte-identical to the pre-B-035 page whenever vendor LINE gates are OFF`,async()=>{
 const j=await issue();await flag("vendor_link", branch==="enhanced");
 try {
  for(const [locale,label] of [["zh-TW","在 LINE 中繼續"],["en","Continue in LINE"]]){
   const baseline=await vendorPageHtml(j.token,locale,true);
   assert.equal(baseline.includes('data-testid="vendor-link-status"'),branch==="enhanced");assert.match(baseline,/data-testid="vendor-address"/);assert.ok(!baseline.includes("vendor-line"));
   const on=await vendorPageHtml(j.token,locale),entryHtml=LINE_ENTRY.exec(on)?.[0];assert.ok(entryHtml);assert.ok(entryHtml.includes(label));
   assert.equal(on.replace(entryHtml,""),baseline);
   const off:[string,()=>Promise<void>,()=>Promise<void>][]=[
    ["env",async()=>{process.env.LINE_PLATFORM_ENABLED="false";},async()=>{process.env.LINE_PLATFORM_ENABLED="true";}],
    ["platform",()=>flag("line_platform",false),()=>flag("line_platform")],["org",()=>flag("line_vendor_portal",true,false),()=>flag("line_vendor_portal")],
    ["malformed",()=>flag("line_vendor_portal","true",true),()=>flag("line_vendor_portal")],
   ];
   for(const [name,disable,restore] of off){await disable();try{
    const before=await snapshot();assert.equal(await vendorPageHtml(j.token,locale),baseline,`${branch} ${locale} ${name}`);
    for(const table of ["app.b033_line_flows","app.b033_line_limits","app.b035_vendor_flows","auth_sessions"])assert.deepEqual((await snapshot())[table],before[table]);
   }finally{await restore();}}
   assert.equal(await vendorPageHtml(j.token,locale),on);
  }
 } finally {await flag("vendor_link", false);}
});

test("staff-dispatched job link: web OAuth via mocked LINE token endpoint emits only a job claim",async()=>{
 const j=await issue(),f=await flow(j.token),s=await start(req(`/api/line/login/start?flow=${f.flow}`));assert.equal(s.status,302);
 const url=new URL(s.headers.get("location")!),verifier=cookieValue(s,LINE_PKCE_COOKIE)!;
 const loginId=(await db.query("SELECT login_channel_id FROM line_channels WHERE id=$1",[channel])).rows[0].login_channel_id;
 let calls=0;
 const mockFetch=async(input:string|URL|Request,init?:RequestInit)=>{
  calls++;assert.equal(input,"https://api.line.me/oauth2/v2.1/token");assert.equal(init?.method,"POST");
  const form=new URLSearchParams(String(init?.body));
  assert.equal(form.get("grant_type"),"authorization_code");assert.equal(form.get("code"),"local");
  assert.equal(form.get("redirect_uri"),`${origin}/api/line/login/callback`);assert.equal(form.get("client_id"),loginId);
  assert.equal(form.get("client_secret"),secret);assert.equal(form.get("code_verifier"),verifier);
  return new Response(JSON.stringify({id_token:jwt({nonce:url.searchParams.get("nonce")})}),{status:200,headers:{"content-type":"application/json"}});
 };
 const resolveSecret=async(ref:string)=>{assert.equal(ref,"b035-local");return{secret,identityPepper:pepper,destination:"local"};};
 const handlers=createLineHandlers({exchangeCode:createLineCodeExchange({fetch:mockFetch,resolveSecret}),resolveSecret});
 const res=await handlers.callback(req(`/api/line/login/callback?state=${url.searchParams.get("state")}&code=local`,undefined,{extra:`${LINE_FLOW_COOKIE}=${f.flow}; ${LINE_PKCE_COOKIE}=${verifier}`}));
 assert.equal(res.status,303);assert.equal(res.headers.get("location"),origin+"/v/liff/job");
 assert.ok(cookieValue(res,LINE_JOB_COOKIE));assert.ok(!cookieValue(res,"condola_session"));assert.equal(calls,1);
});

test("vendor_link two-gate: platform_settings OFF denies sharing approval and LINE job claim; allowlisted ON works",async()=>{
 try {
  // Dispatch a vendor (needs the gate via the test override) but DO NOT approve sharing yet.
  const ticketId=randomUUID();
  await db.query(`INSERT INTO maintenance_tickets(id,org_id,property_id,ticket_number,category,title,description,status)
   SELECT $1,$2,id,(SELECT coalesce(max(ticket_number),0)+1 FROM maintenance_tickets WHERE org_id=$2),'plumbing','PRIVATE INTERNAL TITLE','PRIVATE INTERNAL DESCRIPTION','open'
   FROM properties WHERE org_id=$2 ORDER BY id LIMIT 1`,[ticketId,admin.orgId]);
  await flag("vendor_link");
  const job=await dispatchVendor(admin,ticketId,{ vendorName:`B035-${randomUUID()}`,vendorPhone:"0912111222",vendorTrade:"plumbing",contactWindow:"Monday" },origin);
  const token=new URL(job.url).pathname.slice(3);

  // Org feature flag is ON; only the platform_settings gate varies below.
  await db.query(`UPDATE organizations SET feature_flags = coalesce(feature_flags,'{}')||'{"vendor_link":true}' WHERE id=$1`,[ORG_ID]);

  // OFF case A: no platform_settings row -> approval forbidden; unapproved job cannot start a LINE flow (404).
  await db.query("DELETE FROM platform_settings WHERE key='vendor_link'");
  await assert.rejects(approveVendorSharing(admin,ticketId,job.jobId,{ description:"Approved scoped repair",attachmentIds:[] }),(e:unknown)=>(e as {key?:string}).key==="errors.forbidden");
  await parsed(await flows(req("/api/line/flows",{ purpose:"login",persona:"vendor",orgId:ORG_ID,jobToken:token })),404);

  // OFF case B: allowlist contains a different org -> approval still rejected.
  await db.query("INSERT INTO platform_settings(key,value) VALUES('vendor_link',$1::jsonb) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value",[JSON.stringify({ enabled:true,allowed_org_ids:[randomUUID()] })]);
  await assert.rejects(approveVendorSharing(admin,ticketId,job.jobId,{ description:"Approved scoped repair",attachmentIds:[] }),(e:unknown)=>(e as {key?:string}).key==="errors.forbidden");

  // ON: allowlist contains this org -> approval + LINE claim succeed.
  await db.query("INSERT INTO platform_settings(key,value) VALUES('vendor_link',$1::jsonb) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value",[JSON.stringify({ enabled:true,allowed_org_ids:[ORG_ID] })]);
  await approveVendorSharing(admin,ticketId,job.jobId,{ description:"Approved scoped repair",attachmentIds:[] });
  await claim(token);
 } finally {
  await db.query("DELETE FROM platform_settings WHERE key='vendor_link'");
 }
});

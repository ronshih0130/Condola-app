import "next/dist/server/node-environment-baseline";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import { resetAndSeed } from "./seed";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { createSession } from "./auth";
import { approveVendorSharing, dispatchVendor } from "./vendor-repair";
import { syncVendorAccount, vendorAccountHistory, vendorAccountLinkEvents } from "./vendor-accounts";
import type { Session } from "./types";
import { lineHash } from "./line/login-token";
import { providerUserHash } from "./line/webhook";
import { randomProof } from "./line/login-link";
import { createLineHandlers, LINE_BROWSER_COOKIE, LINE_CSRF_COOKIE, LINE_FLOW_COOKIE, LINE_PKCE_COOKIE } from "./line/login-routes";
import { GET as review, POST as act } from "../app/(line)/v/link/route";
import { POST as flows } from "../app/api/line/flows/route";
import { POST as exchange } from "../app/api/line/session/route";
import { GET as start } from "../app/api/line/login/start/route";
import { GET as history } from "../app/api/vendor-account/route";
import { vendorLineMatchCopy as copy } from "../i18n/lanes/vendor-line-match";

// Operator only: migrate the full chain (including B101) into a disposable local DB first.
disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
const origin="https://app.condola.app", secret="b101-test-secret", pepper="b101-test-pepper", sub=`U${"b".repeat(32)}`;
const meta={ua:"local-b101",ip:null};
let db:Client,clone:Awaited<ReturnType<typeof cloneTestDatabase>>,channel:string,browser:string,csrf:string;
let admin:Session,foreignAdmin:Session;
const previous={...process.env},savedFetch=globalThis.fetch;
function jwt(patch: Record<string, unknown> = {}) {
 const now = Math.floor(Date.now()/1000);
 const raw = [{ alg: "HS256" }, { iss: "https://access.line.me", aud: "b101-login", sub, iat: now-1, exp: now+300, ...patch }].map(v => Buffer.from(JSON.stringify(v)).toString("base64url")).join(".");
 return `${raw}.${createHmac("sha256",secret).update(raw).digest("base64url")}`;
}
const cookieValue = (r: Response, name: string) => new RegExp(`${name}=([^;,]+)`).exec(r.headers.get("set-cookie") ?? "")?.[1];
async function flag(key: string, value: unknown = true, orgValue: unknown = true, org = ORG_ID) {
 await db.query("INSERT INTO platform_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[key,JSON.stringify({ enabled: value, allowed_org_ids: [ORG_ID,ORG2_ID] })]);
 await db.query("UPDATE organizations SET feature_flags=feature_flags||jsonb_build_object($2::text,$3::jsonb) WHERE id=$1",[org,key,JSON.stringify(orgValue)]);
}
function req(path:string,input?:Record<string,string>,opts:{flow?:string;session?:string;browser?:string;extra?:string;origin?:string}={}) {
 return new Request(origin+path,{method:input?"POST":"GET",headers:{Origin:opts.origin??origin,"Content-Type":"application/json",
 Cookie:`${LINE_BROWSER_COOKIE}=${opts.browser??browser}; ${LINE_CSRF_COOKIE}=${csrf}${opts.flow?`; ${LINE_FLOW_COOKIE}=${opts.flow}`:""}${opts.session?`; condola_session=${opts.session}`:""}${opts.extra?`; ${opts.extra}`:""}`},
 ...(input?{body:JSON.stringify({csrf,...input})}:{})});
}
async function parsed(r:Response,status=200) {assert.equal(r.status,status,await r.clone().text());return r.json();}
async function snapshot() {
 const result:Record<string,unknown>={};
 for(const table of ["auth.users","app.b026_vendor_accounts","app.b026_vendor_job_accounts","app.b026_vendor_link_events","app.b033_line_identities","line_account_links","auth_sessions","notifications","deliveries","app.b033_push_reservations","app.b101_vendor_confirmations"])
  result[table]=(await db.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') data FROM ${table} t`)).rows[0].data;
 return result;
}
async function issue(staff = admin, vendorId?: string) {
 const ticketId = randomUUID();
 await db.query(`INSERT INTO maintenance_tickets(id,org_id,property_id,ticket_number,category,title,description,status)
  SELECT $1,$2,id,(SELECT coalesce(max(ticket_number),0)+1 FROM maintenance_tickets WHERE org_id=$2),'plumbing','PRIVATE INTERNAL TITLE','PRIVATE INTERNAL DESCRIPTION','open'
  FROM properties WHERE org_id=$2 AND archived_at IS NULL ORDER BY id LIMIT 1`,[ticketId,staff.orgId]);
 await flag("vendor_link");
 try {
  const job = await dispatchVendor(staff,ticketId,{ vendorId, vendorName: vendorId ? "" : `B101-${randomUUID()}`,vendorPhone:"0912111222",vendorTrade:"plumbing",contactWindow:"Monday" },origin);
  await approveVendorSharing(staff,ticketId,job.jobId,{ description:"Approved scoped repair",attachmentIds:[] });
  const contact = (await db.query("SELECT vendor_contact_id FROM repair_vendor_jobs WHERE id=$1",[job.jobId])).rows[0].vendor_contact_id as string;
  return { ...job,ticketId,contact,token:new URL(job.url).pathname.slice(3) };
 } finally { /* test fixture keeps sharing enabled */ }
}
test.before(async () => { clone = await cloneTestDatabase(); db = new Client({connectionString:process.env.DATABASE_URL}); await db.connect();
 globalThis.fetch = async () => { throw new Error("B101 HTTP forbidden"); }; });
test.beforeEach(async () => {
 process.env.DEMO_MODE="true"; process.env.ID_DOC_ENCRYPTION_KEY=randomBytes(32).toString("hex"); await resetAndSeed(); process.env.DEMO_MODE="false";
 process.env.LINE_PLATFORM_ENABLED="true"; process.env.BRAND_V2="false"; browser=randomProof();csrf=randomProof();
 for (const org of [ORG_ID,ORG2_ID]) {
  for (const key of ["line_platform","line_vendor_portal","line_tenant_portal","line_owner_portal"]) await flag(key,true,true,org);
  await db.query("UPDATE organizations SET feature_flags=feature_flags||'{\"vendor_dispatch\":true,\"vendor_link\":true}' WHERE id=$1",[org]);
 }
 await flag("vendor_link"); await flag("vendor_account");
 await db.query(`UPDATE organizations SET feature_flags=feature_flags||'{"brand_v2":true,"brand_v3":true}' WHERE id=$1`,[ORG_ID]);
 channel=(await db.query("SELECT id FROM line_channels WHERE mode='platform_default' AND is_active")).rows[0].id;
 await db.query("SELECT app.b033_liff_configure($1,'local-tenant','local-vendor','local-owner')",[channel]);
 await db.query("UPDATE line_channels SET login_channel_id='b101-login',login_channel_secret_ref='b101-local' WHERE id=$1",[channel]);
 await db.query("SELECT app.b033_channel_verify($1)",[channel]);
 process.env.LINE_CHANNEL_SECRETS=JSON.stringify({"b101-local":{secret,identityPepper:pepper,destination:"local"}});
 const staff = async (user:string,org:string):Promise<Session> => {
  const token=await createSession(user,false,meta); const sid=(await db.query("SELECT id FROM auth_sessions WHERE token_hash=$1",[lineHash(token)])).rows[0].id;
  return {userId:user,sessionId:sid,orgId:org,liveOrgId:org,kind:"staff",role:"admin",environment:"live",locale:"zh-TW",calendar:"gregorian",email:"local@example.test",name:"Local",leaseId:null};
 };
 admin=await staff(USERS.admin,ORG_ID); foreignAdmin=await staff(USERS.coastAdmin,ORG2_ID);
});
test.after(async()=>{globalThis.fetch=savedFetch;await db?.end();await clone?.cleanup();
 for(const key of ["DEMO_MODE","ID_DOC_ENCRYPTION_KEY","LINE_PLATFORM_ENABLED","LINE_CHANNEL_SECRETS","BRAND_V2"]){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}});

async function flow(token?:string,orgId=ORG_ID) {
 return parsed(await flows(req("/api/line/flows",{purpose:"login",persona:"vendor",orgId,vendorMatch:"true",...(token?{jobToken:token}:{})})),201);
}
async function oauth(f:{flow:string},subject=sub,opts:{session?:string;browser?:string;state?:string;nonce?:string;verifier?:string;aud?:string;expired?:boolean;cancel?:boolean;beforeCallback?:()=>Promise<void>}={}) {
 const started=await start(req(`/api/line/login/start?flow=${f.flow}`)); assert.equal(started.status,302);
 const auth=new URL(started.headers.get("location")!),verifier=cookieValue(started,LINE_PKCE_COOKIE)!;
 if(opts.beforeCallback)await opts.beforeCallback();
 const handlers=createLineHandlers({resolveSecret:async()=>({secret,identityPepper:pepper,destination:"local"}),
 exchangeCode:async()=>jwt({sub:subject,nonce:opts.nonce??auth.searchParams.get("nonce"),aud:opts.aud??"b101-login",...(opts.expired?{exp:1}:{})})});
 return handlers.callback(req(`/api/line/login/callback?state=${opts.state??auth.searchParams.get("state")}&${opts.cancel?"error=access_denied":"code=mock"}`,undefined,
  {flow:f.flow,session:opts.session,browser:opts.browser,extra:`${LINE_PKCE_COOKIE}=${opts.verifier??verifier}`}));
}
async function matched(token?:string,subject=sub) {
 const f=await flow(token),r=await oauth(f,subject);
 assert.equal(r.status,303,await r.clone().text());assert.equal(r.headers.get("location"),origin+"/v/link");
 assert.ok(!cookieValue(r,"condola_session"));
 return f;
}
async function list(f:{flow:string}) {
 const r=await review(req("/v/link",undefined,f));assert.equal(r.status,200);const text=await r.text();
 assert.ok(!text.includes('id="match-review" hidden'),text);return text;
}
async function rejected(f:{flow:string},subject=sub,opts:Parameters<typeof oauth>[2]={}) {
 const before=await snapshot(),r=await oauth(f,subject,opts);
 assert.equal(r.status,303,await r.clone().text());assert.equal(r.headers.get("location"),origin+"/v/link?error=1");
 assert.ok(!cookieValue(r,"condola_session"));assert.deepEqual(await snapshot(),before);
}

test("VEN-31-AC2/3: first sign-in binds, audits, lists only exact org/contact open jobs; no session/history or message before confirmation",async()=>{
 const j=await issue(),same=await issue(admin,j.contact),other=await issue(),foreign=await issue(foreignAdmin);
 const before=await snapshot(),f=await matched(j.token),html=await list(f);
 for(const id of [j.jobId,same.jobId])assert.ok(html.includes(`data-job="${id}"`));
 for(const id of [other.jobId,foreign.jobId,"PRIVATE INTERNAL"])assert.ok(!html.includes(id));
 assert.ok(html.includes(copy.title));assert.ok(html.includes(copy.remove));assert.ok(html.includes(copy.continue));
 const a=(await db.query("SELECT * FROM app.b026_vendor_accounts WHERE contact_id=$1",[j.contact])).rows[0];assert.ok(a.line_identity_id);assert.equal(a.invite_id,null);
 assert.equal((await db.query("SELECT count(*)::int n FROM app.b026_vendor_job_accounts")).rows[0].n,0);
 const events=await vendorAccountLinkEvents(admin,j.jobId);assert.ok(events.some(e=>e.reason==="line_first_binding"));
 assert.equal((await db.query("SELECT count(*)::int n FROM audit_log WHERE event_type='vendor_line_first_binding' AND row_id=$1",[j.contact])).rows[0].n,1);
 assert.equal((await history(req("/api/vendor-account",undefined,{flow:f.flow}))).status,403);
 assert.equal((await review(req("/v/link",undefined,{flow:j.token}))).status,404);
 const link=(await db.query("SELECT notification_opt_in,is_friend FROM line_account_links WHERE login_identity_id=$1",[a.line_identity_id])).rows[0];assert.deepEqual(link,{notification_opt_in:false,is_friend:false});
 const after=await snapshot();for(const key of ["auth_sessions","notifications","deliveries","app.b033_push_reservations"])assert.deepEqual(after[key],before[key]);
});
test("VEN-15-AC3/4: durable removal, no unseen/foreign attachments; existing portal sync respects tombstones and confirmation",async()=>{
 const j=await issue(),same=await issue(admin,j.contact),other=await issue(),f=await matched(j.token);await list(f);
 const unseen=await issue(admin,j.contact);
 await parsed(await act(req("/v/link",{action:"remove",jobId:other.jobId},f)),404);
 await parsed(await act(req("/v/link",{action:"remove",jobId:unseen.jobId},f)),404);
 const removed=await parsed(await act(req("/v/link",{action:"remove",jobId:j.jobId},f)));
 assert.ok(!removed.jobs.some((x:{id:string})=>x.id===j.jobId));
 assert.deepEqual((await db.query("SELECT user_id,manual FROM app.b026_vendor_job_accounts WHERE job_id=$1",[j.jobId])).rows[0],{user_id:null,manual:true});
 assert.ok((await vendorAccountLinkEvents(admin,j.jobId)).some(e=>e.reason==="vendor_not_mine"));
 const done=await act(req("/v/link",{action:"confirm"},f)),data=await parsed(done);
 assert.equal(data.next,"/consent?next=%2Fvendor-account");const token=cookieValue(done,"condola_session");assert.ok(token);
 const jobs=(await vendorAccountHistory(token)).jobs;assert.deepEqual(jobs.map(j=>j.jobId),[same.jobId]);
 await syncVendorAccount(token);assert.deepEqual((await vendorAccountHistory(token)).jobs.map(j=>j.jobId),[same.jobId]);
 await parsed(await act(req("/v/link",{action:"confirm"},f)),409);
 const repeat=await matched();const html=await list(repeat);
 assert.ok(html.includes(unseen.jobId));assert.ok(!html.includes(`data-job="${j.jobId}"`));
 assert.equal((await db.query("SELECT count(*)::int n FROM app.b026_vendor_link_events WHERE reason='line_first_binding'")).rows[0].n,1);
});
test("VEN-31: no token needed after exact binding; unknown identity without token fails",async()=>{
 await rejected(await flow());
 const j=await issue(),f=await matched(j.token);await list(f);await parsed(await act(req("/v/link",{action:"confirm"},f)));
 const again=await matched();await list(again);await parsed(await act(req("/v/link",{action:"confirm"},again)));
});
test("VEN-31: first binding refuses a different LINE identity already bound to the contact",async()=>{
 const j=await issue();await matched(j.token);await rejected(await flow(j.token),`U${"c".repeat(32)}`);
});
test("VEN-31: one verified identity cannot bind another contact or organization",async()=>{
 const j=await issue();await matched(j.token);
 const other=await issue();await rejected(await flow(other.token));
 const foreign=await issue(foreignAdmin);
 await db.query(`UPDATE organizations SET feature_flags=feature_flags||'{"vendor_account":true,"brand_v2":true,"brand_v3":true}' WHERE id=$1`,[ORG2_ID]);
 await rejected(await flow(foreign.token,ORG2_ID));
});
for(const [label,user] of [["staff",USERS.admin],["tenant",USERS.tenant],["owner",USERS.owner]] as const)test(`VEN-31: ${label} identity cannot become a vendor login`,async()=>{
 const j=await issue();
 const provider=(await db.query("SELECT line_provider_id FROM line_channels WHERE id=$1",[channel])).rows[0].line_provider_id;
 await db.query("INSERT INTO app.b033_line_identities(line_channel_id,provider_user_hash,user_id,persona) VALUES($1,$2,$3,'vendor')",[channel,providerUserHash(provider,sub,pepper),user]);
 await rejected(await flow(j.token));
});
for(const state of ["archived","reassigned","revoked","expired","unshared","closed","retargeted-job"] as const)test(`VEN-31: ${state} after flow creation denies FIRST binding atomically`,async()=>{
 const j=await issue(),other=await issue(),f=await flow(j.token);
 if(state==="archived")await db.query("UPDATE contacts SET archived_at=now() WHERE id=$1",[j.contact]);
 if(state==="reassigned")await db.query("UPDATE maintenance_tickets SET assigned_vendor_contact_id=$2 WHERE id=$1",[j.ticketId,other.contact]);
 if(state==="retargeted-job"){
  await db.query("UPDATE maintenance_tickets SET assigned_vendor_contact_id=$2 WHERE id=$1",[j.ticketId,other.contact]);
  await db.query("UPDATE repair_vendor_jobs SET vendor_contact_id=$2 WHERE id=$1",[j.jobId,other.contact]);
 }
 if(state==="revoked")await db.query("UPDATE repair_vendor_jobs SET revoked_at=now(),active=false WHERE id=$1",[j.jobId]);
 if(state==="expired")await db.query("UPDATE repair_vendor_jobs SET expires_at=now()-interval '1 second' WHERE id=$1",[j.jobId]);
 if(state==="unshared")await db.query("UPDATE repair_vendor_jobs SET sharing_approved_at=NULL WHERE id=$1",[j.jobId]);
 if(state==="closed")await db.query("UPDATE maintenance_tickets SET status='closed' WHERE id=$1",[j.ticketId]);
 await rejected(f);
});
for(const key of ["brand_v3","vendor_account","line_vendor_portal","line_platform"] as const)test(`VEN-31 gates: ${key} OFF before exchange or review denies without account writes`,async()=>{
 const j=await issue(),f=await flow(j.token),ready=await matched(j.token);await list(ready);
 let before:Awaited<ReturnType<typeof snapshot>>|undefined;
 let attempts:unknown;
 const callback=await oauth(f,sub,{beforeCallback:async()=>{
  if(key==="brand_v3")await db.query(`UPDATE organizations SET feature_flags=feature_flags||'{"brand_v3":false}' WHERE id=$1`,[ORG_ID]);else await flag(key,false);
  before=await snapshot();
  attempts=(await db.query("SELECT attempts,verified_hash FROM app.b033_line_flows WHERE flow_hash=$1",[lineHash(f.flow)])).rows;
 }});
 assert.notEqual(callback.headers.get("location"),origin+"/v/link");assert.ok(!cookieValue(callback,"condola_session"));
 assert.notEqual((await act(req("/v/link",{action:"confirm"},ready))).status,200);
 assert.notEqual((await flows(req("/api/line/flows",{purpose:"login",persona:"vendor",jobToken:j.token,vendorMatch:"true"}))).status,201);
 assert.deepEqual(await snapshot(),before);
 assert.deepEqual((await db.query("SELECT attempts,verified_hash FROM app.b033_line_flows WHERE flow_hash=$1",[lineHash(f.flow)])).rows,attempts);
});
for(const opts of [{state:"wrong"},{nonce:"wrong"},{verifier:"wrong"},{aud:"wrong"},{expired:true},{cancel:true}])test(`VEN-31 verifier denial ${JSON.stringify(opts)} preserves account state`,async()=>{
 const j=await issue();await rejected(await flow(j.token),sub,opts);
});
test("VEN-31 browser proof, OAuth/confirmation replay, CSRF and different browser sessions fail closed",async()=>{
 const j=await issue(),f=await flow(j.token),before=await snapshot();
 const denied=await oauth(f,sub,{browser:randomProof()});assert.notEqual(denied.status,303);assert.deepEqual(await snapshot(),before);
 const fresh=await flow(j.token),staffSession=await createSession(USERS.admin,false,meta);await rejected(fresh,sub,{session:staffSession});
 const ready=await matched(j.token);await list(ready);
 const beforeActions=await snapshot();
 await parsed(await act(req("/v/link",{action:"confirm"},{...ready,browser:randomProof()})),404);
 await parsed(await act(req("/v/link",{action:"confirm"},{...ready,origin:"https://foreign.test"})),403);
 await parsed(await act(req("/v/link",{action:"confirm"},{...ready,session:staffSession})),409);
 await parsed(await exchange(req("/api/line/session",{flow:ready.flow,idToken:jwt()})),409);
 assert.deepEqual(await snapshot(),beforeActions);
});
test("VEN-31: a bare LIFF ID token cannot perform first binding",async()=>{
 const j=await issue(),f=await flow(j.token),before=await snapshot();
 await parsed(await exchange(req("/api/line/session",{flow:f.flow,idToken:jwt()})),404);
 assert.deepEqual(await snapshot(),before);
});
for(const change of ["identity-revoked","link-unlinked","contact-archived","user-became-staff"] as const)test(`VEN-31 confirmation rechecks ${change}`,async()=>{
 const j=await issue(),f=await matched(j.token);await list(f);
 const a=(await db.query("SELECT * FROM app.b026_vendor_accounts WHERE contact_id=$1",[j.contact])).rows[0];
 if(change==="identity-revoked")await db.query("UPDATE app.b033_line_identities SET status='revoked',unlinked_at=now() WHERE id=$1",[a.line_identity_id]);
 if(change==="link-unlinked")await db.query("UPDATE line_account_links SET status='unlinked',unlinked_at=now(),notification_opt_in=false WHERE login_identity_id=$1",[a.line_identity_id]);
 if(change==="contact-archived")await db.query("UPDATE contacts SET archived_at=now() WHERE id=$1",[j.contact]);
 if(change==="user-became-staff")await db.query("INSERT INTO org_members(org_id,user_id,role,status) VALUES($1,$2,'admin','active')",[ORG_ID,a.user_id]);
 const before=await snapshot();await parsed(await act(req("/v/link",{action:"confirm"},f)),404);assert.deepEqual(await snapshot(),before);
});
test("VEN-31 confirmation drops reassigned/closed candidates and never resurrects a management tombstone",async()=>{
 const j=await issue(),same=await issue(admin,j.contact),closed=await issue(admin,j.contact),other=await issue(),f=await matched(j.token);await list(f);
 await db.query("UPDATE maintenance_tickets SET assigned_vendor_contact_id=$2 WHERE id=$1",[same.ticketId,other.contact]);
 await db.query("UPDATE maintenance_tickets SET status='closed' WHERE id=$1",[closed.ticketId]);
 await db.query("INSERT INTO app.b026_vendor_job_accounts(job_id,org_id,contact_id,user_id,manual) VALUES($1,$2,$3,NULL,true)",[j.jobId,ORG_ID,j.contact]);
 await parsed(await act(req("/v/link",{action:"confirm"},f)));
 assert.equal((await db.query("SELECT count(*)::int n FROM app.b026_vendor_job_accounts WHERE user_id IS NOT NULL")).rows[0].n,0);
});
test("VEN-31 concurrent confirmations create one session and one durable set of links",async()=>{
 const j=await issue(),f=await matched(j.token);await list(f);
 const results=await Promise.all([act(req("/v/link",{action:"confirm"},f)),act(req("/v/link",{action:"confirm"},f))]);
 assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
 assert.equal((await db.query("SELECT count(*)::int n FROM app.b026_vendor_link_events WHERE job_id=$1 AND reason='line_confirmed'",[j.jobId])).rows[0].n,1);
});
test("VEN-31 PRINCIPLES 75: private relation/columns, function ACLs and fixed search_path; anon/authenticated cannot invoke",async()=>{
 for(const role of ["anon","authenticated","service_role"]){
  const direct=(await db.query("SELECT has_table_privilege($1,'app.b101_vendor_confirmations','SELECT,INSERT,UPDATE,DELETE') permitted",[role])).rows[0];assert.equal(direct.permitted,false);
 }
 for(const signature of ["app.b101_match(uuid,boolean)","app.b101_review(uuid,boolean,text,uuid)","app.b101_enabled(uuid,boolean)","app.b101_identity_managed(uuid)"]){
  const row=(await db.query("SELECT prosecdef,proconfig,has_function_privilege('anon',oid,'EXECUTE') anon,has_function_privilege('authenticated',oid,'EXECUTE') authenticated,has_function_privilege('service_role',oid,'EXECUTE') service FROM pg_proc WHERE oid=$1::regprocedure",[signature])).rows[0];
  assert.equal(row.prosecdef,true);assert.deepEqual(row.proconfig,["search_path=pg_catalog, app"]);assert.equal(row.anon,false);assert.equal(row.authenticated,false);assert.equal(row.service,true);
 }
 for(const role of ["anon","authenticated"]){
  await db.query("BEGIN");try{await db.query(`SET LOCAL ROLE ${role}`);
   await assert.rejects(db.query("SELECT app.b101_match($1,true)",[randomUUID()]),(e:unknown)=>(e as {code?:string}).code==="42501");
  }finally{await db.query("ROLLBACK");}
 }
});

test("VEN-31 concurrent first sign-ins bind only one identity to the contact",async()=>{
 const j=await issue(),one=await flow(j.token),two=await flow(j.token);
 const results=await Promise.all([oauth(one),oauth(two,`U${"c".repeat(32)}`)]);
 assert.deepEqual(results.map(r=>r.headers.get("location")).sort(),[origin+"/v/link",origin+"/v/link?error=1"]);
 assert.equal((await db.query("SELECT count(*)::int n FROM app.b026_vendor_link_events WHERE reason='line_first_binding' AND contact_id=$1",[j.contact])).rows[0].n,1);
 assert.equal((await db.query("SELECT count(*)::int n FROM app.b026_vendor_accounts WHERE contact_id=$1",[j.contact])).rows[0].n,1);
});

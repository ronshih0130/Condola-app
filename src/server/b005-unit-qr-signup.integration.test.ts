import assert from "node:assert/strict";
import { Client } from "pg";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { GET } from "../app/signup/unit-qr/route";
import { POST } from "../app/api/signup/unit-qr/route";
import { unitQrClientIp } from "./unit-qr-ingress";
import { acceptInvite, describeInvite } from "./auth";
import { query, svc, tx } from "./db";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { issuePortalInvite } from "./portal-invite";
import { resetAndSeed } from "./seed";
import { confirmSignupToken, startSignup } from "./signup";
import { cloneTestDatabase } from "./test-database-clone";
import type { Session } from "./types";
import { createUnitQrForm, unitQrFormMatches, completeUnitQr, issueUnitQr, readUnitQrContext, readUnitQrContinuation, revokeUnitQr, scanUnitQr, unitQrHash, unitQrStaffUnits } from "./unit-qr-signup";

let clone: Awaited<ReturnType<typeof cloneTestDatabase>>;
let session: Session;
let unit: string;
const meta = { ua: "local-unit-qr-test", ip: "127.0.0.1" };
const origin = "http://127.0.0.1:43123";
const oldEnv = { ...process.env };
const oldFetch = global.fetch;
async function enable(global: unknown = { enabled: true, allowed_org_ids: [ORG_ID, ORG2_ID] }, org: unknown = true) {
  await query(`INSERT INTO platform_settings(key,value) VALUES('unit_qr_signup',$1::jsonb) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [JSON.stringify(global)]);
  await query(`UPDATE organizations SET feature_flags=feature_flags || jsonb_build_object('unit_qr_signup',$1::jsonb) WHERE id IN ($2,$3)`, [JSON.stringify(org), ORG_ID, ORG2_ID]);
}
async function staff(userId = USERS.admin as string, orgId = ORG_ID, role: Session["role"] = "admin"): Promise<Session> {
  const id = randomUUID();
  await query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')`, [id,userId,unitQrHash(randomUUID())]);
  return { userId, sessionId:id, orgId, liveOrgId:orgId, environment:"live", kind:"staff", role, email:"", name:"", locale:"en", calendar:"gregorian", leaseId:null };
}
async function unitFor(org = ORG_ID) {
  return (await query(`SELECT u.id FROM units u JOIN properties p ON p.id=u.property_id WHERE u.org_id=$1 AND u.archived_at IS NULL AND p.archived_at IS NULL ORDER BY u.id LIMIT 1`, [org])).rows[0].id as string;
}
async function issued(actor = session, unitId = unit) {
  const value = await issueUnitQr(actor, unitId, origin);
  assert.ok(value);
  return { ...value, token: new URLSearchParams(new URL(value.url).hash.slice(1)).get("t")! };
}
function exchange(...args: unknown[]) {
  void args;
  return POST();
}
async function scanned(actor = session, unitId = unit) {
  const qr = await issued(actor, unitId);
  const handle = await scanUnitQr(qr.token, meta.ip);
  assert.ok(handle);
  return { ...qr, handle };
}
async function signup(handle?: string, email = `${randomUUID()}@example.invalid`) {
  const result = await startSignup({ email,password:"Fresh1234",confirm:"Fresh1234",partnerCode:"",origin,meta,consent:true,unitQrHandle:handle });
  assert.ok(result.ok && result.status === "verify" && result.devToken);
  const userId = (await query(`SELECT id FROM auth.users WHERE email=$1`,[email])).rows[0].id as string;
  return { userId, email, verification: result.devToken };
}
async function applicant() {
  const qr = await scanned();
  const user = await signup(qr.handle);
  assert.equal((await confirmSignupToken(user.verification,meta)).ok,true);
  return { ...qr, ...user };
}
async function snapshot() {
  return (await query(`SELECT
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM app.b005_unit_qr_contexts c) AS contexts,
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM app.b005_unit_qr_applicants a) AS applicants,
    (SELECT jsonb_agg(to_jsonb(f) ORDER BY id) FROM app.b005_unit_qr_forms f) AS forms,
    (SELECT jsonb_agg(to_jsonb(s) ORDER BY user_id) FROM app.b005_unit_qr_selections s) AS selections,
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY contact_id) FROM app.b005_unit_qr_contacts c) AS qr_contacts,
    (SELECT count(*)::int FROM contacts) AS contacts,
    (SELECT count(*)::int FROM org_members) AS members,
    (SELECT count(*)::int FROM leases) AS leases,
    (SELECT count(*)::int FROM audit_log) AS audits`)).rows[0];
}
async function noAccess(userId: string, orgId = ORG_ID) {
  await tx(userId, async client => {
    for (const table of ["units","properties","leases","lease_parties","contacts"]) {
      assert.equal((await client.query(`SELECT id FROM ${table} WHERE org_id=$1`,[orgId])).rowCount,0,table);
    }
  },{orgId,environment:"live"});
  assert.equal((await query(`SELECT 1 FROM org_members WHERE user_id=$1`,[userId])).rowCount,0);
}
test.before(async () => {
  clone = await cloneTestDatabase();
  delete process.env.SUPABASE_URL; delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.CONDOLA_ENV; delete process.env.CONDOLA_SITE_URL;
  process.env.UNIT_QR_SIGNING_KEY = randomBytes(32).toString("hex");
  global.fetch = async () => { throw new Error("Network forbidden in unit QR tests"); };
});
test.beforeEach(async () => { await resetAndSeed(); await enable(); session=await staff(); unit=await unitFor(); });
test.after(async () => {
  global.fetch=oldFetch;
  for (const name of ["SUPABASE_URL","NEXT_PUBLIC_SUPABASE_URL","CONDOLA_ENV","CONDOLA_SITE_URL","UNIT_QR_SIGNING_KEY"]) {
    if (oldEnv[name] === undefined) delete process.env[name]; else process.env[name]=oldEnv[name];
  }
  await clone?.cleanup();
});

test("staff issuance requires current session, admin/manager membership and active own-org unit", async () => {
  assert.ok(await issued());
  const manager=await staff(USERS.manager,ORG_ID,"manager");
  assert.ok(await issued(manager));
  for (const actor of [USERS.accountant,USERS.maintenance,USERS.tenant,USERS.coastAdmin]) {
    const forged=await staff(actor);
    assert.equal(await issueUnitQr(forged,unit,origin),null);
  }
  assert.equal(await issueUnitQr({...session,kind:"tenant"},unit,origin),null);
  assert.equal(await issueUnitQr({...session,sessionId:randomUUID()},unit,origin),null);
  assert.equal(await issueUnitQr(session,await unitFor(ORG2_ID),origin),null);
  assert.equal(await issueUnitQr(session,randomUUID(),origin),null);
  assert.equal(await issueUnitQr(session,"not-a-unit",origin),null);
  await query(`UPDATE units SET archived_at=now() WHERE id=$1`,[unit]);
  assert.equal(await issueUnitQr(session,unit,origin),null);
  await query(`UPDATE units SET archived_at=NULL WHERE id=$1`,[unit]);
  await query(`UPDATE properties SET archived_at=now() WHERE id=(SELECT property_id FROM units WHERE id=$1)`,[unit]);
  assert.equal(await issueUnitQr(session,unit,origin),null);
});

test("token route exchanges once for HttpOnly opaque handle and reveals no org/unit before verification", async () => {
  const qr=await issued();
  assert.equal(qr.url.includes(ORG_ID),false); assert.equal(qr.url.includes(unit),false);
  assert.equal(new URL(qr.url).pathname,"/signup/unit-qr");
  assert.equal(new URL(qr.url).search,"");
  const before=await snapshot();
  const response=await exchange(qr.token);
  assert.equal(response.status,404);
  assert.equal(await response.text(),"");
  assert.equal(response.headers.get("location"),null);
  assert.equal(response.headers.get("set-cookie"),null);
  assert.match(response.headers.get("cache-control")!,/no-store/);
  assert.equal(response.headers.get("referrer-policy"),"no-referrer");
  assert.deepEqual(await snapshot(),before);
});

test("scan -> existing signup -> email verification -> profile associates exactly once across two connections", async () => {
  const a=await applicant();
  const before=await snapshot();
  const [first,second]=await Promise.all([
    completeUnitQr(a.userId,a.id,"Synthetic Applicant","+14155550123"),
    completeUnitQr(a.userId,a.id,"Synthetic Applicant","+14155550123"),
  ]);
  assert.ok(first); assert.deepEqual(first,second);
  assert.deepEqual(await completeUnitQr(a.userId,a.id,"Synthetic Applicant","+14155550123"),first);
  const rows=await query(`SELECT a.*,c.user_id AS contact_user FROM app.b005_unit_qr_applicants a JOIN contacts c ON c.id=a.contact_id WHERE a.user_id=$1`,[a.userId]);
  assert.equal(rows.rowCount,1); assert.equal(rows.rows[0].org_id,ORG_ID); assert.equal(rows.rows[0].unit_id,unit);
  assert.equal(rows.rows[0].status,"pending"); assert.equal(rows.rows[0].contact_user,null);
  const after=await snapshot(); assert.equal(after.contacts,before.contacts+1); assert.equal(after.members,before.members); assert.equal(after.leases,before.leases);
  assert.deepEqual(await readUnitQrContext(null,a.userId),{id:a.id,done:true,active:true}); // different confirmation device
  assert.equal((await query(`SELECT 1 FROM audit_log WHERE event_type='unit_qr_applied'`)).rowCount,1);
  await noAccess(a.userId);
});

test("unverified, abandoned, missing profile/phone and foreign account cannot associate or access", async () => {
  const qr=await scanned(); const user=await signup(qr.handle);
  const before=await snapshot();
  assert.equal(await completeUnitQr(user.userId,qr.id,"Applicant","+14155550123"),null);
  assert.equal(await completeUnitQr(USERS.tenant,qr.id,"Applicant","+14155550123"),null);
  assert.deepEqual(await snapshot(),before); await noAccess(user.userId);
  await confirmSignupToken(user.verification,meta);
  for (const [name,phone] of [["","+14155550123"],["Applicant",""],["Applicant","123"],["Applicant","+abc"]]) {
    assert.equal(await completeUnitQr(user.userId,qr.id,name,phone),null);
  }
  assert.equal((await query(`SELECT 1 FROM app.b005_unit_qr_applicants`)).rowCount,0);
});

test("forged, expired, revoked and archived tokens have the same empty 404 response", async () => {
  const expired=await issued();
  await query(`UPDATE app.b005_unit_qr_contexts SET created_at=now()-interval '1 hour',expires_at=now()-interval '30 minutes' WHERE id=$1`,[expired.id]);
  const revoked=await issued(); assert.equal(await revokeUnitQr(session,revoked.id),true);
  const archived=await issued(); await query(`UPDATE units SET archived_at=now() WHERE id=$1`,[unit]);
  const before=await snapshot();
  for (const token of [expired.token,revoked.token,archived.token,"invalid",`${expired.token.slice(0,-1)}!`]) {
    const response=await exchange(token);
    assert.equal(response.status,404); assert.equal(await response.text(),""); assert.equal(response.headers.get("set-cookie"),null);
  }
  assert.deepEqual(await snapshot(),before);
});

test("revocation and expiry after binding prevent completion without falling into company creation", async () => {
  for (const mode of ["revoke","expire"]) {
    const a=await applicant();
    if (mode==="revoke") await revokeUnitQr(session,a.id);
    else await query(`UPDATE app.b005_unit_qr_contexts SET created_at=now()-interval '1 hour',expires_at=now()-interval '30 minutes' WHERE id=$1`,[a.id]);
    const before=await snapshot();
    assert.equal(await completeUnitQr(a.userId,a.id,"Applicant","+14155550123"),null);
    assert.equal((await readUnitQrContext(null,a.userId))?.active,false);
    assert.equal(await readUnitQrContext(a.handle),null);
    assert.deepEqual(await snapshot(),before);
  }
});

test("cross-org staff cannot revoke and a different verified identity cannot claim the context", async () => {
  const a=await applicant(); const coast=await staff(USERS.coastAdmin,ORG2_ID);
  const before=await snapshot();
  assert.equal(await revokeUnitQr(coast,a.id),false);
  assert.equal(await completeUnitQr(USERS.coastAdmin,a.id,"Applicant","+14155550123"),null);
  assert.equal(await svc(null,c=>c.query(`SELECT app.b005_unit_qr_bind($1,$2) AS ok`,[unitQrHash(a.handle),USERS.coastAdmin])).then(r=>r.rows[0].ok),false);
  assert.deepEqual(await snapshot(),before);
  assert.ok(await completeUnitQr(a.userId,a.id,"Applicant","+14155550123"));
  await noAccess(a.userId,ORG2_ID);
});

test("email-only contact requires reconciliation and never acquires a private applicant mapping", async () => {
  const qr=await scanned(); const user=await signup(qr.handle);
  const existing=(await query(`SELECT c.id FROM contacts c JOIN lease_parties lp ON lp.contact_id=c.id WHERE c.org_id=$1 AND c.is_tenant LIMIT 1`,[ORG_ID])).rows[0].id;
  await query(`UPDATE contacts SET user_id=NULL,email=$2 WHERE id=$1`,[existing,user.email]);
  await confirmSignupToken(user.verification,meta);
  const before=await snapshot();
  assert.ok(await completeUnitQr(user.userId,qr.id,"Applicant","+14155550123"));
  assert.notEqual((await query(`SELECT contact_id FROM app.b005_unit_qr_applicants WHERE user_id=$1`,[user.userId])).rows[0].contact_id,existing);
  assert.equal((await snapshot()).contacts,before.contacts+1);
  await noAccess(user.userId);
});

test("applications to a second unit reuse one contact and create no membership", async () => {
  const a=await applicant(); assert.ok(await completeUnitQr(a.userId,a.id,"Applicant","+14155550123"));
  const other=(await query(`SELECT id FROM units WHERE org_id=$1 AND id<>$2 AND archived_at IS NULL ORDER BY id LIMIT 1`,[ORG_ID,unit])).rows[0].id;
  const qr=await scanned(session,other);
  const result=await startSignup({ email:a.email,password:"Fresh1234",confirm:"Fresh1234",partnerCode:"",origin,meta,consent:true,unitQrHandle:qr.handle });
  assert.ok(result.ok && result.status==="firm");
  const before=await snapshot();
  assert.ok(await completeUnitQr(a.userId,qr.id,"Applicant","+14155550123"));
  assert.equal((await snapshot()).contacts,before.contacts);
  assert.equal((await query(`SELECT count(DISTINCT contact_id)::int AS n FROM app.b005_unit_qr_applicants WHERE user_id=$1`,[a.userId])).rows[0].n,1);
  await noAccess(a.userId);
});

test("wrong password cannot bind a QR to an existing unconfirmed signup", async () => {
  const user=await signup(); const qr=await scanned();
  const result=await startSignup({email:user.email,password:"Other1234",confirm:"Other1234",partnerCode:"",origin,meta,consent:true,unitQrHandle:qr.handle});
  assert.ok(result.ok); assert.equal(result.unitQrBound,undefined);
  assert.equal((await query(`SELECT user_id FROM app.b005_unit_qr_contexts WHERE id=$1`,[qr.id])).rows[0].user_id,null);
  assert.equal(await readUnitQrContext(null,user.userId),null);
});

test("one browser handle cannot be rebound to a different signup account, including concurrent creation", async () => {
  const qr=await scanned();
  const emails=[`${randomUUID()}@example.invalid`,`${randomUUID()}@example.invalid`];
  const results=await Promise.all(emails.map(email=>startSignup({email,password:"Fresh1234",confirm:"Fresh1234",partnerCode:"",origin,meta,consent:true,unitQrHandle:qr.handle})));
  assert.equal(results.filter(result=>result.ok).length,1);
  const users=await query(`SELECT id,email FROM auth.users WHERE email=ANY($1::text[])`,[emails]);
  assert.equal(users.rowCount,1);
  assert.equal((await query(`SELECT user_id FROM app.b005_unit_qr_contexts WHERE id=$1`,[qr.id])).rows[0].user_id,users.rows[0].id);
  const retry=await startSignup({email:users.rows[0].email,password:"Fresh1234",confirm:"Fresh1234",partnerCode:"",origin,meta,consent:true,unitQrHandle:qr.handle});
  assert.ok(retry.ok && retry.status==="verify");
  assert.equal((await query(`SELECT 1 FROM app.b005_unit_qr_applicants`)).rowCount,0);
});

test("all four ID-policy combinations and existing settings remain unchanged", async () => {
  for (const collect of [false,true]) for (const required of [false,true]) {
    await query(`UPDATE organizations SET settings=settings || jsonb_build_object('collect_id',$2::boolean,'require_id_before_sign',$3::boolean) WHERE id=$1`,[ORG_ID,collect,required]);
    const before=(await query(`SELECT settings FROM organizations WHERE id=$1`,[ORG_ID])).rows[0].settings;
    const count=(await query(`SELECT count(*)::int AS n FROM identity_documents`)).rows[0].n;
    const a=await applicant(); assert.ok(await completeUnitQr(a.userId,a.id,"Applicant","+14155550123"));
    assert.deepEqual((await query(`SELECT settings FROM organizations WHERE id=$1`,[ORG_ID])).rows[0].settings,before);
    assert.equal((await query(`SELECT count(*)::int AS n FROM identity_documents`)).rows[0].n,count);
  }
});

test("existing invitation links coexist and still complete their original acceptance", async () => {
  const contact=(await query(`SELECT id FROM contacts WHERE org_id=$1 AND display_name='Morgan Lee'`,[ORG_ID])).rows[0].id;
  const invitation=await issuePortalInvite(session,{kind:"owner",contactId:contact,pageId:contact},origin);
  assert.equal(invitation.activated,false); if(invitation.activated) return;
  const a=await applicant(); assert.ok(await completeUnitQr(a.userId,a.id,"Applicant","+14155550123"));
  assert.equal((await describeInvite(invitation.token,meta)).state,"ready");
  assert.equal((await acceptInvite(invitation.token,"","Owner1234","Owner1234",meta)).ok,true);
  assert.equal((await query(`SELECT 1 FROM app.b005_unit_qr_applicants WHERE user_id=$1`,[a.userId])).rowCount,1);
});

test("OFF matrix returns 404, hides controls and performs zero writes including completion and audit", async () => {
  const a=await applicant(); const unused=await issued();
  const formId=await createUnitQrForm(a.handle); assert.ok(formId);
  for (const [global,org] of [
    [{enabled:false,allowed_org_ids:[ORG_ID]},true], [{enabled:"true",allowed_org_ids:[ORG_ID]},true],
    [{enabled:true,allowed_org_ids:ORG_ID},true], [{enabled:true,allowed_org_ids:[]},true],
    [{enabled:true,allowed_org_ids:[ORG2_ID]},true], [{enabled:true,allowed_org_ids:[ORG_ID]},false],
    [{enabled:true,allowed_org_ids:[ORG_ID]},"true"], [null,true], [{},true],
  ] as const) {
    await enable(global,org); const before=await snapshot();
    assert.equal(await issueUnitQr(session,unit,origin),null); assert.equal(await unitQrStaffUnits(session),null);
    assert.equal(await createUnitQrForm(a.handle),null);
    assert.equal(await unitQrFormMatches(formId,a.handle),false);
    const response=await exchange(unused.token);
    assert.equal(response.status,404); assert.equal(await response.text(),"");
    assert.equal(await readUnitQrContext(null,a.userId),null);
    assert.equal(await completeUnitQr(a.userId,a.id,"Applicant","+14155550123"),null);
    assert.equal(await revokeUnitQr(session,a.id),false);
    assert.deepEqual(await snapshot(),before);
  }
  await query(`DELETE FROM platform_settings WHERE key='unit_qr_signup'`);
  const before=await snapshot(); assert.equal(await scanUnitQr(unused.token,meta.ip),null); assert.equal(await issueUnitQr(session,unit,origin),null);
  assert.deepEqual(await snapshot(),before);
  // Ordinary signup still uses the original verification response with no QR rows.
  await signup();
  assert.equal((await snapshot()).applicants,before.applicants);
  assert.deepEqual((await snapshot()).contexts,before.contexts);
});

test("issue and scan rate limits serialize and remain scoped", async () => {
  const values=await Promise.all(Array.from({length:12},()=>issueUnitQr(session,unit,origin)));
  assert.equal(values.filter(Boolean).length,10);
  for(const value of values.filter(v=>v!==null)) assert.ok(await scanUnitQr(new URLSearchParams(new URL(value!.url).hash.slice(1)).get("t")!,meta.ip));
  const manager=await staff(USERS.manager,ORG_ID,"manager");
  for(let i=0;i<10;i++) assert.ok(await scanUnitQr((await issued(manager)).token,meta.ip));
  const coast=await staff(USERS.coastAdmin,ORG2_ID);
  const qr=await issued(coast,await unitFor(ORG2_ID));
  const before=await snapshot(); assert.equal(await scanUnitQr(qr.token,meta.ip),null); assert.deepEqual(await snapshot(),before);
  assert.ok(await scanUnitQr(qr.token,"127.0.0.2"));
});

test("privilege catalog is private, service-only, SECURITY DEFINER with pinned paths; audit is masked", async () => {
  const a=await applicant();
  const beforeAudit = (await query(`SELECT id FROM audit_log`)).rows.map(row => row.id);
  await completeUnitQr(a.userId,a.id,"Private Applicant Name","+14155550123");
  const completionAudit = (await query(`SELECT * FROM audit_log WHERE NOT (id=ANY($1::bigint[]))`, [beforeAudit])).rows;
  assert.ok(completionAudit.some(row => row.table_name === "contacts"));
  assert.ok(completionAudit.some(row => row.event_type === "unit_qr_applied"));
  for (const secret of [a.token,a.handle,a.email,"Private Applicant Name","+14155550123",meta.ip]) {
    assert.equal(JSON.stringify(completionAudit).includes(secret),false, `completion audit leaked ${secret}`);
  }
  const contactAudit = completionAudit.find(row => row.table_name === "contacts")!;
  for (const field of ["display_name","phone_e164","email"]) assert.equal(contactAudit.new_row[field],"[redacted]");
  for(const table of ["b005_unit_qr_contexts","b005_unit_qr_applicants","b005_unit_qr_forms","b005_unit_qr_selections","b005_unit_qr_contacts"]) {
    const r=(await query(`SELECT relrowsecurity AS rls FROM pg_class WHERE oid=$1::regclass`,[`app.${table}`])).rows[0];
    assert.equal(r.rls,true);
    for(const role of ["anon","authenticated","service_role"]) for(const permission of ["SELECT","INSERT","UPDATE","DELETE","TRUNCATE"]) {
      assert.equal((await query(`SELECT has_table_privilege($1,$2,$3) AS ok`,[role,`app.${table}`,permission])).rows[0].ok,false);
    }
    await assert.rejects(tx(USERS.admin,c=>c.query(`SELECT * FROM app.${table}`),{orgId:ORG_ID}));
    await assert.rejects(svc(null,c=>c.query(`SELECT * FROM app.${table}`)));
  }
  const functions=await query(`SELECT p.oid::regprocedure::text AS signature,p.proname,p.prosecdef,p.proconfig,
    has_function_privilege('anon',p.oid,'EXECUTE') AS anon,has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated,
    has_function_privilege('service_role',p.oid,'EXECUTE') AS service FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='app' AND p.proname LIKE 'b005_unit_qr_%'`);
  assert.equal(functions.rowCount,13);
  for(const f of functions.rows) {
    assert.equal(f.prosecdef,true); assert.deepEqual(f.proconfig,["search_path=pg_catalog, public, app"]);
    assert.equal(f.anon,false); assert.equal(f.authenticated,false); assert.equal(f.service,!["b005_unit_qr_admit","b005_unit_qr_identity_guard","b005_unit_qr_contact_audit"].includes(f.proname));
  }
  const logs=JSON.stringify((await query(`SELECT * FROM audit_log WHERE event_type LIKE 'unit_qr_%'`)).rows);
  for(const secret of [a.token,a.handle,a.email,"+14155550123",meta.ip]) assert.equal(logs.includes(secret),false);
});


test("changed email cannot share a claimed contact; same-user private mapping wins over a linked directory contact", async () => {
  const a=await applicant();
  assert.ok(await completeUnitQr(a.userId,a.id,"First applicant","+14155550123"));
  const contact=(await query(`SELECT contact_id FROM app.b005_unit_qr_applicants WHERE user_id=$1`,[a.userId])).rows[0].contact_id;
  const b=await applicant();
  await query(`UPDATE contacts SET email=$2 WHERE id=$1`,[contact,b.email]);
  assert.ok(await completeUnitQr(b.userId,b.id,"Second applicant","+14155550999"));
  const bContact=(await query(`SELECT contact_id FROM app.b005_unit_qr_applicants WHERE user_id=$1`,[b.userId])).rows[0].contact_id;
  assert.notEqual(bContact,contact);
  await assert.rejects(query(`UPDATE contacts SET user_id=$2 WHERE id=$1`,[contact,b.userId]), /applicant_identity_conflict/);
  await assert.rejects(query(`UPDATE app.b005_unit_qr_applicants SET contact_id=$1 WHERE user_id=$2`,[contact,b.userId]), /applicant_identity_conflict/);
  await query(`INSERT INTO contacts(org_id,display_name,is_tenant,user_id) VALUES($1,'Other directory entry',true,$2)`,[ORG_ID,a.userId]);
  const other=(await query(`SELECT id FROM units WHERE org_id=$1 AND id<>$2 AND archived_at IS NULL LIMIT 1`,[ORG_ID,unit])).rows[0].id;
  const next=await scanned(session,other);
  assert.ok((await startSignup({email:a.email,password:"Fresh1234",confirm:"Fresh1234",partnerCode:"",origin,meta,consent:true,unitQrHandle:next.handle})).ok);
  assert.ok(await completeUnitQr(a.userId,next.id,"Updated applicant","+14155550888"));
  assert.equal((await query(`SELECT contact_id FROM app.b005_unit_qr_applicants WHERE user_id=$1 AND unit_id=$2`,[a.userId,other])).rows[0].contact_id,contact);
  await noAccess(b.userId);
});

test("reused same-user contacts preserve submitted profile independently of missing or stale directory details", async () => {
  for (const phone of [null,"+14155550000"]) {
    const a=await applicant();
    const contact=(await query(`INSERT INTO contacts(org_id,user_id,display_name,phone_e164,is_tenant) VALUES($1,$2,'Old name',$3,true) RETURNING id`,[ORG_ID,a.userId,phone])).rows[0].id;
    assert.ok(await completeUnitQr(a.userId,a.id,"New applicant name","+14155550999"));
    const row=(await query(`SELECT contact_id,submitted_name,submitted_phone,submitted_email FROM app.b005_unit_qr_applicants WHERE user_id=$1`,[a.userId])).rows[0];
    assert.deepEqual(row,{contact_id:contact,submitted_name:"New applicant name",submitted_phone:"+14155550999",submitted_email:a.email});
    assert.deepEqual((await query(`SELECT display_name,phone_e164 FROM contacts WHERE id=$1`,[contact])).rows[0],{display_name:"Old name",phone_e164:phone});
  }
});

test("an open signup continuation fails closed on expiry, revocation or archive; OFF remains ordinary signup", async () => {
  assert.deepEqual(await readUnitQrContinuation(),{state:"absent"});
  for (const mode of ["expire","revoke","archive"]) {
    const a=await scanned();
    assert.equal((await readUnitQrContinuation(a.handle)).state,"active");
    if(mode==="expire") await query(`UPDATE app.b005_unit_qr_contexts SET created_at=now()-interval '1 hour',expires_at=now()-interval '30 minutes' WHERE id=$1`,[a.id]);
    if(mode==="revoke") await revokeUnitQr(session,a.id);
    if(mode==="archive") await query(`UPDATE units SET archived_at=now() WHERE id=$1`,[unit]);
    assert.deepEqual(await readUnitQrContinuation(a.handle),{state:"invalid"});
    const email=`${randomUUID()}@example.invalid`;
    const result=await startSignup({email,password:"Fresh1234",confirm:"Fresh1234",partnerCode:"",origin,meta,consent:true,unitQrHandle:a.handle});
    assert.deepEqual(result,{ok:false,error:"required"});
    assert.equal((await query(`SELECT 1 FROM auth.users WHERE email=$1`,[email])).rowCount,0);
    await enable({enabled:false,allowed_org_ids:[ORG_ID]});
    assert.deepEqual(await readUnitQrContinuation(a.handle),{state:"disabled"});
    await enable(); await query(`UPDATE units SET archived_at=NULL WHERE id=$1`,[unit]);
  }
});

test("rotating forged forwarding chains cannot bypass the trusted-address scan limit", async () => {
  const coast=await staff(USERS.coastAdmin,ORG2_ID);
  const manager=await staff(USERS.manager,ORG_ID,"manager");
  for(let i=0;i<21;i++) {
    const actor=i<10?session:i<20?coast:manager;
    const qr=await issued(actor,await unitFor(actor.orgId));
    const ip=unitQrClientIp(new Headers({"cf-connecting-ip":"2001:0db8:0:0:0:0:0:1","x-forwarded-for":`198.51.100.${i}, 192.0.2.1`}),{cloudflare:true});
    assert.equal(Boolean(await scanUnitQr(qr.token,ip)),i<20);
  }
});

test("exchange errors and audit output never contain bearer, handle or profile; cross-site POST cannot consume", async () => {
  const qr=await issued();
  for(const response of [await exchange(qr.token,{origin:"https://attacker.invalid"}),await exchange(qr.token)]) {
    assert.equal(response.status,404);
    assert.equal(await response.text(),"");
    assert.equal(JSON.stringify([...response.headers]).includes(qr.token),false);
  }
  assert.ok(await scanUnitQr(qr.token,meta.ip));
  const logs=JSON.stringify((await query(`SELECT * FROM audit_log WHERE event_type LIKE 'unit_qr_%'`)).rows);
  assert.equal(logs.includes(qr.token),false);
});


test("OFF continuation uses the identical legacy context query sequence; no handle does not query", async (t) => {
  const a=await scanned();
  await enable({enabled:false,allowed_org_ids:[]});
  const spy=t.mock.method(Client.prototype,"query");
  await readUnitQrContext(a.handle);
  const legacy=spy.mock.calls.map(call=>call.arguments);
  spy.mock.resetCalls();
  assert.deepEqual(await readUnitQrContinuation(a.handle),{state:"disabled"});
  assert.deepEqual(spy.mock.calls.map(call=>call.arguments),legacy);
  spy.mock.resetCalls();
  assert.deepEqual(await readUnitQrContinuation(),{state:"absent"});
  assert.equal(spy.mock.callCount(),0);
});


test("each rendered form is stored against its exact context and rejects a second tab's cookie", async () => {
  const a = await scanned();
  const firstForm = await createUnitQrForm(a.handle);
  const anotherForm = await createUnitQrForm(a.handle);
  assert.ok(firstForm); assert.ok(anotherForm); assert.notEqual(firstForm,anotherForm);
  const other = (await query(`SELECT id FROM units WHERE org_id=$1 AND id<>$2 AND archived_at IS NULL LIMIT 1`,[ORG_ID,unit])).rows[0].id;
  const b = await scanned(session,other);
  const bForm = await createUnitQrForm(b.handle);
  assert.ok(bForm);
  assert.equal(await unitQrFormMatches(firstForm,a.handle),true);
  assert.equal(await unitQrFormMatches(firstForm,b.handle),false);
  assert.equal(await unitQrFormMatches(bForm,a.handle),false);
  assert.equal(await unitQrFormMatches(randomUUID(),a.handle),false);
  assert.equal(await unitQrFormMatches(firstForm,""),false);
  assert.deepEqual((await query(`SELECT context_id FROM app.b005_unit_qr_forms WHERE id=$1`,[firstForm])).rows[0],{context_id:a.id});
  await revokeUnitQr(session,a.id);
  assert.equal(await unitQrFormMatches(firstForm,a.handle),false);
  assert.equal(await createUnitQrForm(a.handle),null);
});

test("resume follows the explicitly bound application when issuance order is reversed", async () => {
  const a = await scanned();
  const other = (await query(`SELECT id FROM units WHERE org_id=$1 AND id<>$2 AND archived_at IS NULL LIMIT 1`,[ORG_ID,unit])).rows[0].id;
  const b = await scanned(session,other);
  const user = await signup(b.handle);
  assert.equal((await confirmSignupToken(user.verification,meta)).ok,true);
  assert.ok(await completeUnitQr(user.userId,b.id,"Second issued first applied","+14155550123"));
  assert.equal((await readUnitQrContext(null,user.userId))?.id,b.id);
  const bound = await startSignup({email:user.email,password:"Fresh1234",confirm:"Fresh1234",partnerCode:"",origin,meta,consent:true,unitQrHandle:a.handle});
  assert.ok(bound.ok && bound.unitQrBound);
  assert.deepEqual(await readUnitQrContext(null,user.userId),{id:a.id,done:false,active:true});
  assert.deepEqual((await query(`SELECT context_id FROM app.b005_unit_qr_selections WHERE user_id=$1`,[user.userId])).rows[0],{context_id:a.id});
  assert.ok(await completeUnitQr(user.userId,a.id,"First issued last applied","+14155550123"));
  assert.deepEqual(await readUnitQrContext(null,user.userId),{id:a.id,done:true,active:true});
});

test("GET is a static L1 200 regardless of flag while exchange POST stays empty private 404 (TEN-29-AC3)", async () => {
  const qr = await issued();
  let body: string | undefined;
  for (const [global,org] of [
    [{enabled:true,allowed_org_ids:[ORG_ID,ORG2_ID]},true],
    [{enabled:false,allowed_org_ids:[ORG_ID]},true],
    [{enabled:"true",allowed_org_ids:[ORG_ID]},true],
    [{enabled:true,allowed_org_ids:[]},true],
    [{enabled:true,allowed_org_ids:[ORG_ID]},false],
    [{enabled:true,allowed_org_ids:[ORG_ID]},"true"],
    [null,true], [{},true],
  ] as const) {
    await enable(global,org);
    const before = await snapshot();
    const entry = await GET();
    assert.equal(entry.status,200);
    assert.match(entry.headers.get("cache-control")!,/no-store/);
    assert.equal(entry.headers.get("referrer-policy"),"no-referrer");
    assert.equal(entry.headers.get("location"),null);
    const text = await entry.text();
    assert.ok(text.includes("這個 QR 已停用"));
    assert.equal(text.includes(ORG_ID),false);
    assert.equal(text.includes(unit),false);
    assert.equal(text.includes(qr.token),false);
    body ??= text;
    assert.equal(text,body);
    const response = await exchange(qr.token);
    assert.equal(response.status,404);
    assert.equal(await response.text(),"");
    assert.equal(response.headers.get("set-cookie"),null);
    assert.deepEqual(await snapshot(),before);
  }
});

test("QR contact update/delete audit stays masked and ordinary contacts keep generic snapshots", async () => {
  const a=await applicant();
  await completeUnitQr(a.userId,a.id,"QR private name","+14155550123");
  const contact=(await query(`SELECT contact_id FROM app.b005_unit_qr_applicants WHERE user_id=$1`,[a.userId])).rows[0].contact_id;
  await query(`UPDATE contacts SET display_name='Changed private name',email=$2 WHERE id=$1`,[contact,a.email]);
  await query(`DELETE FROM contacts WHERE id=$1`,[contact]);
  const rows=(await query(`SELECT * FROM audit_log WHERE table_name='contacts' AND row_id=$1`,[contact])).rows;
  assert.deepEqual(rows.map(row=>row.action).sort(),["delete","insert","update"]);
  for (const secret of ["QR private name","Changed private name","+14155550123",a.email]) assert.equal(JSON.stringify(rows).includes(secret),false);
  await enable({enabled:false,allowed_org_ids:[]});
  const ordinary=(await query(`INSERT INTO contacts(org_id,display_name,phone_e164,email,is_tenant) VALUES($1,'Ordinary name','+14155550888','ordinary@example.invalid',true) RETURNING *`,[ORG_ID])).rows[0];
  const stored=(await query(`SELECT to_jsonb(c) AS row FROM contacts c WHERE id=$1`,[ordinary.id])).rows[0].row;
  const audit=(await query(`SELECT new_row FROM audit_log WHERE table_name='contacts' AND row_id=$1`,[ordinary.id])).rows[0].new_row;
  assert.deepEqual(audit,stored);
});

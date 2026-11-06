import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Client } from 'pg';
import { ORG_ID, ORG2_ID } from './ids';
import { cloneTestDatabase } from './test-database-clone';
import { disposableDbUrl } from './test-disposable-db';
import { changeTenantPassword, saveTenantProfile, tenantProfile } from './tenant-profile';
import { signIn, completeSecondFactor } from './auth';
import { totpCode } from './totp';
import type { Session } from './types';

disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>>, db: Client;
test.before(async()=>{ clone=await cloneTestDatabase(); db=new Client({connectionString:clone.url}); await db.connect(); });
test.after(async()=>{ await db?.end(); await clone?.cleanup(); });
const currentPassword='CurrentSecret72', password='NewSecret83';
const passwordInput={currentPassword,password,confirm:password};
async function flag(value: unknown = {enabled:true,allowed_org_ids:[ORG_ID]}, override: unknown = true) {
  await db.query(`UPDATE platform_settings SET value=$1::jsonb WHERE key='tenant_account_settings'`,[JSON.stringify(value)]);
  await db.query(`UPDATE organizations SET feature_flags=feature_flags||jsonb_build_object('tenant_account_settings',$1::jsonb) WHERE id=$2`,[JSON.stringify(override),ORG_ID]);
}
async function tenant(orgId=ORG_ID, cost=6) {
  const userId=randomUUID(), email=`${userId}@example.invalid`;
  await db.query(`INSERT INTO auth.users(id,email,encrypted_password,email_confirmed_at,role,aud) VALUES($1,$2,crypt($3,gen_salt('bf',$4)),now(),'authenticated','authenticated')`,[userId,email,currentPassword,cost]);
  const contact=(await db.query(`INSERT INTO contacts(org_id,is_tenant,display_name,phone_e164,user_id) VALUES($1,true,'Original','+14155550111',$2) RETURNING id`,[orgId,userId])).rows[0].id as string;
  const session=async()=> (await db.query(`INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 day') RETURNING id`,[userId,randomUUID()])).rows[0].id as string;
  const s:Session={userId,email,sessionId:await session(),name:'Original',kind:'tenant',role:null,orgId,liveOrgId:orgId,environment:(await db.query(`SELECT environment FROM organizations WHERE id=$1`,[orgId])).rows[0].environment,locale:'en',calendar:'gregorian',leaseId:null};
  return {s,contact,other:await session()};
}
async function input(s:Session) { const view=await tenantProfile(s); assert.ok(view); return {displayName:'Changed',phone:'+14155550222',version:view.version}; }
async function snapshot(s:Session) {
  return (await db.query(`SELECT jsonb_build_object('profile',(SELECT jsonb_agg(to_jsonb(p)) FROM app.b020_tenant_profiles p WHERE user_id=$1),'auth',(SELECT to_jsonb(u) FROM auth.users u WHERE id=$1),'sessions',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM auth_sessions a WHERE user_id=$1),'attempts',(SELECT to_jsonb(a) FROM auth_login_attempts a WHERE email=$2),'contacts',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM contacts c WHERE user_id=$1),'challenges',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM auth_challenges c WHERE user_id=$1),'limits',(SELECT jsonb_agg(to_jsonb(m) ORDER BY kind) FROM app.b020_profile_mutations m WHERE user_id=$1),'audits',(SELECT count(*) FROM audit_log WHERE actor_user_id=$1)) AS value`,[s.userId,s.email])).rows[0].value;
}
test('OFF/missing/malformed flags: profile/password attempts cause zero writes',async()=>{
  await flag(); const {s}=await tenant(); const data=await input(s);
  for (const [global,org] of [[{enabled:false,allowed_org_ids:[ORG_ID]},true],[{},true],[{enabled:'true',allowed_org_ids:[ORG_ID]},true],[{enabled:true,allowed_org_ids:'bad'},true],[{enabled:true,allowed_org_ids:[ORG_ID]},null],[{enabled:true,allowed_org_ids:[ORG_ID]},'true']] as const) {
    await flag(global,org); const before=await snapshot(s);
    assert.equal(await tenantProfile(s),null);
    assert.equal(await saveTenantProfile(s,data),'unavailable');
    assert.equal(await changeTenantPassword(s,passwordInput),'unavailable');
    assert.equal(await changeTenantPassword(s,{...passwordInput,currentPassword:'WrongSecret8'}),'unavailable');
    assert.deepEqual(await snapshot(s),before);
  }
});
test('forged identifiers ignored; only account profile changes; masked metadata audit',async()=>{
  await flag(); const {s}=await tenant(), foreign=await tenant(); const before=await snapshot(foreign.s);
  assert.equal(await saveTenantProfile(s,{...await input(s),user_id:foreign.s.userId,org_id:ORG2_ID,contact_id:foreign.contact,email:'forged@example.invalid'}),'updated');
  const profile=await tenantProfile(s); assert.equal(profile?.display_name,'Changed'); assert.equal(profile?.phone_e164,'+14155550222');
  assert.deepEqual(await snapshot(foreign.s),before);
  assert.equal((await db.query(`SELECT display_name FROM contacts WHERE user_id=$1`,[s.userId])).rows[0].display_name,'Original');
  const audit=(await db.query(`SELECT new_row FROM audit_log WHERE actor_user_id=$1 AND event_type='tenant_profile_changed'`,[s.userId])).rows;
  assert.equal(audit.length,1); assert.ok(!JSON.stringify(audit).includes('Changed')); assert.ok(!JSON.stringify(audit).includes('+14155550222'));
});
test('archived, non-tenant, other-org, sandbox pin, staff and expired/revoked session denial',async()=>{
  await flag(); const {s,contact}=await tenant(); const data=await input(s);
  for (const session of [{...s,environment:'sandbox' as const},{...s,kind:'staff' as const},{...s,sessionId:randomUUID()}]) {
    assert.equal(await tenantProfile(session),null); assert.equal(await saveTenantProfile(session,data),'unavailable'); assert.equal(await changeTenantPassword(session,passwordInput),'unavailable');
  }
  for (const column of ['archived_at','is_tenant']) {
    await db.query(column==='archived_at'?`UPDATE contacts SET archived_at=now() WHERE id=$1`:`UPDATE contacts SET is_tenant=false WHERE id=$1`,[contact]);
    assert.equal(await saveTenantProfile(s,data),'unavailable'); assert.equal(await changeTenantPassword(s,passwordInput),'unavailable');
    await db.query(`UPDATE contacts SET archived_at=NULL,is_tenant=true WHERE id=$1`,[contact]);
  }
  await db.query(`UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE id=$1`,[s.sessionId]);
  assert.equal(await changeTenantPassword(s,passwordInput),'unavailable');
  await db.query(`UPDATE auth_sessions SET expires_at=now()+interval '1 day',revoked_at=now() WHERE id=$1`,[s.sessionId]);
  assert.equal(await saveTenantProfile(s,data),'unavailable');
});
test('other-org denial reaches ownership with both flags ON and correct foreign environment',async()=>{
  await flag({enabled:true,allowed_org_ids:[ORG_ID,ORG2_ID]});
  await db.query(`UPDATE organizations SET feature_flags=feature_flags||'{"tenant_account_settings":true}'::jsonb WHERE id=$1`,[ORG2_ID]);
  const {s}=await tenant(), foreign=await tenant(ORG2_ID);
  assert.ok(await tenantProfile(foreign.s),'foreign organization is admitted for its own tenant');
  const before=await snapshot(foreign.s), ownBefore=await snapshot(s);
  const forged={...s,orgId:ORG2_ID,liveOrgId:ORG2_ID,environment:foreign.s.environment};
  assert.equal(await tenantProfile(forged),null);
  assert.equal(await saveTenantProfile(forged,await input(s)),'unavailable');
  assert.equal(await changeTenantPassword(forged,passwordInput),'unavailable');
  assert.deepEqual(await snapshot(foreign.s),before);
  assert.deepEqual(await snapshot(s),ownBefore);
});
test('stale session age never substitutes for re-entry; wrong/weak/lockout and expiry policy',async()=>{
  await flag(); const {s}=await tenant();
  await db.query(`UPDATE auth_sessions SET created_at=now()-interval '2 days' WHERE id=$1`,[s.sessionId]);
  const before=await snapshot(s);
  assert.equal(await changeTenantPassword(s,{...passwordInput,currentPassword:''}),'reauth');
  assert.equal(await changeTenantPassword(s,{...passwordInput,password:'password1',confirm:'password1'}),'weak');
  assert.deepEqual(await snapshot(s),before);
  for(let i=1;i<=5;i++) assert.equal(await changeTenantPassword(s,{...passwordInput,currentPassword:'WrongSecret9'}),i===5?'locked':'invalid');
  const row=(await db.query(`SELECT failed_count,locked_until FROM auth_login_attempts WHERE email=$1`,[s.email])).rows[0];
  assert.equal(row.failed_count,5); assert.ok(row.locked_until.getTime()-Date.now()>14*60*1000);
  const locked=await snapshot(s); assert.equal(await changeTenantPassword(s,passwordInput),'locked'); assert.deepEqual(await snapshot(s),locked);
  await db.query(`UPDATE auth_login_attempts SET locked_until=now()-interval '1 second' WHERE email=$1`,[s.email]);
  assert.equal(await changeTenantPassword(s,{...passwordInput,currentPassword:'WrongSecret9'}),'invalid');
  assert.equal((await db.query(`SELECT failed_count FROM auth_login_attempts WHERE email=$1`,[s.email])).rows[0].failed_count,1);
  assert.equal(await changeTenantPassword(s,passwordInput),'changed','fresh current-password re-entry admits an old but active session');
});
test('password changes atomically; revoke other user sessions only and preserve current',async()=>{
  await flag(); const {s,other}=await tenant(), foreign=await tenant(); const before=await snapshot(foreign.s);
  assert.equal(await changeTenantPassword(s,{...passwordInput,user_id:foreign.s.userId,org_id:ORG2_ID}),'changed');
  const rows=(await db.query(`SELECT id,revoked_at FROM auth_sessions WHERE user_id=$1`,[s.userId])).rows;
  assert.equal(rows.find(r=>r.id===s.sessionId).revoked_at,null); assert.ok(rows.find(r=>r.id===other).revoked_at);
  assert.deepEqual(await snapshot(foreign.s),before);
  assert.equal((await db.query(`SELECT encrypted_password=crypt($2,encrypted_password) AS matches FROM auth.users WHERE id=$1`,[s.userId,password])).rows[0].matches,true);
  assert.equal(await changeTenantPassword({...s,sessionId:other},{currentPassword:password,password:'NextSecret94',confirm:'NextSecret94'}),'unavailable');
  assert.equal((await db.query(`SELECT count(*)::int n FROM audit_log WHERE actor_user_id=$1 AND event_type='tenant_password_changed'`,[s.userId])).rows[0].n,1);
});
test('optimistic version conflicts serialize concurrent saves',async()=>{
  await flag(); const {s}=await tenant(); const data=await input(s);
  const results=await Promise.all([saveTenantProfile(s,data),saveTenantProfile(s,{...data,displayName:'Other'})]);
  assert.deepEqual(results.sort(),['stale','updated']);
  assert.equal(await saveTenantProfile(s,data),'stale');
  assert.notEqual((await tenantProfile(s))?.version,data.version);
});
test('private storage and service-only gateways deny browser roles',async()=>{
  for(const role of ['anon','authenticated','service_role']) assert.equal((await db.query(`SELECT has_table_privilege($1,'app.b020_tenant_profiles','SELECT,INSERT,UPDATE,DELETE') ok`,[role])).rows[0].ok,false);
  for(const role of ['anon','authenticated']) for(const signature of ['app.b020_profile(uuid,uuid)','app.b020_save_profile(uuid,uuid,text,text,text)','app.b020_change_password(uuid,uuid,text,text,integer,integer)']) assert.equal((await db.query(`SELECT has_function_privilege($1,$2,'EXECUTE') ok`,[role,signature])).rows[0].ok,false);
});

test('concurrent first profile save and password change use consistent lock order',async()=>{
  await flag(); const {s}=await tenant(); const data=await input(s);
  const results=await Promise.all([saveTenantProfile(s,data),changeTenantPassword(s,passwordInput)]);
  assert.deepEqual(results,['updated','changed']);
});
test('long existing password can reauthenticate; new password still obeys bcrypt bound',async()=>{
  await flag(); const {s}=await tenant(); const old='ExistingSecret7'+'x'.repeat(60);
  await db.query(`UPDATE auth.users SET encrypted_password=crypt($2,gen_salt('bf')) WHERE id=$1`,[s.userId,old]);
  assert.equal(await changeTenantPassword(s,{...passwordInput,currentPassword:old}),'changed');
});
test('failed audit rolls password and all revocations back together',async()=>{
  await flag(); const {s}=await tenant(); const before=await snapshot(s);
  await db.query(`CREATE FUNCTION app.b020_test_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='tenant_password_changed' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER b020_test_fail_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION app.b020_test_fail_audit()`);
  try {
    assert.equal(await changeTenantPassword(s,passwordInput),'unavailable');
    assert.deepEqual(await snapshot(s),before);
  } finally { await db.query(`DROP TRIGGER b020_test_fail_audit ON audit_log; DROP FUNCTION app.b020_test_fail_audit()`); }
});

test('password hashing upgrades cost 6 and preserves cost 11',async()=>{
  await flag();
  for (const cost of [6,11]) {
    const {s}=await tenant(ORG_ID,cost);
    assert.equal(await changeTenantPassword(s,passwordInput),'changed');
    const row=(await db.query(`SELECT split_part(encrypted_password,'$',3)::int cost, encrypted_password=crypt($2,encrypted_password) matches FROM auth.users WHERE id=$1`,[s.userId,password])).rows[0];
    assert.equal(row.cost,Math.max(cost,10)); assert.equal(row.matches,true);
  }
});
test('password change invalidates pending MFA and enrollment challenges only for this user',async()=>{
  await flag(); const {s}=await tenant(), foreign=await tenant(); const secret='JBSWY3DPEHPK3PXP';
  for (const who of [s,foreign.s]) await db.query(`INSERT INTO user_mfa(user_id,enabled,totp_secret) VALUES($1,true,$2)`,[who.userId,secret]);
  const pending=await signIn(s.email,currentPassword,false,{ua:'mfa',ip:'127.0.0.1'});
  const otherPending=await signIn(foreign.s.email,currentPassword,false,{ua:'mfa',ip:'127.0.0.1'});
  assert.ok(!pending.ok && 'challengeId' in pending); assert.ok(!otherPending.ok && 'challengeId' in otherPending);
  await db.query(`INSERT INTO auth_challenges(user_id,purpose,remember,totp_secret,expires_at) SELECT id,'enroll',false,$2,now()+interval '10 minutes' FROM auth.users WHERE id=$1`,[s.userId,secret]);
  const before=await snapshot(foreign.s);
  assert.equal(await changeTenantPassword(s,passwordInput),'changed');
  assert.equal((await db.query(`SELECT count(*)::int n FROM auth_challenges WHERE user_id=$1`,[s.userId])).rows[0].n,0);
  assert.deepEqual(await completeSecondFactor(pending.challengeId,totpCode(secret),{ua:'mfa',ip:'127.0.0.1'}),{ok:false,error:'invalid'});
  assert.deepEqual(await snapshot(foreign.s),before);
  assert.equal((await completeSecondFactor(otherPending.challengeId,totpCode(secret),{ua:'mfa',ip:'127.0.0.1'})).ok,true);
});
test('bounded per-user mutation budgets serialize and reopen after fifteen minutes',async()=>{
  await flag(); const {s}=await tenant(), foreign=await tenant();
  for(let i=0;i<19;i++) assert.equal(await saveTenantProfile(s,await input(s)),'updated');
  const data=await input(s);
  assert.deepEqual((await Promise.all([saveTenantProfile(s,data),saveTenantProfile(s,data)])).sort(),['unavailable','updated']);
  let old=currentPassword;
  for(let i=0;i<10;i++) {
    const next=`RotatedSecret${i}X`;
    assert.equal(await changeTenantPassword(s,{currentPassword:old,password:next,confirm:next}),'changed'); old=next;
  }
  const before=await snapshot(s);
  assert.equal(await saveTenantProfile(s,await input(s)),'unavailable');
  assert.equal(await changeTenantPassword(s,{...passwordInput,currentPassword:old}),'unavailable');
  assert.deepEqual(await snapshot(s),before);
  assert.equal(await saveTenantProfile(foreign.s,await input(foreign.s)),'updated');
  await db.query(`UPDATE app.b020_profile_mutations SET window_start=now()-interval '16 minutes' WHERE user_id=$1`,[s.userId]);
  assert.equal(await saveTenantProfile(s,await input(s)),'updated');
  assert.equal(await changeTenantPassword(s,{...passwordInput,currentPassword:old}),'changed');
});


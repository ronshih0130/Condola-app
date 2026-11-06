import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import test, { mock } from 'node:test';
import { Client, type QueryResult } from 'pg';
import { acceptInvite, completeSecondFactor, hashInviteToken, signIn } from './auth';
import { query } from './db';
import { ORG_ID, USERS } from './ids';
import { resetAndSeed } from './seed';
import { startSignup } from './signup';
import { changeTenantPassword } from './tenant-profile';
import { cloneTestDatabase } from './test-database-clone';
import { totpCode } from './totp';
import type { Session } from './types';

const currentPassword = 'CurrentSecret72', password = 'NewSecret83';
const input = { currentPassword, password, confirm: password };
const meta = { ua: 'b020-epoch', ip: '127.0.0.1' };
const environment = ['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'TEAM_INVITES_ORG_ALLOWLIST'] as const;
const previous = environment.map(key => process.env[key]);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>>;
type QueryFn = (this: Client, sql: string, values?: unknown[]) => Promise<QueryResult>;

test.before(async () => {
  clone = await cloneTestDatabase();
  for (const key of environment) delete process.env[key];
  process.env.TEAM_INVITES_ORG_ALLOWLIST = ORG_ID;
  await resetAndSeed();
});
test.after(async () => {
  mock.restoreAll();
  for (const [i, key] of environment.entries()) {
    if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i];
  }
  await clone?.cleanup();
});
test.beforeEach(async () => {
  await query(`UPDATE platform_settings SET value='{"enabled":true}' WHERE key='session_hardening'`);
  await query(`UPDATE platform_settings SET value=$1::jsonb WHERE key='tenant_account_settings'`, [JSON.stringify({ enabled: true, allowed_org_ids: [ORG_ID] })]);
  await query(`UPDATE organizations SET feature_flags=feature_flags||'{"tenant_account_settings":true}'::jsonb,
    settings=settings-'require_2fa' WHERE id=$1`, [ORG_ID]);
});
test.afterEach(() => mock.restoreAll());

async function tenant(cost = 6) {
  const userId = randomUUID(), email = `${userId}@example.test`;
  await query(`INSERT INTO auth.users(id,email,encrypted_password,email_confirmed_at,role,aud)
    VALUES($1,$2,crypt($3,gen_salt('bf',$4)),now(),'authenticated','authenticated')`, [userId,email,currentPassword,cost]);
  const contact = (await query(`INSERT INTO contacts(org_id,user_id,email,display_name,is_tenant)
    VALUES($1,$2,$3,'Fixture',true) RETURNING id`, [ORG_ID,userId,email])).rows[0].id;
  async function newSession() {
    return (await query(`INSERT INTO auth_sessions(user_id,token_hash,expires_at)
      VALUES($1,$2,now()+interval '1 day') RETURNING id`, [userId,randomUUID()])).rows[0].id as string;
  }
  const s: Session = { userId,email,sessionId:await newSession(),name:'Fixture',kind:'tenant',role:null,
    orgId:ORG_ID,liveOrgId:ORG_ID,environment:'live',locale:'en',calendar:'gregorian',leaseId:null };
  return { s, contact, other: await newSession(), newSession };
}
async function liveSessions(s: Session) {
  return (await query(`SELECT id FROM auth_sessions WHERE user_id=$1 AND revoked_at IS NULL ORDER BY id`, [s.userId])).rows.map(r => r.id);
}
async function protocol(s: Session) {
  return (await query(`SELECT state,finished_at FROM app.b031_credential_changes WHERE user_id=$1 ORDER BY started_at DESC`, [s.userId])).rows;
}
async function snapshot(s: Session) {
  const tables = ['auth.users', 'public.auth_sessions', 'public.auth_challenges', 'public.user_mfa',
    'app.b020_profile_mutations', 'app.b031_credential_epochs', 'app.b031_challenge_epochs', 'app.b031_credential_changes'];
  const result: Record<string, unknown> = {};
  for (const table of tables) result[table] = (await query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE ${table==='auth.users'?'id':'user_id'}=$1 ORDER BY to_jsonb(t)::text`, [s.userId])).rows;
  result.attempts = (await query(`SELECT * FROM auth_login_attempts WHERE email=$1`, [s.email])).rows;
  result.audit = (await query(`SELECT * FROM audit_log WHERE actor_user_id=$1 ORDER BY id`, [s.userId])).rows;
  return result;
}

/** Pause after password verification/challenge loading but before the production fence.
 * The tenant change commits on independent database connections. */
function changeBeforeFence(s: Session) {
  const original = Client.prototype.query;
  let fired = false;
  mock.method(Client.prototype, 'query', (async function(this: Client, sql: string, values?: unknown[]) {
    if (!fired && sql.includes('SELECT app.b031_lock_credential_epoch(') && values?.[0] === s.userId) {
      fired = true;
      assert.equal(await changeTenantPassword(s,input),'changed');
    }
    return (original as QueryFn).call(this,sql,values);
  }) as typeof original);
  return () => assert.equal(fired,true,'stale request reached its production fence');
}

test('old-password login verified before tenant change cannot create a surviving session', async () => {
  const {s} = await tenant();
  const checked = changeBeforeFence(s);
  assert.deepEqual(await signIn(s.email,currentPassword,false,meta),{ok:false,error:'invalid'});
  checked();
  assert.deepEqual(await liveSessions(s),[s.sessionId]);
});
test('old-password signup verified before tenant change cannot create a session or consent', async () => {
  const {s} = await tenant();
  const checked = changeBeforeFence(s);
  assert.deepEqual(await startSignup({email:s.email,password:currentPassword,confirm:currentPassword,
    partnerCode:'',origin:'http://127.0.0.1:3000',meta,consent:true}),{ok:false,error:'duplicate'});
  checked();
  assert.deepEqual(await liveSessions(s),[s.sessionId]);
  assert.equal((await query(`SELECT 1 FROM consents WHERE user_id=$1`,[s.userId])).rowCount,0);
});
for (const kind of ['tenant','team_member'] as const) {
  test(`old-password ${kind} invitation verified before tenant change cannot create a session`, async () => {
    const {s,contact} = await tenant(), token = randomUUID();
    await query(`INSERT INTO invitations(org_id,email,role,kind,contact_id,code_hash,expires_at,invited_by)
      VALUES($1,$2,$3,$4,$5,$6,now()+interval '1 day',$7)`,
    [ORG_ID,s.email,kind==='team_member'?'manager':null,kind,kind==='tenant'?contact:null,hashInviteToken(token),USERS.admin]);
    const checked = changeBeforeFence(s);
    assert.deepEqual(await acceptInvite(token,'Fixture',currentPassword,currentPassword,meta,'','',true),{ok:false,error:'invalid',kind});
    checked();
    assert.deepEqual(await liveSessions(s),[s.sessionId]);
    assert.equal((await query(`SELECT status FROM invitations WHERE code_hash=$1`,[hashInviteToken(token)])).rows[0].status,'pending');
  });
}
for (const mode of ['enroll','2fa'] as const) {
  test(`loaded ${mode} challenge cannot write MFA/backup codes or create a session after tenant change`, async () => {
    const {s} = await tenant();
    const secret = 'JBSWY3DPEHPK3PXP';
    await query(`INSERT INTO org_members(org_id,user_id,role,status) VALUES($1,$2,'manager','active')`,[ORG_ID,s.userId]);
    await query(`UPDATE organizations SET settings=settings||'{"require_2fa":true}'::jsonb WHERE id=$1`,[ORG_ID]);
    if (mode==='2fa') await query(`INSERT INTO user_mfa(user_id,enabled,totp_secret) VALUES($1,true,$2)`,[s.userId,secret]);
    const opened = await signIn(s.email,currentPassword,false,meta);
    assert.ok(!opened.ok && 'step' in opened); assert.equal(opened.step,mode);
    const before = (await query(`SELECT * FROM user_mfa WHERE user_id=$1`,[s.userId])).rows;
    const checked = changeBeforeFence(s);
    assert.deepEqual(await completeSecondFactor(opened.challengeId,totpCode(opened.secret??secret),meta),{ok:false,error:'invalid'});
    checked();
    assert.deepEqual((await query(`SELECT * FROM user_mfa WHERE user_id=$1`,[s.userId])).rows,before);
    assert.deepEqual(await liveSessions(s),[s.sessionId]);
    assert.equal((await query(`SELECT 1 FROM auth_challenges WHERE user_id=$1`,[s.userId])).rowCount,0);
  });
}
test('successful local change retains only caller session, finishes twice-bumped epoch and preserves bcrypt cost', async () => {
  for (const cost of [6,11]) {
    const {s} = await tenant(cost), foreign = await tenant();
    const before = await snapshot(foreign.s);
    assert.equal(await changeTenantPassword(s,input),'changed');
    assert.deepEqual(await liveSessions(s),[s.sessionId]);
    assert.deepEqual(await snapshot(foreign.s),before);
    assert.equal((await protocol(s))[0].state,'done');
    assert.equal((await query(`SELECT epoch::text FROM app.b031_credential_epochs WHERE user_id=$1`,[s.userId])).rows[0].epoch,'2');
    const hash = (await query(`SELECT encrypted_password=crypt($2,encrypted_password) matches,split_part(encrypted_password,'$',3)::int cost FROM auth.users WHERE id=$1`,[s.userId,password])).rows[0];
    assert.equal(hash.matches,true); assert.equal(hash.cost,Math.max(10,cost));
  }
});
test('hardened reauthentication retains five-failure lockout without revoking sessions', async () => {
  const {s} = await tenant(), before = await liveSessions(s);
  for (let i=1;i<=5;i++) assert.equal(await changeTenantPassword(s,{...input,currentPassword:'WrongSecret9'}),i===5?'locked':'invalid');
  assert.equal(await changeTenantPassword(s,input),'locked');
  assert.deepEqual(await liveSessions(s),before);
  assert.deepEqual(await protocol(s),[]);
});
test('hardened tenant admission rejects archived, expired, forged-org and revoked sessions', async () => {
  const {s,contact} = await tenant();
  for (const forged of [{...s,environment:'sandbox' as const},{...s,sessionId:randomUUID()},{...s,orgId:randomUUID()}]) {
    const before = await snapshot(s);
    assert.equal(await changeTenantPassword(forged,input),'unavailable');
    assert.deepEqual(await snapshot(s),before);
  }
  await query(`UPDATE contacts SET archived_at=now() WHERE id=$1`,[contact]);
  const before = await snapshot(s);
  assert.equal(await changeTenantPassword(s,input),'unavailable');
  assert.deepEqual(await snapshot(s),before);
  for (const column of ['expires_at','revoked_at']) {
    const person = await tenant();
    await query(`UPDATE auth_sessions SET ${column}=now()-interval '1 second' WHERE id=$1`,[person.s.sessionId]);
    const denied = await snapshot(person.s);
    assert.equal(await changeTenantPassword(person.s,input),'unavailable');
    assert.deepEqual(await snapshot(person.s),denied);
  }
});
test('hardened mutation budget caps changes; window expiry and long old passwords retain #65 policy',async()=>{
  const {s}=await tenant();
  const old='ExistingSecret7'+'x'.repeat(60);
  await query(`UPDATE auth.users SET encrypted_password=crypt($2,gen_salt('bf')) WHERE id=$1`,[s.userId,old]);
  await query(`INSERT INTO app.b020_profile_mutations(user_id,kind,window_start,attempts) VALUES($1,'password',now(),10)`,[s.userId]);
  assert.equal(await changeTenantPassword(s,{...input,currentPassword:old}),'unavailable');
  assert.deepEqual(await protocol(s),[]);
  assert.equal((await query(`SELECT attempts FROM app.b020_profile_mutations WHERE user_id=$1`,[s.userId])).rows[0].attempts,10);
  await query(`UPDATE app.b020_profile_mutations SET window_start=now()-interval '16 minutes' WHERE user_id=$1`,[s.userId]);
  assert.equal(await changeTenantPassword(s,{...input,currentPassword:old}),'changed');
  assert.equal((await query(`SELECT attempts FROM app.b020_profile_mutations WHERE user_id=$1`,[s.userId])).rows[0].attempts,1);
});
test('phase 1 rechecks tenant flag after recovery and rolls back its epoch writes when disabled',async()=>{
  const {s}=await tenant();
  await query(`INSERT INTO app.b031_credential_epochs(user_id,epoch) VALUES($1,7)`,[s.userId]);
  const before=await snapshot(s);
  const original=Client.prototype.query;
  const recovery=new WeakSet<Client>();
  let disabled=false;
  mock.method(Client.prototype,'query',(async function(this:Client,sql:string,values?:unknown[]){
    if(sql.includes('SELECT app.b031_reconcile_credential_change(')) recovery.add(this);
    const result=await (original as QueryFn).call(this,sql,values);
    if(!disabled && recovery.has(this) && sql==='COMMIT') {
      disabled=true;
      await query(`UPDATE platform_settings SET value='{"enabled":false}' WHERE key='tenant_account_settings'`);
    }
    return result;
  }) as typeof original);
  assert.equal(await changeTenantPassword(s,input),'unavailable');
  assert.equal(disabled,true);
  assert.deepEqual(await snapshot(s),before);
});

for (const flag of ['global','organization'] as const) for (const existingEpoch of [true,false]) {
  test(`${flag} tenant flag disabled after preflight prevents overdue recovery writes (existing epoch: ${existingEpoch})`,async()=>{
    const {s}=await tenant();
    if(existingEpoch) await query(`INSERT INTO app.b031_credential_epochs(user_id,epoch) VALUES($1,7)`,[s.userId]);
    await query(`INSERT INTO app.b031_credential_changes(user_id,state,started_at)
      VALUES($1,'pending',now()-interval '121 seconds')`,[s.userId]);
    const challenge=(await query(`INSERT INTO auth_challenges(user_id,purpose,remember,expires_at)
      VALUES($1,'2fa',false,now()+interval '1 hour') RETURNING id`,[s.userId])).rows[0].id;
    await query(`INSERT INTO app.b031_challenge_epochs(challenge_id,user_id,epoch) VALUES($1,$2,7)`,[challenge,s.userId]);
    const before=await snapshot(s), original=Client.prototype.query;
    const preflight=new WeakSet<Client>();
    let disabled=false;
    mock.method(Client.prototype,'query',(async function(this:Client,sql:string,values?:unknown[]){
      if(sql.includes('SELECT * FROM app.b020_profile(')) preflight.add(this);
      const result=await (original as QueryFn).call(this,sql,values);
      if(!disabled && preflight.has(this) && sql==='COMMIT') {
        disabled=true;
        // The preflight's locks have been released; recovery has not started.
        if(flag==='global') await query(`UPDATE platform_settings SET value='{"enabled":false}' WHERE key='tenant_account_settings'`);
        else await query(`UPDATE organizations SET feature_flags=feature_flags||'{"tenant_account_settings":false}'::jsonb WHERE id=$1`,[ORG_ID]);
      }
      return result;
    }) as typeof original);
    assert.equal(await changeTenantPassword(s,input),'unavailable');
    assert.equal(disabled,true,'flag disabled after successful preflight commit');
    assert.deepEqual(await snapshot(s),before,'recovery must leave credentials, pending marker, sessions, challenges and budgets untouched');
  });
}

test('overdue recovery holds epoch and tenant authorization locks through its independent commit',async()=>{
  const {s}=await tenant();
  await query(`INSERT INTO app.b031_credential_epochs(user_id,epoch) VALUES($1,7)`,[s.userId]);
  await query(`INSERT INTO app.b031_credential_changes(user_id,state,started_at)
    VALUES($1,'pending',now()-interval '121 seconds')`,[s.userId]);
  const original=Client.prototype.query;
  const recovery=new WeakSet<Client>();
  let checked=0;
  mock.method(Client.prototype,'query',(async function(this:Client,sql:string,values?:unknown[]){
    if(sql.includes('SELECT app.b031_reconcile_credential_change(')) recovery.add(this);
    if(recovery.has(this) && (sql.includes('SELECT app.b031_reconcile_credential_change(') || sql==='COMMIT')) {
      const contender=new Client({connectionString:clone.url}); await contender.connect();
      try {
        await contender.query("SET lock_timeout='100ms'");
        for(const statement of [
          `SELECT 1 FROM app.b031_credential_epochs WHERE user_id=$1 FOR UPDATE`,
          `SELECT 1 FROM auth.users WHERE id=$1 FOR UPDATE`,
          `UPDATE platform_settings SET value='{"enabled":false}' WHERE key='tenant_account_settings' AND $1::uuid IS NOT NULL`,
          `UPDATE organizations SET feature_flags=feature_flags||'{"tenant_account_settings":false}'::jsonb WHERE id=$1`,
          `UPDATE contacts SET archived_at=now() WHERE user_id=$1`,
          `UPDATE auth_sessions SET revoked_at=now() WHERE id=$1`,
        ]) {
          const id=statement.includes('organizations')?s.orgId:statement.includes('auth_sessions')?s.sessionId:s.userId;
          await assert.rejects(contender.query(statement,[id]),{code:'55P03'});
        }
        checked++;
      } finally { await contender.end(); }
    }
    return (original as QueryFn).call(this,sql,values);
  }) as typeof original);
  assert.equal(await changeTenantPassword(s,input),'unavailable','committed recovery revokes the caller before phase 1 admission');
  assert.equal(checked,2,'locks held before reconciliation and immediately before commit');
  assert.equal((await query(`SELECT epoch::text FROM app.b031_credential_epochs WHERE user_id=$1`,[s.userId])).rows[0].epoch,'8');
  assert.deepEqual(await liveSessions(s),[]);
  assert.equal((await protocol(s))[0].state,'unknown');
  assert.ok((await protocol(s))[0].finished_at,'authorized recovery remains committed despite phase 1 rejection');
});

/** Real loopback HTTP, with the local DB standing in for GoTrue's independent commit. */
async function provider(s: Session, behavior: 'success'|'reject'|'lost'|'server-error', during: () => Promise<void>) {
  let failure: unknown, calls = 0;
  const server = createServer(async (request,response) => {
    try {
      assert.equal(request.method,'PUT');
      assert.equal(request.url,`/auth/v1/admin/users/${s.userId}`);
      let body = ''; for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      calls++;
      assert.equal((await protocol(s))[0].state,'pending');
      assert.deepEqual(await liveSessions(s),[s.sessionId]);
      // No epoch, account, tenant or session lock may span the HTTP request.
      const contender = new Client({connectionString:clone.url}); await contender.connect();
      try {
        await contender.query('BEGIN'); await contender.query("SET LOCAL lock_timeout='100ms'");
        await contender.query(`SELECT 1 FROM app.b031_credential_epochs WHERE user_id=$1 FOR UPDATE`,[s.userId]);
        await contender.query(`SELECT 1 FROM auth.users WHERE id=$1 FOR UPDATE`,[s.userId]);
        await contender.query(`SELECT 1 FROM contacts WHERE user_id=$1 FOR UPDATE`,[s.userId]);
        await contender.query(`SELECT 1 FROM auth_sessions WHERE user_id=$1 FOR UPDATE`,[s.userId]);
        await contender.query('ROLLBACK');
      } finally { await contender.end(); }
      assert.deepEqual(await signIn(s.email,currentPassword,false,meta),{ok:false,error:'invalid'});
      await during();
      if (behavior!=='reject') await query(`UPDATE auth.users SET encrypted_password=crypt($2,gen_salt('bf')) WHERE id=$1`,[s.userId,payload.password]);
      if (behavior==='lost') return;
      response.writeHead(behavior==='reject'?422:behavior==='server-error'?500:200,{'Content-Type':'application/json'});
      response.end('{}');
    } catch (error) { failure=error; response.destroy(); }
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address = server.address(); assert.ok(address && typeof address!=='string');
  process.env.SUPABASE_URL=`http://127.0.0.1:${address.port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY='loopback-fixture-only';
  return async () => {
    delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    server.closeAllConnections();
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    if (failure) throw failure;
    assert.equal(calls,1);
  };
}
for (const behavior of ['success','reject','lost','server-error'] as const) {
  test(`hosted ${behavior}: durable phase 1, bounded provider, phase 2 outcome and gap-session revocation`,{timeout:15000},async () => {
    const {s,newSession} = await tenant();
    const close = await provider(s,behavior,async()=>{ await newSession(); });
    if (behavior==='lost') {
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      mock.method(AbortSignal,'timeout',(ms:number)=>{assert.ok(ms>0&&ms<=90000); return timeout(750);});
    }
    try {
      assert.equal(await changeTenantPassword(s,input),behavior==='success'?'changed':'unavailable');
      assert.equal((await protocol(s))[0].state,behavior==='success'?'done':behavior==='reject'?'failed':'unknown');
      assert.deepEqual(await liveSessions(s),[s.sessionId]);
      if (behavior==='lost'||behavior==='server-error') {
        assert.equal((await protocol(s))[0].finished_at,null);
        assert.deepEqual(await signIn(s.email,password,false,meta),{ok:false,error:'invalid'});
        await query(`UPDATE app.b031_credential_changes SET started_at=now()-interval '121 seconds' WHERE user_id=$1`,[s.userId]);
        assert.equal((await signIn(s.email,password,false,meta)).ok,true,'production login reconciles unknown');
        assert.ok((await protocol(s))[0].finished_at);
      }
    } finally { await close(); }
  });
}
test('hosted configuration without service key rejects before any writes',async()=>{
  const {s}=await tenant(), before=await snapshot(s);
  process.env.SUPABASE_URL='http://127.0.0.1:1'; delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try { assert.equal(await changeTenantPassword(s,input),'unavailable'); assert.deepEqual(await snapshot(s),before); }
  finally { delete process.env.SUPABASE_URL; }
});
test('phase-2 failure leaves committed password and durable pending revocations for recovery',async()=>{
  const {s}=await tenant();
  const original=Client.prototype.query;
  const injection=mock.method(Client.prototype,'query',(async function(this:Client,sql:string,values?:unknown[]){
    if(sql.includes('SELECT app.b031_finish_credential_change(')) throw new Error('injected finish failure');
    return (original as QueryFn).call(this,sql,values);
  }) as typeof original);
  assert.equal(await changeTenantPassword(s,input),'unavailable'); injection.mock.restore();
  assert.equal((await protocol(s))[0].state,'pending');
  assert.deepEqual(await liveSessions(s),[s.sessionId]);
  assert.equal((await query(`SELECT encrypted_password=crypt($2,encrypted_password) ok FROM auth.users WHERE id=$1`,[s.userId,password])).rows[0].ok,true);
  assert.deepEqual(await signIn(s.email,password,false,meta),{ok:false,error:'invalid'});
  await query(`UPDATE app.b031_credential_changes SET started_at=now()-interval '121 seconds' WHERE user_id=$1`,[s.userId]);
  assert.equal((await signIn(s.email,password,false,meta)).ok,true);
  assert.ok((await protocol(s))[0].finished_at);
});
for(const global of [{enabled:false},{},{enabled:'true'}]) {
  test(`tenant flag ${JSON.stringify(global)}: zero writes even with an overdue pending credential change`,async()=>{
    const {s}=await tenant();
    await query(`INSERT INTO app.b031_credential_changes(user_id,state,started_at) VALUES($1,'pending',now()-interval '121 seconds')`,[s.userId]);
    await query(`UPDATE platform_settings SET value=$1::jsonb WHERE key='tenant_account_settings'`,[JSON.stringify(global)]);
    const before=await snapshot(s);
    assert.equal(await changeTenantPassword(s,input),'unavailable');
    assert.deepEqual(await snapshot(s),before);
  });
}

// Frozen statement sequence of #65 changeTenantPassword + scoped/svc + recordAudit.
// The only permitted addition is B-031's one read-only flag probe, as in its OFF fixtures.
const legacyTrace = [
  'BEGIN',
  "SELECT set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', 'service_role', true)",
  'SET LOCAL ROLE service_role',
  "SELECT set_config('app.active_org_id',$1,true),set_config('app.env',$2,true)",
  "SET LOCAL lock_timeout='5s'",
  'SELECT app.b020_change_password($1,$2,$3,$4,$5,$6) state',
];
const legacyAudit = `INSERT INTO audit_log
    (org_id, actor_user_id, actor_role, table_name, row_id, action,
     event_type, new_row, reason, request_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`;
for(const outcome of ['changed','invalid','off'] as const) {
  test(`session_hardening OFF: #65 ${outcome} statement trace and behavior unchanged`,async()=>{
    const {s}=await tenant();
    await query(`UPDATE platform_settings SET value='{"enabled":false}' WHERE key='session_hardening'`);
    if(outcome==='off') await query(`UPDATE platform_settings SET value='{"enabled":false}' WHERE key='tenant_account_settings'`);
    const before=await snapshot(s), statements:string[]=[];
    const original=Client.prototype.query;
    const trace=mock.method(Client.prototype,'query',(async function(this:Client,sql:string,values?:unknown[]){
      statements.push(sql); return (original as QueryFn).call(this,sql,values);
    }) as typeof original);
    const result=await changeTenantPassword(s,outcome==='invalid'?{...input,currentPassword:'WrongSecret9'}:input);
    trace.mock.restore();
    assert.equal(result,outcome==='off'?'unavailable':outcome);
    assert.equal(statements.shift(),'SELECT app.b031_session_hardening_enabled() AS enabled');
    assert.deepEqual(statements,[...legacyTrace,...(outcome==='changed'?[legacyAudit]:[]),outcome==='off'?'ROLLBACK':'COMMIT']);
    assert.deepEqual(await protocol(s),[]);
    assert.equal((await query(`SELECT 1 FROM app.b031_credential_epochs WHERE user_id=$1`,[s.userId])).rowCount,0);
    if(outcome==='changed') assert.deepEqual(await liveSessions(s),[s.sessionId]);
    if(outcome==='off') assert.deepEqual(await snapshot(s),before);
  });
}

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { query, withClient } from './db';
import { ORG_ID, ORG2_ID, USERS } from './ids';
import { resetAndSeed } from './seed';
import { cloneTestDatabase } from './test-database-clone';
import { disposableDbUrl } from './test-disposable-db';
import { companyProfileView, saveCompanyProfile, type CompanyData } from './company-profiles';
import { createCompanyEmailChange } from './company-email-change';
import { generateStatement } from './domain';
import { statementPdfSource } from './queries';
import { statementPdfForSession } from './pdf-download';
import { buildStatementPdf } from './pdf-docs';
import { makeT } from '@/i18n';
import { renderPdf } from '@/lib/pdf-render';
import type { Session } from './types';

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>> | undefined;
test.before(async () => { clone = await cloneTestDatabase(); });
test.after(async () => { await clone?.cleanup(); });
test.beforeEach(async () => {
  await resetAndSeed();
  await query(`DELETE FROM platform_settings WHERE key IN ('company_profile_edit','design_partner_consent_gate')`);
  await query(`UPDATE organizations SET feature_flags=feature_flags-'company_profile_edit'-'design_partner_consent_gate'`);
});
const data: CompanyData = { legal_name: 'Synthetic firm', tax_id: 'self-reported-id', address: { city: 'City', district: 'District', street: 'Private street' } };
async function actor(userId: string = USERS.admin, role: Session['role'] = 'admin'): Promise<Session> {
  const sessionId = randomUUID();
  await query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`, [sessionId, userId, randomUUID()]);
  return { userId, sessionId, orgId: ORG_ID, liveOrgId: ORG_ID, kind: 'staff', role, environment: 'live', locale: 'en', calendar: 'gregorian', leaseId: null, email: 'synthetic@example.test', name: 'Synthetic' };
}
async function enable() {
  await query(`INSERT INTO platform_settings(key,value) VALUES('company_profile_edit',$1::jsonb) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [JSON.stringify({ enabled: true, allowed_org_ids: [ORG_ID] })]);
  await query(`UPDATE organizations SET feature_flags=feature_flags||'{"company_profile_edit":true}'::jsonb WHERE id=$1`, [ORG_ID]);
}
async function counts() {
  return (await query(`SELECT (SELECT count(*)::int FROM app.b016_company_profiles) AS profiles,
    (SELECT count(*)::int FROM app.b016_company_profile_versions) AS versions,
    (SELECT count(*)::int FROM app.b016_pending_email_changes) AS pending,
    (SELECT count(*)::int FROM audit_log WHERE event_type IN ('company_profile_saved','company_profile_save_confirmed','staff_email_changed')) AS audits`)).rows[0];
}
async function direct(s: Session, op: string | null, payload: object, email = false) {
  return withClient(async c => {
    await c.query('BEGIN');
    try {
      await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env',$3,true)`, [s.userId, s.orgId, s.environment]);
      await c.query('SET LOCAL ROLE service_role');
      const r = (await c.query(`SELECT app.${email ? 'b016_email_gateway' : 'b016_company_profile_gateway'}($1,$2,$3,$4::jsonb) AS result`, [s.sessionId, s.orgId, op, JSON.stringify(payload)])).rows[0].result;
      await c.query('COMMIT'); return r;
    } catch (e) { await c.query('ROLLBACK'); throw e; }
  });
}
function save(s: Session, expectedVersion: string | null = null, requestId = randomUUID(), d = data) {
  return saveCompanyProfile(s, { data: d, expectedVersion, requestId });
}

test('Admin save creates immutable versions and metadata-only masked gateway + recordAudit receipts', async () => {
  await enable(); const s = await actor();
  const first = await save(s); assert.equal(first.state, 'updated'); assert.ok(first.version);
  const view = await companyProfileView(s); assert.deepEqual(view.data, data); assert.equal(view.version, first.version);
  assert.deepEqual(await counts(), { profiles: 1, versions: 1, pending: 0, audits: 2 });
  const audits = (await query(`SELECT new_row FROM audit_log WHERE event_type LIKE 'company_profile_%'`)).rows;
  assert.ok(audits.every(r => !JSON.stringify(r).includes('Private street') && !JSON.stringify(r).includes(data.tax_id) && JSON.stringify(r).includes('[masked]')));
  await assert.rejects(query(`UPDATE app.b016_company_profile_versions SET data=data WHERE id=$1`, [first.version]), /immutable/);
  await assert.rejects(query(`DELETE FROM app.b016_company_profile_versions WHERE id=$1`, [first.version]), /immutable/);
});

test('non-Admin, forged role, foreign org, sandbox, revoked, expired and foreign session deny at both boundaries', async () => {
  await enable(); const s = await actor(), manager = await actor(USERS.manager, 'manager');
  for (const invalid of [manager, { ...manager, role: 'admin' as const }, { ...s, orgId: ORG2_ID, liveOrgId: ORG2_ID },
    { ...s, environment: 'sandbox' as const }, { ...s, userId: USERS.manager }, { ...s, sessionId: randomUUID() }]) {
    assert.equal((await save(invalid)).state, 'denied');
    assert.equal((await direct(invalid, 'save', { data, expected_version: null, request_id: randomUUID() })).state, 'denied');
  }
  for (const column of ['revoked_at', 'expires_at']) {
    const a = await actor(); await query(`UPDATE auth_sessions SET ${column}=clock_timestamp()-interval '1 second' WHERE id=$1`, [a.sessionId]);
    assert.equal((await save(a)).state, 'denied'); assert.equal((await direct(a, 'read', {})).state, 'denied');
  }
  assert.deepEqual(await counts(), { profiles: 0, versions: 0, pending: 0, audits: 0 });
});

test('stale expected version, idempotent replay and request payload substitution', async () => {
  await enable(); const s = await actor(), request = randomUUID();
  const first = await save(s, null, request); assert.equal(first.state, 'updated');
  assert.deepEqual(await save(s, null, request), { state: 'replayed', version: first.version });
  assert.equal((await save(s)).state, 'stale');
  assert.equal((await save(s, null, request, { ...data, legal_name: 'Different' })).state, 'invalid');
  assert.equal((await save(s, first.version!, randomUUID(), { ...data, legal_name: 'New version' })).state, 'updated');
  assert.equal((await counts()).versions, 2);
});

test('simultaneous first saves serialize: exactly one version wins', async () => {
  await enable(); const s = await actor();
  const outcomes = await Promise.all([save(s), save(s)]);
  assert.deepEqual(outcomes.map(r => r.state).sort(), ['stale', 'updated']);
  assert.equal((await counts()).versions, 1);
});

test('unsupported region and malformed regional data fail closed in the gateway', async () => {
  await enable(); const s = await actor();
  for (const bad of [{ ...data, address: { city: 'City', district: '', street: '' } }, { ...data, extra: 'invented' }, { ...data, legal_name: '' }]) {
    assert.equal((await direct(s, 'save', { data: bad, expected_version: null, request_id: randomUUID() })).state, 'invalid');
  }
  await query(`UPDATE organizations SET country_code='US' WHERE id=$1`, [ORG_ID]);
  assert.equal((await save(s)).state, 'unavailable'); assert.equal((await counts()).versions, 0);
});

test('issued report and PDF source retain the old company version after a new save and replay', async () => {
  await enable(); const s = await actor(), first = await save(s);
  const owner = (await query(`SELECT owner_contact_id::text AS id FROM property_owners WHERE org_id=$1 ORDER BY owner_contact_id LIMIT 1`, [ORG_ID])).rows[0].id;
  const january = await generateStatement(s, { ownerContactId: owner, month: '2199-01' });
  const stored = async () => (await query(`SELECT company_profile_version_id,company_profile_snapshot FROM owner_statements WHERE id=$1`, [january.statementId])).rows[0];
  const before = await stored(); assert.equal(before.company_profile_version_id, first.version); assert.deepEqual(before.company_profile_snapshot.data, data);
  assert.equal((await save(s, first.version!, randomUUID(), { ...data, legal_name: 'Later firm' })).state, 'updated');
  assert.equal((await generateStatement(s, { ownerContactId: owner, month: '2199-01' })).statementId, january.statementId);
  assert.deepEqual(await stored(), before);
  assert.deepEqual((await statementPdfSource(s, january.statementId))?.statement.companyProfile?.data, data);
  await assert.rejects(query(`UPDATE owner_statements SET company_profile_snapshot='{}' WHERE id=$1`, [january.statementId]), /immutable/);
  const february = await generateStatement(s, { ownerContactId: owner, month: '2199-02' });
  assert.equal((await statementPdfSource(s, february.statementId))?.statement.companyProfile?.data.legal_name, 'Later firm');
});

type Delivery = { id: string; current: string; target: string; currentToken: string; targetToken: string };
async function mock(s: Session, canonical = true, onVerify?: () => Promise<void>) {
  const current = (await query(`SELECT email::text FROM auth.users WHERE id=$1`, [s.userId])).rows[0].email;
  const target = `target-${randomUUID()}@example.test`;
  let delivery: Delivery | undefined, calls = 0, verifications = 0;
  const user = (email: string) => ({ id: s.userId, email, email_confirmed_at: '2026-01-01T00:00:00Z', is_anonymous: false,
    app_metadata: { provider: 'email', providers: ['email'] }, identities: [{ id: 'mock-identity', user_id: s.userId, provider: 'email', identity_data: { email, email_verified: true } }] });
  const flow = createCompanyEmailChange({ capture: async d => { delivery = d; }, transport: async (url, init) => {
    calls++; let body: unknown;
    if (url.includes('/token?')) body = { access_token: 'mock-bearer', user: { id: s.userId } };
    else if (init.method === 'GET') body = user(current);
    else if (init.method === 'PUT') body = { id: s.userId, new_email: target };
    else {
      verifications++;
      await onVerify?.();
      if (verifications === 1) body = { msg: 'Confirmation link accepted. Please proceed to confirm link sent to the other email', code: '200' };
      else {
        if (canonical) await query(`UPDATE auth.users SET email=$2,updated_at=clock_timestamp() WHERE id=$1`, [s.userId, target]);
        body = { user: user(target) };
      }
    }
    return { status: 200, json: async () => body };
  } });
  return { flow, target, current, get delivery() { assert.ok(delivery); return delivery; }, get calls() { return calls; }, get verifications() { return verifications; } };
}

test('durable A2 initiate, partial verification and final canonical CAS commit exactly once in both orders', async () => {
  await enable();
  for (const order of [['current', 'target'], ['target', 'current']] as const) {
    const s = await actor(order[0] === 'current' ? USERS.manager : USERS.accountant, order[0] === 'current' ? 'manager' : 'accountant');
    const h = await mock(s), req = randomUUID();
    assert.equal((await h.flow.initiate(s, { target: h.target, password: 'mock', requestId: req })).state, 'pending');
    const calls = h.calls;
    assert.equal((await h.flow.initiate(s, { target: h.target, password: 'mock', requestId: req })).state, 'replayed'); assert.equal(h.calls, calls);
    const p = h.delivery;
    const raw = (await query(`SELECT * FROM app.b016_pending_email_changes WHERE id=$1`, [p.id])).rows[0];
    assert.ok(!JSON.stringify(raw).includes(p.currentToken) && !JSON.stringify(raw).includes(p.targetToken));
    for (const [i, mailbox] of order.entries()) {
      const token = mailbox === 'current' ? p.currentToken : p.targetToken;
      assert.equal((await h.flow.verify(s, { id: p.id, mailbox, token })).state, i === 0 ? 'partial' : 'committed');
      if (i === 0) {
        assert.equal((await query(`SELECT email::text FROM profiles WHERE id=$1`, [s.userId])).rows[0].email, h.current);
        assert.equal((await query(`SELECT email::text FROM auth.users WHERE id=$1`, [s.userId])).rows[0].email, h.current);
        assert.equal((await h.flow.verify(s, { id: p.id, mailbox, token })).state, 'rejected');
      }
    }
    assert.equal((await h.flow.verify(s, { id: p.id, mailbox: 'target', token: p.targetToken })).state, 'rejected');
    assert.equal((await query(`SELECT email::text FROM profiles WHERE id=$1`, [s.userId])).rows[0].email, h.target);
    assert.equal((await query(`SELECT count(*)::int AS n FROM audit_log WHERE event_type='staff_email_changed' AND actor_user_id=$1`, [s.userId])).rows[0].n, 1);
  }
});

test('A2 foreign, incorrect and expired tokens never call provider verification', async () => {
  await enable(); const s = await actor(), h = await mock(s);
  await h.flow.initiate(s, { target: h.target, password: 'mock', requestId: randomUUID() });
  const p = h.delivery, calls = h.calls, foreign = await actor(USERS.manager, 'manager');
  assert.equal((await h.flow.verify(foreign, { id: p.id, mailbox: 'current', token: p.currentToken })).state, 'invalid');
  assert.equal((await h.flow.verify({ ...s, orgId: ORG2_ID, liveOrgId: ORG2_ID }, { id: p.id, mailbox: 'current', token: p.currentToken })).state, 'denied');
  assert.equal((await h.flow.verify(s, { id: p.id, mailbox: 'current', token: '0'.repeat(20) })).state, 'rejected');
  await query(`UPDATE app.b016_pending_email_changes SET created_at=now()-interval '31 minutes',expires_at=now()-interval '1 minute' WHERE id=$1`, [p.id]);
  assert.equal((await h.flow.verify(s, { id: p.id, mailbox: 'target', token: p.targetToken })).state, 'expired');
  assert.equal(h.calls, calls); assert.equal((await counts()).audits, 0);
});

test('A2 unresolved provider states block a fresh initiation even after expiry (no extra provider call)', async () => {
  for (const state of ['verifying', 'uncertain', 'unknown']) {
    await enable(); const s = await actor(), h = await mock(s);
    await h.flow.initiate(s, { target: h.target, password: 'mock', requestId: randomUUID() });
    const p = h.delivery;
    await query(`UPDATE app.b016_pending_email_changes SET state=$2,attempt_id=coalesce(attempt_id,gen_random_uuid()),attempt_mailbox=coalesce(attempt_mailbox,'current'),created_at=now()-interval '31 minutes',expires_at=now()-interval '1 minute' WHERE id=$1`, [p.id, state]);
    const calls = h.calls;
    assert.equal((await h.flow.initiate(s, { target: h.target, password: 'mock', requestId: randomUUID() })).state, 'stale', state);
    assert.equal(h.calls, calls, `${state}: no provider call`);
    await query(`DELETE FROM app.b016_pending_email_changes WHERE user_id=$1`, [s.userId]);
  }
});

test('A2 provider final candidate without independent canonical change cannot commit', async () => {
  await enable(); const s = await actor(), h = await mock(s, false);
  await h.flow.initiate(s, { target: h.target, password: 'mock', requestId: randomUUID() });
  const p = h.delivery;
  assert.equal((await h.flow.verify(s, { id: p.id, mailbox: 'current', token: p.currentToken })).state, 'partial');
  assert.equal((await h.flow.verify(s, { id: p.id, mailbox: 'target', token: p.targetToken })).state, 'stale');
  assert.equal((await query(`SELECT email::text FROM profiles WHERE id=$1`, [s.userId])).rows[0].email, h.current);
  assert.equal((await counts()).audits, 0);
});

test('strict flag OFF matrix: controllers and service gateways create zero rows and transport calls', async () => {
  const s = await actor(), h = await mock(s);
  const matrix: [unknown, unknown][] = [
    [null, true], [false, true], [{ enabled: 'true', allowed_org_ids: [ORG_ID] }, true],
    [{ enabled: true, allowed_org_ids: [] }, true], [{ enabled: true, allowed_org_ids: [ORG_ID, 123] }, true],
    [{ enabled: true, allowed_org_ids: [ORG2_ID] }, true], [{ enabled: true, allowed_org_ids: 'all' }, true],
    ...[false, 'true', null, {}, []].map(v => [{ enabled: true, allowed_org_ids: [ORG_ID] }, v] as [unknown, unknown]),
  ];
  for (const [global, local] of matrix) {
    await query(`INSERT INTO platform_settings(key,value) VALUES('company_profile_edit',$1::jsonb) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [JSON.stringify(global)]);
    await query(`UPDATE organizations SET feature_flags=jsonb_set(feature_flags,'{company_profile_edit}',$2::jsonb) WHERE id=$1`, [ORG_ID, JSON.stringify(local)]);
    assert.equal((await save(s)).state, 'denied');
    assert.equal((await direct(s, 'save', { data, expected_version: null, request_id: randomUUID() })).state, 'denied');
    assert.equal((await h.flow.initiate(s, { target: h.target, password: 'mock', requestId: randomUUID() })).state, 'denied');
    for (const op of ['begin', 'started', 'verify']) assert.equal((await direct(s, op, {}, true)).state, 'denied');
  }
  assert.equal(h.calls, 0); assert.deepEqual(await counts(), { profiles: 0, versions: 0, pending: 0, audits: 0 });
});

test('OFF after initiation preserves pending and canonical/profile mirrors', async () => {
  await enable(); const s = await actor(), h = await mock(s);
  await h.flow.initiate(s, { target: h.target, password: 'mock', requestId: randomUUID() });
  const p = h.delivery, before = (await query(`SELECT * FROM app.b016_pending_email_changes WHERE id=$1`, [p.id])).rows[0], calls = h.calls;
  await query(`DELETE FROM platform_settings WHERE key='company_profile_edit'`);
  assert.equal((await h.flow.verify(s, { id: p.id, mailbox: 'current', token: p.currentToken })).state, 'denied');
  assert.deepEqual((await query(`SELECT * FROM app.b016_pending_email_changes WHERE id=$1`, [p.id])).rows[0], before);
  assert.equal(h.calls, calls);
});

test('audit failure rolls back gateway version, pointer and app receipt together', async () => {
  await enable(); const s = await actor(); const original = Client.prototype.query;
  try {
    Object.defineProperty(Client.prototype, 'query', { configurable: true, writable: true, value: function(this: Client, ...args: unknown[]) {
      if (typeof args[0] === 'string' && args[0].startsWith('INSERT INTO audit_log')) return Reflect.apply(original, this, ['SELECT 1/0']);
      return Reflect.apply(original, this, args);
    } });
    assert.equal((await save(s)).state, 'unavailable');
  } finally { Object.defineProperty(Client.prototype, 'query', { configurable: true, writable: true, value: original }); }
  assert.deepEqual(await counts(), { profiles: 0, versions: 0, pending: 0, audits: 0 });
});

test('private privilege catalog: RLS, no direct table ACL and pinned service-only gateways', async () => {
  const tables = (await query(`SELECT c.relname,c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relname IN ('b016_company_profiles','b016_company_profile_versions','b016_pending_email_changes')`)).rows;
  assert.equal(tables.length, 3); assert.ok(tables.every(t => t.relrowsecurity));
  for (const role of ['anon', 'authenticated', 'service_role']) for (const table of tables) {
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      assert.equal((await query(`SELECT has_table_privilege($1,$2,$3) AS allowed`, [role, `app.${table.relname}`, privilege])).rows[0].allowed, false);
    }
  }
  const funcs = (await query(`SELECT oid::regprocedure::text AS name,proname,prosecdef,proconfig FROM pg_proc WHERE pronamespace='app'::regnamespace AND proname LIKE 'b016_%'`)).rows;
  assert.equal(funcs.length, 6);
  for (const f of funcs) {
    assert.ok(f.proconfig.includes('search_path=pg_catalog'));
    for (const role of ['anon', 'authenticated', 'service_role']) {
      assert.equal((await query('SELECT has_function_privilege($1,$2,\'EXECUTE\') AS allowed', [role, f.name])).rows[0].allowed,
        role === 'service_role' && ['b016_company_profile_gateway', 'b016_email_gateway'].includes(f.proname));
    }
    if (f.proname.endsWith('gateway')) assert.equal(f.prosecdef, true);
  }
});

test('A2 canonical version changes at the commit boundary reject restored-value races', async () => {
  await enable(); const s = await actor(), h = await mock(s);
  await h.flow.initiate(s, { target: h.target, password: 'mock', requestId: randomUUID() });
  const p = h.delivery;
  assert.equal((await h.flow.verify(s, { id: p.id, mailbox: 'current', token: p.currentToken })).state, 'partial');
  const original = Client.prototype.query; let changed = false;
  try {
    Object.defineProperty(Client.prototype, 'query', { configurable: true, writable: true, value: function(this: Client, ...args: unknown[]) {
      const params = args[1] as unknown[] | undefined;
      if (!changed && typeof args[0] === 'string' && args[0].includes('app.b016_email_gateway') && params?.[2] === 'verify') {
        changed = true;
        return query(`UPDATE auth.users SET updated_at=clock_timestamp() WHERE id=$1`, [s.userId]).then(() => Reflect.apply(original, this, args));
      }
      return Reflect.apply(original, this, args);
    } });
    assert.equal((await h.flow.verify(s, { id: p.id, mailbox: 'target', token: p.targetToken })).state, 'stale');
  } finally { Object.defineProperty(Client.prototype, 'query', { configurable: true, writable: true, value: original }); }
  assert.equal(changed, true);
  assert.equal((await query(`SELECT email::text FROM profiles WHERE id=$1`, [s.userId])).rows[0].email, h.current);
  assert.equal((await query(`SELECT consumed_at FROM app.b016_pending_email_changes WHERE id=$1`, [p.id])).rows[0].consumed_at, null);
});

test('invalid latest consent denies controller writes and flag OFF leaves new reports without extensions', async () => {
  await enable(); const s = await actor();
  await query(`INSERT INTO consents(user_id,accepted_at,terms_version,privacy_version,source,recorded_at) VALUES($1,clock_timestamp(),'2000-01-01','2000-01-01','reconsent',clock_timestamp()+interval '1 second')`, [s.userId]);
  assert.equal((await save(s)).state, 'denied');
  await query(`DELETE FROM platform_settings WHERE key='company_profile_edit'`);
  const owner = (await query(`SELECT owner_contact_id::text AS id FROM property_owners WHERE org_id=$1 ORDER BY owner_contact_id LIMIT 1`, [ORG_ID])).rows[0].id;
  const report = await generateStatement(s, { ownerContactId: owner, month: '2199-01' });
  const row = (await query(`SELECT company_profile_version_id,company_profile_snapshot FROM owner_statements WHERE id=$1`, [report.statementId])).rows[0];
  assert.deepEqual(row, { company_profile_version_id: null, company_profile_snapshot: null });
  assert.deepEqual(await counts(), { profiles: 0, versions: 0, pending: 0, audits: 0 });
});

for (const secondMailbox of ['current', 'target'] as const) {
  test(`A2 concurrent ${secondMailbox === 'current' ? 'duplicate token' : 'opposite mailbox'} reserves one durable attempt and calls provider exactly once`, async () => {
    await enable(); const s = await actor();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const h = await mock(s, true, async () => { entered(); await held; });
    assert.equal((await h.flow.initiate(s, { target: h.target, password: 'mock', requestId: randomUUID() })).state, 'pending');
    const p = h.delivery;
    const first = h.flow.verify(s, { id: p.id, mailbox: 'current', token: p.currentToken });
    try {
      await started;
      const row = (await query(`SELECT state,attempt_id,attempt_mailbox FROM app.b016_pending_email_changes WHERE id=$1`, [p.id])).rows[0];
      assert.equal(row.state, 'verifying'); assert.ok(row.attempt_id); assert.equal(row.attempt_mailbox, 'current');
      const second = await h.flow.verify(s, { id: p.id, mailbox: secondMailbox, token: secondMailbox === 'current' ? p.currentToken : p.targetToken });
      assert.equal(second.state, 'verifying');
      assert.equal(h.verifications, 1);
      assert.equal((await direct(s, 'verify', { id: p.id, attempt_id: randomUUID() }, true)).state, 'stale');
    } finally { release(); }
    assert.equal((await first).state, 'partial');
    assert.equal(h.verifications, 1);
    const row = (await query(`SELECT state,attempt_id,current_verified,target_verified FROM app.b016_pending_email_changes WHERE id=$1`, [p.id])).rows[0];
    assert.deepEqual(row, { state: 'pending', attempt_id: null, current_verified: true, target_verified: false });
  });
}

test('A2 ambiguous provider outcome persists uncertain and neither mailbox can retry', async () => {
  await enable(); const s = await actor(), h = await mock(s, true, async () => { throw new Error('ambiguous transport'); });
  assert.equal((await h.flow.initiate(s, { target: h.target, password: 'mock', requestId: randomUUID() })).state, 'pending');
  const p = h.delivery;
  assert.equal((await h.flow.verify(s, { id: p.id, mailbox: 'current', token: p.currentToken })).state, 'uncertain');
  const before = (await query(`SELECT * FROM app.b016_pending_email_changes WHERE id=$1`, [p.id])).rows[0];
  assert.equal(before.state, 'uncertain'); assert.ok(before.attempt_id);
  for (const mailbox of ['current', 'target'] as const) {
    assert.equal((await h.flow.verify(s, { id: p.id, mailbox, token: mailbox === 'current' ? p.currentToken : p.targetToken })).state, 'uncertain');
  }
  assert.equal(h.verifications, 1);
  assert.deepEqual((await query(`SELECT * FROM app.b016_pending_email_changes WHERE id=$1`, [p.id])).rows[0], before);
  assert.equal((await query(`SELECT email::text FROM profiles WHERE id=$1`, [s.userId])).rows[0].email, h.current);
});

test('pending insertion repeatedly derives the exact 30 minute lifetime from one clock sample', async () => {
  await enable(); const s = await actor();
  const current = (await query(`SELECT lower(email)::text AS email FROM auth.users WHERE id=$1`, [s.userId])).rows[0].email;
  for (let i = 0; i < 40; i++) {
    const id = randomUUID();
    const r = await direct(s, 'begin', { id, request_id: randomUUID(), current, target: `pending-${i}@example.test`, current_hash: 'a'.repeat(64), target_hash: 'b'.repeat(64) }, true);
    assert.equal(r.state, 'reserved');
    assert.equal((await query(`SELECT expires_at-created_at=interval '30 minutes' AS exact FROM app.b016_pending_email_changes WHERE id=$1`, [id])).rows[0].exact, true);
    await query(`UPDATE app.b016_pending_email_changes SET created_at=now()-interval '31 minutes',expires_at=now()-interval '1 minute' WHERE id=$1`, [id]);
  }
  assert.equal((await counts()).pending, 40);
});

test('ON issuance then OFF rendering matches legacy PDF bytes with the historical snapshot retained', async t => {
  await enable(); const s = await actor(), saved = await save(s);
  const owner = (await query(`SELECT owner_contact_id::text AS id FROM property_owners WHERE org_id=$1 ORDER BY owner_contact_id LIMIT 1`, [ORG_ID])).rows[0].id;
  const { statementId } = await generateStatement(s, { ownerContactId: owner, month: '2199-01' });
  const historical = async () => (await query(`SELECT company_profile_version_id,company_profile_snapshot FROM owner_statements WHERE id=$1`, [statementId])).rows[0];
  const stored = await historical(); assert.equal(stored.company_profile_version_id, saved.version);
  const source = await statementPdfSource(s, statementId); assert.ok(source);
  const row = source.statement;
  const legacy = buildStatementPdf({
    id: row.id, orgId: row.orgId, ownerName: row.ownerName, periodStart: row.periodStart, periodEnd: row.periodEnd,
    currency: row.currency.trim(), opening: Number(row.opening), rent: Number(row.rent), other: Number(row.other),
    fee: Number(row.fee), expenses: Number(row.expenses), payouts: Number(row.payouts), closing: Number(row.closing),
    lines: source.lines.map(l => ({ ...l, amount: Number(l.amount) })), addresses: [], audience: 'staff',
  }, s.locale, s.calendar, makeT(s.locale));
  const font = readFileSync(new URL('../../public/fonts/DroidSansFallback-subset.ttf', import.meta.url));
  // Freeze only PDF metadata timestamps; compare every emitted byte.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const legacyBytes = await renderPdf(legacy, font);
  const on = await statementPdfForSession(s, statementId); assert.ok(on);
  assert.ok(JSON.stringify(on).includes(data.tax_id));
  assert.notDeepEqual(await renderPdf(on, font), legacyBytes);
  // Disable only the global switch while local opt-in remains true.
  await query(`UPDATE platform_settings SET value='{"enabled":false,"allowed_org_ids":[]}' WHERE key='company_profile_edit'`);
  assert.equal((await statementPdfSource(s, statementId))?.statement.companyProfile, null);
  const off = await statementPdfForSession(s, statementId); assert.ok(off);
  assert.deepEqual(off, legacy); assert.deepEqual(await renderPdf(off, font), legacyBytes);
  assert.deepEqual(await historical(), stored);
  // Local OFF with global ON is also a kill, without erasing stored versions.
  await enable();
  await query(`UPDATE organizations SET feature_flags=feature_flags-'company_profile_edit' WHERE id=$1`, [ORG_ID]);
  const localOff = await statementPdfForSession(s, statementId); assert.ok(localOff);
  assert.deepEqual(await renderPdf(localOff, font), legacyBytes);
  await enable();
  assert.deepEqual(await statementPdfForSession(s, statementId), on);
  assert.deepEqual(await historical(), stored);
});

test('OFF generation/replay retain the base statement trace with only the existing org-read flag projection', async t => {
  // Captured with mock.method(Client.prototype.query) while executing domain.ts
  // from the pinned pre-package base, not from the implementation under test.
  const base = JSON.parse(readFileSync(new URL('./test-fixtures/b016-base-statement-trace.json', import.meta.url), 'utf8')) as {
    base: string; generation: string[]; replay: string[];
  };
  assert.equal(base.base, '09f4b59cad85bcf439c4aa1d74aa463676b3c456');
  const legacyOrgRead = `SELECT (SELECT value FROM platform_settings WHERE key='billing_previews') AS value, feature_flags FROM organizations WHERE id=$1`;
  const companyOrgRead = `SELECT (SELECT value FROM platform_settings WHERE key='billing_previews') AS value, feature_flags, (SELECT value FROM platform_settings WHERE key='company_profile_edit') AS company_profile FROM organizations WHERE id=$1`;
  const s = await actor();
  const owner = (await query(`SELECT owner_contact_id::text AS id FROM property_owners WHERE org_id=$1 ORDER BY owner_contact_id LIMIT 1`, [ORG_ID])).rows[0].id;
  const on = { enabled: true, allowed_org_ids: [ORG_ID] };
  const matrix: [unknown, unknown][] = [
    [null, null], [on, false], [on, 'true'], [on, {}],
    [null, true], [{ ...on, enabled: false }, true], [{ ...on, enabled: 'true' }, true],
    [{ ...on, allowed_org_ids: [] }, true], [{ ...on, allowed_org_ids: [ORG_ID, 123] }, true],
  ];
  for (const [index, [global, local]] of matrix.entries()) {
    await query(`INSERT INTO platform_settings(key,value) VALUES('company_profile_edit',$1::jsonb) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [JSON.stringify(global)]);
    await query(`UPDATE organizations SET feature_flags=jsonb_set(feature_flags,'{company_profile_edit}',$2::jsonb) WHERE id=$1`, [ORG_ID, JSON.stringify(local)]);
    const blocker = new Client({ connectionString: process.env.DATABASE_URL }); await blocker.connect();
    try {
      await blocker.query('BEGIN');
      // SELECT is compatible, but the new admission SHARE lock would fail.
      await blocker.query('LOCK TABLE platform_settings IN SHARE ROW EXCLUSIVE MODE');
      await blocker.query('LOCK TABLE app.b016_company_profiles IN ACCESS EXCLUSIVE MODE');
      for (const operation of ['generation', 'replay'] as const) {
        const trace: string[] = [], original = Client.prototype.query;
        const spy = t.mock.method(Client.prototype, 'query', function(this: Client, ...args: unknown[]) {
          trace.push(typeof args[0] === 'string' ? args[0] : (args[0] as { text: string }).text);
          return Reflect.apply(original, this, args);
        });
        let report: { statementId: string };
        try {
          report = await generateStatement(s, { ownerContactId: owner, month: `2199-${String(index + 1).padStart(2, '0')}` });
        } finally { spy.mock.restore(); }
        // The only permitted SQL-text difference is the global-flag projection
        // in the already-existing read. All other SQL bytes/order/count match.
        assert.equal(trace.filter(sql => sql === companyOrgRead).length, 1);
        assert.deepEqual(trace, base[operation].map(sql => sql === legacyOrgRead ? companyOrgRead : sql), `${operation} OFF case ${index}`);
        const stored = (await query(`SELECT company_profile_version_id,company_profile_snapshot FROM owner_statements WHERE id=$1`, [report.statementId])).rows[0];
        assert.deepEqual(stored, { company_profile_version_id: null, company_profile_snapshot: null });
      }
    } finally { await blocker.query('ROLLBACK'); await blocker.end(); }
  }
});

test('A2 gateway cannot consume a proof without a reserved attempt, including null and retired check operations', async () => {
  await enable(); const s = await actor(), h = await mock(s);
  assert.equal((await h.flow.initiate(s, { target: h.target, password: 'mock', requestId: randomUUID() })).state, 'pending');
  const id = h.delivery.id;
  const before = (await query(`SELECT * FROM app.b016_pending_email_changes WHERE id=$1`, [id])).rows[0];
  const proof = { id, version: before.version, mailbox: 'current', hash: before.current_hash, provider: 'partial' };
  assert.equal((await direct(s, 'verify', proof, true)).state, 'stale');
  for (const operation of [null, 'check']) assert.equal((await direct(s, operation, proof, true)).state, 'invalid');
  assert.deepEqual((await query(`SELECT * FROM app.b016_pending_email_changes WHERE id=$1`, [id])).rows[0], before);
  assert.equal(h.verifications, 0);
});

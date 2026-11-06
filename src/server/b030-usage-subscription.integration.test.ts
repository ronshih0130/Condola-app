import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Client } from 'pg';
import { cloneTestDatabase } from './test-database-clone';
import { disposableDbUrl } from './test-disposable-db';
import { resetAndSeed } from './seed';
import { ORG_ID, ORG2_ID, USERS } from './ids';
import { readUsageSummary, readSubscriptionPlan, handleMockSubscriptionWebhook } from './usage-subscriptions';
import { evaluateSubscription, type MockSubscriptionEvent } from './b030-subscription-rules';
import { POST } from '@/app/api/mock-subscription/route';
import { dispatchVendor, __setVendorLinkKillSwitchForTests } from './vendor-repair';
import { ensureSandbox } from './sandbox';
import { svc } from './db';
import { recordUsage, recordVendorDispatchUsage } from './usage-events';
import type { Session } from './types';

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>>, db: Client;
const admin: Session = { userId: USERS.admin, sessionId: randomUUID(), orgId: ORG_ID, liveOrgId: ORG_ID,
  environment: 'live', kind: 'staff', role: 'admin', locale: 'en', calendar: 'gregorian', leaseId: null,
  email: 'synthetic@example.test', name: 'Synthetic' };
const secret = randomBytes(32).toString('hex');
const beforeEnv = { enabled: process.env.B030_MOCK_PROVIDER_ENABLED, secret: process.env.B030_MOCK_PROVIDER_HMAC_SECRET };
const originalFetch = globalThis.fetch;
test.before(async () => {
  clone = await cloneTestDatabase(); db = new Client({ connectionString: clone.url }); await db.connect();
  process.env.B030_MOCK_PROVIDER_ENABLED = 'true'; process.env.B030_MOCK_PROVIDER_HMAC_SECRET = secret;
  globalThis.fetch = async () => { throw new Error('External request forbidden in B-030 fixtures'); };
});
test.beforeEach(async () => {
  await resetAndSeed();
  await db.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 day')`, [admin.sessionId, admin.userId, randomUUID()]);
  await enable();
});
test.after(async () => {
  globalThis.fetch = originalFetch; __setVendorLinkKillSwitchForTests(false);
  if (beforeEnv.enabled === undefined) delete process.env.B030_MOCK_PROVIDER_ENABLED; else process.env.B030_MOCK_PROVIDER_ENABLED = beforeEnv.enabled;
  if (beforeEnv.secret === undefined) delete process.env.B030_MOCK_PROVIDER_HMAC_SECRET; else process.env.B030_MOCK_PROVIDER_HMAC_SECRET = beforeEnv.secret;
  await db?.end(); await clone?.cleanup();
});
async function enable(org = ORG_ID) {
  await db.query(`UPDATE organizations SET feature_flags=feature_flags||'{"usage_subscriptions":true,"usage_events":true,"vendor_link":true}'::jsonb WHERE id=$1`, [org]);
  for (const key of ['usage_subscriptions', 'usage_events']) await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key=$2`, [org, key]);
}
function event(sequence = 1, state: MockSubscriptionEvent['state'] = 'trialing', extra: Partial<MockSubscriptionEvent> = {}): MockSubscriptionEvent {
  return { provider: 'local_mock', eventId: randomUUID(), orgId: ORG_ID, sequence, state, occurredAt: '2026-11-01T00:00:00.000Z', planKey: 'unconfigured', planVersion: 1, ...extra };
}
function signed(e: MockSubscriptionEvent, timestamp = String(Math.floor(Date.now() / 1000))) {
  const raw = JSON.stringify(e), signature = createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
  return { raw, timestamp, signature };
}
function send(e: MockSubscriptionEvent) { const s = signed(e); return handleMockSubscriptionWebhook(s.raw, s.timestamp, s.signature); }
async function source(org = ORG_ID, dimension = 'units', quantity = '1', at = '2026-11-01T00:00:00Z') {
  return (await db.query<{ id: string }>(`SELECT app.prop07_record_usage($1,$2,$3::bigint,$4::timestamptz,'units',$5,$6)::text id`, [org, dimension, quantity, at, randomUUID(), randomUUID()])).rows[0].id;
}
const from = '2026-11-01T00:00:00Z', to = '2026-12-01T00:00:00Z';
const privateTables = ['b030_plan_versions', 'b030_subscriptions', 'b030_provider_events', 'b030_vendor_assignments'];
async function snapshot() {
  const rows = [];
  for (const table of privateTables) rows.push((await db.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) rows FROM app.${table} t`)).rows[0].rows);
  return rows;
}
async function as<T>(role: 'anon' | 'authenticated' | 'service_role', user: string, fn: () => Promise<T>, org: string | null = ORG_ID, env = 'live') {
  await db.query('BEGIN');
  try {
    await db.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env',$3,true)`, [user, org ?? '', env]);
    await db.query(`SET LOCAL ROLE ${role}`);
    const result = await fn(); await db.query('COMMIT'); return result;
  } catch (error) { await db.query('ROLLBACK'); throw error; }
}

test('period aggregates reconcile exact source IDs and bigint totals, half-open boundaries and sandbox excluded', async () => {
  const ids = [await source(), await source(ORG_ID, 'units', '2')];
  await source(ORG_ID, 'stored_bytes', '9007199254740993');
  await source(ORG_ID, 'units', '100', '2026-10-31T23:59:59.999Z');
  await source(ORG_ID, 'units', '200', to);
  await source(ORG2_ID, 'units', '300');
  const sandbox = await ensureSandbox(admin);
  await source(sandbox, 'units', '400');
  const rows = await readUsageSummary(admin, from, to);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.find(r => r.dimension === 'units')?.source_event_ids.sort(), ids.sort());
  for (const row of rows) {
    const actual = (await db.query(`SELECT sum(quantity)::text quantity,count(*)::text events FROM app.usage_events WHERE id=ANY($1::uuid[]) AND NOT sandbox`, [row.source_event_ids])).rows[0];
    assert.equal(row.quantity, actual.quantity); assert.equal(row.events, actual.events);
  }
  assert.equal(rows.find(r => r.dimension === 'stored_bytes')?.quantity, '9007199254740993');
  assert.equal(rows.find(r => r.dimension === 'units')?.quantity, '3');
  await enable(sandbox);
  assert.deepEqual(await readUsageSummary({ ...admin, orgId: sandbox, environment: 'sandbox' }, from, to), []);
});

test('unconfigured plans never fabricate a charge; prices and mutable versions cannot be inserted', async () => {
  const plan = await readSubscriptionPlan(admin);
  assert.equal(plan.pricingLabel, 'Pricing not configured'); assert.equal(plan.enabled, true);
  if (!plan.enabled) assert.fail('enabled');
  assert.equal(plan.priceAmountMinor, null); assert.equal(plan.priceCurrency, null);
  assert.equal(plan.state, null); assert.equal(plan.graceSeconds, null);
  assert.ok(Object.values(plan.limits).every(v => v === null));
  await assert.rejects(db.query(`INSERT INTO app.b030_plan_versions(plan_key,version,price_amount_minor) VALUES('invalid',1,123)`));
  await assert.rejects(db.query(`UPDATE app.b030_plan_versions SET grace_seconds=0 WHERE plan_key='unconfigured'`));
  assert.equal((await readSubscriptionPlan({ ...admin, locale: 'zh-TW' })).pricingLabel, '尚未設定價格');
});

test('mock lifecycle is deduped, grace expiry and restricted/canceled states keep retained data readable', async () => {
  const planKey = `test_${randomUUID()}`;
  await db.query(`INSERT INTO app.b030_plan_versions(plan_key,version,grace_seconds,units_limit) VALUES($1,1,0,0)`, [planKey]);
  const first = event(1, 'trialing', { planKey });
  assert.equal(await send(first), 'applied'); assert.equal(await send(first), 'duplicate');
  assert.equal((await db.query('SELECT count(*)::int n FROM app.b030_provider_events')).rows[0].n, 1);
  await source();
  for (const [sequence, state] of [[2, 'active'], [3, 'grace'], [4, 'restricted'], [5, 'canceled']] as const) {
    assert.equal(await send(event(sequence, state, { planKey })), 'applied');
    const plan = await readSubscriptionPlan(admin);
    assert.equal(plan.enabled, true); if (!plan.enabled) assert.fail('enabled');
    const evaluation = evaluateSubscription(plan, { units: '1' });
    if (state === 'grace') assert.equal(evaluation.grace, 'expired');
    assert.equal(evaluation.restrictOperations, false); assert.equal(evaluation.retainedDataReadable, true);
    assert.equal((await readUsageSummary(admin, from, to))[0].quantity, '1');
  }
  await assert.rejects(send(event(6, 'active', { planKey })));
  assert.equal((await db.query('SELECT count(*)::int n FROM app.b030_provider_events')).rows[0].n, 5);
});

test('concurrent repeated webhook creates one transition', async () => {
  const fixture = event();
  assert.deepEqual((await Promise.all([send(fixture), send(fixture)])).sort(), ['applied', 'duplicate']);
  assert.equal((await db.query(`SELECT count(*)::int n FROM app.b030_provider_events`)).rows[0].n, 1);
  assert.equal((await readSubscriptionPlan(admin)).enabled, true);
});

test('out-of-order, changed duplicate, repeated sequence, forged and stale fixtures are rejected without writes', async () => {
  const accepted = event(2, 'active'); await send(accepted);
  const before = await snapshot();
  for (const fixture of [event(1), event(2, 'grace'), { ...accepted, state: 'grace' as const }, event(3, 'grace', { occurredAt: '2026-10-31T00:00:00.000Z' }), event(3, 'restricted')]) await assert.rejects(send(fixture));
  const valid = signed(event(3, 'grace'));
  await assert.rejects(handleMockSubscriptionWebhook(valid.raw, valid.timestamp, '0'.repeat(64)));
  const stale = signed(event(3, 'grace'), String(Math.floor(Date.now() / 1000) - 301));
  await assert.rejects(handleMockSubscriptionWebhook(stale.raw, stale.timestamp, stale.signature));
  assert.deepEqual(await snapshot(), before);
});

test('local HTTP handler enforces authentication, body bound, duplicate conflict and environment switch', async () => {
  const fixture = signed(event());
  const request = (body = fixture.raw, signature = fixture.signature, host = '127.0.0.1') => new Request(`http://${host}/api/mock-subscription`, { method: 'POST', headers: { 'x-mock-timestamp': fixture.timestamp, 'x-mock-signature': signature }, body });
  assert.equal((await POST(request(fixture.raw, '0'.repeat(64)))).status, 400);
  assert.equal((await POST(request(' '.repeat(8193)))).status, 413);
  assert.equal((await POST(request(fixture.raw, fixture.signature, 'external.test'))).status, 404);
  assert.equal((await POST(request())).status, 200);
  assert.equal((await POST(request())).status, 409);
  process.env.B030_MOCK_PROVIDER_ENABLED = 'false';
  try { assert.equal((await POST(request())).status, 404); }
  finally { process.env.B030_MOCK_PROVIDER_ENABLED = 'true'; }
});

async function ticket() {
  const property = (await db.query<{ id: string }>('SELECT id::text FROM properties WHERE org_id=$1 ORDER BY id LIMIT 1', [ORG_ID])).rows[0].id;
  return (await db.query<{ id: string }>(`INSERT INTO maintenance_tickets(org_id,property_id,category,title,description,reported_by_user,ticket_number)
    VALUES($1,$2,'plumbing','B030 synthetic','Synthetic',$3,(SELECT coalesce(max(ticket_number),0)+1 FROM maintenance_tickets WHERE org_id=$1)) RETURNING id::text`, [ORG_ID, property, USERS.admin])).rows[0].id;
}
const dispatchInput = { vendorName: 'B030 vendor A', vendorTrade: 'plumbing', vendorPhone: '0912000111', contactWindow: 'Synthetic' };
async function reassign(ticketId: string) {
  const vendor = (await db.query<{ id: string }>(`INSERT INTO contacts(org_id,is_vendor,display_name,phone_e164) VALUES($1,true,'B030 vendor B','+886912000222') RETURNING id::text`, [ORG_ID])).rows[0].id;
  await svc(admin.userId, async c => {
    await c.query(`SELECT set_config('app.vendor_link_reassignment','on',true)`);
    await c.query(`UPDATE maintenance_tickets SET assigned_vendor_contact_id=$2 WHERE id=$1`, [ticketId, vendor]);
  });
}
test('BLK-MAC-10: dispatch A, reassign B without dispatch, dispatch A counts twice; retry counts once', async () => {
  __setVendorLinkKillSwitchForTests(true);
  const id = await ticket();
  const first = await dispatchVendor(admin, id, dispatchInput, 'http://127.0.0.1:43123');
  const generation = (await db.query(`SELECT generation::text FROM app.b030_vendor_assignments WHERE ticket_id=$1`, [id])).rows[0].generation;
  await reassign(id);
  assert.equal((await db.query(`SELECT count(*)::int n FROM repair_vendor_jobs WHERE ticket_id=$1`, [id])).rows[0].n, 1);
  const second = await dispatchVendor(admin, id, dispatchInput, 'http://127.0.0.1:43123');
  const retry = await dispatchVendor(admin, id, dispatchInput, 'http://127.0.0.1:43123');
  const rows = (await db.query(`SELECT source_id FROM app.usage_events WHERE org_id=$1 AND dimension='vendor_jobs' ORDER BY source_id`, [ORG_ID])).rows;
  assert.deepEqual(rows.map(r => r.source_id).sort(), [first.jobId, second.jobId].sort());
  assert.ok(!rows.some(r => r.source_id === retry.jobId));
  assert.equal(BigInt((await db.query(`SELECT generation::text FROM app.b030_vendor_assignments WHERE ticket_id=$1`, [id])).rows[0].generation), BigInt(generation) + BigInt(2));
});

test('B-030 OFF leaves B-029 vendor counting unchanged and writes no private state', async () => {
  __setVendorLinkKillSwitchForTests(true);
  await db.query(`UPDATE platform_settings SET value='{"enabled":false}' WHERE key='usage_subscriptions'`);
  const before = await snapshot(), id = await ticket();
  await dispatchVendor(admin, id, dispatchInput, 'http://127.0.0.1:43123'); await reassign(id);
  await dispatchVendor(admin, id, dispatchInput, 'http://127.0.0.1:43123');
  assert.deepEqual(await snapshot(), before);
  assert.equal((await db.query(`SELECT count(*)::int n FROM app.usage_events WHERE org_id=$1 AND dimension='vendor_jobs'`, [ORG_ID])).rows[0].n, 1);
});

test('enabling on an existing vendor assignment reuses the prior B-029 source', async () => {
  __setVendorLinkKillSwitchForTests(true);
  await db.query(`UPDATE platform_settings SET value='{"enabled":false}' WHERE key='usage_subscriptions'`);
  const id = await ticket();
  const first = await dispatchVendor(admin, id, dispatchInput, 'http://127.0.0.1:43123');
  await enable();
  await dispatchVendor(admin, id, dispatchInput, 'http://127.0.0.1:43123');
  const rows = (await db.query(`SELECT source_id FROM app.usage_events WHERE org_id=$1 AND dimension='vendor_jobs'`, [ORG_ID])).rows;
  assert.deepEqual(rows.map(r => r.source_id), [first.jobId]);
});

test('reenabling reconciles vendor changes and B-029 dispatches made while B-030 was OFF', async () => {
  __setVendorLinkKillSwitchForTests(true);
  const id = await ticket();
  await dispatchVendor(admin, id, dispatchInput, 'http://127.0.0.1:43123');
  await db.query(`UPDATE platform_settings SET value='{"enabled":false}' WHERE key='usage_subscriptions'`);
  await reassign(id);
  await enable();
  const vendorB = { ...dispatchInput, vendorName: 'B030 vendor B', vendorPhone: '0912000222' };
  await dispatchVendor(admin, id, vendorB, 'http://127.0.0.1:43123');
  assert.equal((await db.query(`SELECT count(*)::int n FROM app.usage_events WHERE dimension='vendor_jobs' AND org_id=$1`, [ORG_ID])).rows[0].n, 2);
  await db.query(`UPDATE platform_settings SET value='{"enabled":false}' WHERE key='usage_subscriptions'`);
  await dispatchVendor(admin, id, dispatchInput, 'http://127.0.0.1:43123');
  await dispatchVendor(admin, id, vendorB, 'http://127.0.0.1:43123');
  await enable();
  await dispatchVendor(admin, id, vendorB, 'http://127.0.0.1:43123');
  assert.equal((await db.query(`SELECT count(*)::int n FROM app.usage_events WHERE dimension='vendor_jobs' AND org_id=$1`, [ORG_ID])).rows[0].n, 4);
});

test('strict OFF matrix yields zero B-030 writes including vendor generations; B-029 remains independent', async () => {
  const good = { enabled: true, allowed_org_ids: [ORG_ID] };
  const cases: [unknown, unknown][] = [
    [null, true], [[], true], [{}, true], [{ ...good, enabled: false }, true], [{ ...good, enabled: 'true' }, true],
    [{ ...good, allowed_org_ids: ORG_ID }, true], [{ ...good, allowed_org_ids: { [ORG_ID]: true } }, true],
    [{ ...good, allowed_org_ids: [ORG2_ID] }, true], [good, false], [good, 'true'], [good, 1], [good, null],
  ];
  for (const [global, orgFlag] of cases) {
    await db.query(`UPDATE platform_settings SET value=$1::jsonb WHERE key='usage_subscriptions'`, [JSON.stringify(global)]);
    await db.query(`UPDATE organizations SET feature_flags=feature_flags||jsonb_build_object('usage_subscriptions',$2::jsonb) WHERE id=$1`, [ORG_ID, JSON.stringify(orgFlag)]);
    const before = await snapshot();
    assert.equal(await send(event()), 'off');
    assert.equal((await readSubscriptionPlan(admin)).enabled, false);
    assert.deepEqual(await readUsageSummary(admin, from, to), []);
    const id = await ticket(); await reassign(id);
    assert.deepEqual(await snapshot(), before);
  }
  assert.equal((await svc(null, c => recordUsage(c, { orgId: ORG_ID, dimension: 'units', quantity: BigInt(1), occurredAt: from, sourceTable: 'units', sourceId: randomUUID(), dedupeKey: randomUUID() }))).state, 'recorded');
});

test('admin/accountant only, current DB membership and pinned own-org scope required', async () => {
  await source();
  const accountant = { ...admin, userId: USERS.accountant, role: 'accountant' as const };
  assert.equal((await readUsageSummary(accountant, from, to)).length, 1);
  assert.equal((await readSubscriptionPlan(accountant)).enabled, true);
  for (const userId of [USERS.manager, USERS.maintenance, USERS.tenant, USERS.owner, USERS.coastAdmin]) {
    // A forged server role cannot replace current DB membership.
    await assert.rejects(readUsageSummary({ ...admin, userId }, from, to));
    await assert.rejects(readSubscriptionPlan({ ...admin, userId }));
  }
  await assert.rejects(readUsageSummary({ ...admin, orgId: ORG2_ID }, from, to));
  await assert.rejects(readSubscriptionPlan({ ...admin, orgId: '' }));
  for (const [org, env] of [[null, 'live'], [ORG_ID, 'sandbox'], [ORG2_ID, 'live']] as const) {
    await assert.rejects(as('authenticated', USERS.admin, () => db.query(`SELECT * FROM app.b030_usage_summary($1,$2,$3)`, [ORG_ID, from, to]), org, env));
  }
  await db.query(`DELETE FROM org_members WHERE org_id=$1 AND user_id=$2`, [ORG_ID, USERS.accountant]);
  await assert.rejects(readSubscriptionPlan(accountant));
});

test('privilege catalog: private RLS tables, pinned definer gateways, explicit role-only execute', async () => {
  const funcs = (await db.query<{ proname: string; signature: string; prosecdef: boolean; proconfig: string[] }>(`SELECT proname,oid::regprocedure::text signature,prosecdef,proconfig FROM pg_proc WHERE pronamespace='app'::regnamespace AND proname LIKE 'b030_%'`)).rows;
  assert.equal(funcs.length, 8);
  for (const fn of funcs) {
    assert.equal(fn.prosecdef, true); assert.ok(fn.proconfig.includes('search_path=pg_catalog, public, app'));
    for (const role of ['anon', 'authenticated', 'service_role'] as const) {
      const expected = role === 'authenticated' ? ['b030_usage_summary', 'b030_plan_presentation'].includes(fn.proname)
        : role === 'service_role' ? ['b030_apply_mock_event', 'b030_vendor_dispatch_source'].includes(fn.proname) : false;
      assert.equal((await db.query('SELECT has_function_privilege($1,$2,\'EXECUTE\') allowed', [role, fn.signature])).rows[0].allowed, expected, `${role} ${fn.proname}`);
    }
  }
  for (const table of privateTables) {
    assert.equal((await db.query('SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass', [`app.${table}`])).rows[0].relrowsecurity, true);
    for (const role of ['anon', 'authenticated', 'service_role'] as const) {
      assert.equal((await db.query(`SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') allowed`, [role, `app.${table}`])).rows[0].allowed, false);
      await assert.rejects(as(role, USERS.admin, () => db.query(`SELECT * FROM app.${table}`)));
    }
  }
});

test('period offsets, DST folds, microsecond boundaries and late arrivals use exact half-open instants', async () => {
  const start = '2026-11-01T01:30:00.123456-07:00', end = '2026-11-01T01:30:00.123457-07:00';
  const first = await source(ORG_ID, 'units', '2', '2026-11-01T08:30:00.123456Z');
  await source(ORG_ID, 'units', '20', '2026-11-01T08:30:00.123455Z');
  await source(ORG_ID, 'units', '30', '2026-11-01T08:30:00.123457Z');
  const folded = await source(ORG_ID, 'units', '40', '2026-11-01T01:30:00.123456-08:00');
  assert.deepEqual((await readUsageSummary(admin, start, end))[0].source_event_ids, [first]);
  assert.deepEqual(await readUsageSummary(admin, start, end), await readUsageSummary(admin, '2026-11-01T14:00:00.123456+05:30', '2026-11-01T08:30:00.123457Z'));
  assert.deepEqual((await readUsageSummary(admin, '2026-11-01T01:30:00.123456-08:00', '2026-11-01T01:30:00.123457-08:00'))[0].source_event_ids, [folded]);
  const late = await source(ORG_ID, 'units', '3', start);
  const refreshed = (await readUsageSummary(admin, start, end))[0];
  assert.equal(refreshed.quantity, '5'); assert.equal(refreshed.events, '2');
  assert.deepEqual(refreshed.source_event_ids.sort(), [first, late].sort());
  for (const [a, b] of [[start, start], [end, start], ['2026-11-01T08:30:00', end],
    [start, '2026-11-01T08:30:00.1234569Z'], [start, '2026-11-01T08:30:00.123456Z']]) await assert.rejects(readUsageSummary(admin, a, b));
});

test('concurrent global or org flag OFF after the ON read falls back to B-029 without assignment locking', async () => {
  __setVendorLinkKillSwitchForTests(true);
  for (const toggle of ['global', 'org']) {
    await enable();
    const id = await ticket();
    // Establish an assigned vendor without recording a B-029 event yet.
    await db.query(`UPDATE platform_settings SET value='{"enabled":false}' WHERE key='usage_events'`);
    const dispatch = await dispatchVendor(admin, id, dispatchInput, 'http://127.0.0.1:43123');
    await enable();
    const before = await snapshot();
    let toggled = false;
    const result = await svc(admin.userId, async c => {
      const intercepted = { query: async (sql: string, values?: unknown[]) => {
        const response = await c.query(sql, values);
        if (sql.includes("key='usage_subscriptions'")) {
          if (toggle === 'global') await db.query(`UPDATE platform_settings SET value='{"enabled":false}' WHERE key='usage_subscriptions'`);
          else await db.query(`UPDATE organizations SET feature_flags=feature_flags||'{"usage_subscriptions":false}'::jsonb WHERE id=$1`, [ORG_ID]);
          toggled = true;
        }
        return response;
      } } as unknown as Client;
      return recordVendorDispatchUsage(intercepted, ORG_ID, dispatch.jobId);
    });
    assert.equal(toggled, true); assert.equal(result.state, 'recorded');
    assert.deepEqual(await snapshot(), before);
    assert.equal((await db.query(`SELECT count(*)::int n FROM app.usage_events WHERE source_id=$1`, [dispatch.jobId])).rows[0].n, 1);
  }
});

test('generation write failure preserves create, reassignment and dispatch; durable audit recovers A-B-A', async () => {
  __setVendorLinkKillSwitchForTests(true);
  const id = await ticket();
  const first = await dispatchVendor(admin, id, dispatchInput, 'http://127.0.0.1:43123');
  const generation = (await db.query(`SELECT generation::text FROM app.b030_vendor_assignments WHERE ticket_id=$1`, [id])).rows[0].generation;
  // Also cover a successful B generation followed by a failed return to A.
  const otherId = await ticket();
  const otherFirst = await dispatchVendor(admin, otherId, dispatchInput, 'http://127.0.0.1:43123');
  await reassign(otherId);
  const notices: string[] = [];
  const notice = (n: { message?: string }) => notices.push(n.message ?? '');
  db.on('notice', notice);
  await db.query(`CREATE FUNCTION public.test_b030_generation_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic-private-row-detail' USING ERRCODE='23514'; END $$`);
  await db.query(`CREATE TRIGGER test_b030_generation_fault BEFORE INSERT OR UPDATE ON app.b030_vendor_assignments FOR EACH ROW EXECUTE FUNCTION public.test_b030_generation_fault()`);
  let created: string, failedDispatch: Awaited<ReturnType<typeof dispatchVendor>>;
  try {
    created = await ticket();
    assert.equal((await db.query('SELECT count(*)::int n FROM maintenance_tickets WHERE id=$1', [created])).rows[0].n, 1);
    await reassign(id);
    assert.notEqual((await db.query('SELECT assigned_vendor_contact_id FROM maintenance_tickets WHERE id=$1', [id])).rows[0].assigned_vendor_contact_id,
      (await db.query('SELECT vendor_contact_id FROM repair_vendor_jobs WHERE id=$1', [first.jobId])).rows[0].vendor_contact_id);
    failedDispatch = await dispatchVendor(admin, id, dispatchInput, 'http://127.0.0.1:43123');
    assert.equal((await db.query('SELECT active FROM repair_vendor_jobs WHERE id=$1', [failedDispatch.jobId])).rows[0].active, true);
    assert.equal((await db.query(`SELECT generation::text FROM app.b030_vendor_assignments WHERE ticket_id=$1`, [id])).rows[0].generation, generation);
    const otherFailed = await dispatchVendor(admin, otherId, dispatchInput, 'http://127.0.0.1:43123');
    assert.equal((await db.query('SELECT active FROM repair_vendor_jobs WHERE id=$1', [otherFailed.jobId])).rows[0].active, true);
    assert.ok(notices.includes('b030_assignment_tracking_failed sqlstate=23514 recovery=next_dispatch'));
    assert.ok(notices.every(n => !n.includes('synthetic-private-row-detail')));
  } finally {
    db.off('notice', notice);
    await db.query('DROP TRIGGER test_b030_generation_fault ON app.b030_vendor_assignments');
    await db.query('DROP FUNCTION public.test_b030_generation_fault()');
  }
  const recovered = await dispatchVendor(admin, id, dispatchInput, 'http://127.0.0.1:43123');
  await dispatchVendor(admin, id, dispatchInput, 'http://127.0.0.1:43123');
  const otherRecovered = await dispatchVendor(admin, otherId, dispatchInput, 'http://127.0.0.1:43123');
  await dispatchVendor(admin, otherId, dispatchInput, 'http://127.0.0.1:43123');
  assert.deepEqual((await db.query(`SELECT source_id FROM app.usage_events WHERE dimension='vendor_jobs' ORDER BY source_id`)).rows.map(r => r.source_id).sort(), [first.jobId, recovered.jobId, otherFirst.jobId, otherRecovered.jobId].sort());
  assert.equal(BigInt((await db.query(`SELECT generation::text FROM app.b030_vendor_assignments WHERE ticket_id=$1`, [id])).rows[0].generation), BigInt(generation) + BigInt(2));
  const newDispatch = await dispatchVendor(admin, created!, dispatchInput, 'http://127.0.0.1:43123');
  assert.equal((await db.query('SELECT count(*)::int n FROM app.usage_events WHERE source_id=$1', [newDispatch.jobId])).rows[0].n, 1);
});

test('admission lock timeout preserves ticket create and reassignment, restores timeout and recovers next dispatch', async () => {
  __setVendorLinkKillSwitchForTests(true);
  const id = await ticket();
  const first = await dispatchVendor(admin, id, dispatchInput, 'http://127.0.0.1:43123');
  const vendor = (await db.query(`INSERT INTO contacts(org_id,is_vendor,display_name) VALUES($1,true,'Synthetic reassignment') RETURNING id`, [ORG_ID])).rows[0].id;
  const blocker = new Client({ connectionString: clone.url }); await blocker.connect();
  const notices: string[] = [];
  const notice = (n: { message?: string }) => notices.push(n.message ?? '');
  db.on('notice', notice);
  const timeout = (await db.query('SHOW lock_timeout')).rows[0].lock_timeout;
  try {
    await blocker.query('BEGIN'); await blocker.query('LOCK TABLE platform_settings IN ROW EXCLUSIVE MODE');
    const created = await ticket();
    assert.equal((await db.query('SELECT count(*)::int n FROM maintenance_tickets WHERE id=$1', [created])).rows[0].n, 1);
    await db.query('BEGIN');
    await db.query(`SELECT set_config('app.vendor_link_reassignment','on',true)`);
    await db.query('UPDATE maintenance_tickets SET assigned_vendor_contact_id=$2 WHERE id=$1', [id, vendor]);
    assert.equal((await db.query('SHOW lock_timeout')).rows[0].lock_timeout, timeout);
    await db.query('COMMIT');
    assert.equal((await db.query('SELECT assigned_vendor_contact_id FROM maintenance_tickets WHERE id=$1', [id])).rows[0].assigned_vendor_contact_id, vendor);
    assert.ok(notices.filter(n => n === 'b030_assignment_tracking_failed sqlstate=55P03 recovery=next_dispatch').length >= 2);
  } finally {
    db.off('notice', notice); await db.query('ROLLBACK'); await blocker.query('ROLLBACK'); await blocker.end();
  }
  const second = await dispatchVendor(admin, id, dispatchInput, 'http://127.0.0.1:43123');
  assert.deepEqual((await db.query(`SELECT source_id FROM app.usage_events WHERE dimension='vendor_jobs' ORDER BY source_id`)).rows.map(r => r.source_id).sort(), [first.jobId, second.jobId].sort());
});

test('a held assignment-row lock caps telemetry waits: dispatch completes promptly and only telemetry is skipped', async () => {
  __setVendorLinkKillSwitchForTests(true);
  const id = await ticket();
  await dispatchVendor(admin, id, dispatchInput, 'http://127.0.0.1:43123');
  const blocker = new Client({ connectionString: clone.url }); await blocker.connect();
  try {
    await blocker.query('BEGIN');
    const locked = await blocker.query('SELECT 1 FROM app.b030_vendor_assignments WHERE ticket_id=$1 FOR UPDATE', [id]);
    assert.equal(locked.rowCount, 1, 'assignment row exists to lock');
    const started = Date.now();
    const outcome = await Promise.race([
      dispatchVendor(admin, id, dispatchInput, 'http://127.0.0.1:43123').then(() => 'done'),
      new Promise<string>((resolve) => setTimeout(() => resolve('stalled'), 5000)),
    ]);
    assert.equal(outcome, 'done', 'dispatch must not wait on a telemetry lock');
    assert.ok(Date.now() - started < 5000);
  } finally {
    await blocker.query('ROLLBACK'); await blocker.end();
  }
});

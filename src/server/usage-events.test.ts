import assert from 'node:assert/strict';
import test from 'node:test';
import type { Client } from 'pg';
import { recordUsage, recordVendorDispatchUsage, usageDedupeKey, usageEventsOn, withUsageTransaction } from './usage-events';

test('usage flag requires strict booleans and selected org allowlist', () => {
  const good = { enabled: true, allowed_org_ids: ['org'] };
  assert.equal(usageEventsOn(good, { usage_events: true }, 'org'), true);
  for (const global of [null, [], true, {}, { ...good, enabled: 'true' }, { ...good, allowed_org_ids: 'org' }, { ...good, allowed_org_ids: [] }])
    assert.equal(usageEventsOn(global, { usage_events: true }, 'org'), false);
  for (const flags of [null, [], {}, { usage_events: 'true' }, { usage_events: 1 }, { usage_events: false }])
    assert.equal(usageEventsOn(good, flags, 'org'), false);
});

test('dedupe keys preserve dimension, source identity and signature version', () => {
  assert.equal(usageDedupeKey('units', 'units', 'id'), 'units:units:id');
  assert.equal(usageDedupeKey('signatures', 'leases', 'id', 'sha'), 'signatures:leases:id:sha');
});

test('OFF never queries the usage store or recorder; ON serializes bigint exactly', async () => {
  for (const enabled of [false, true]) {
    const calls: { sql: string; values?: unknown[] }[] = [];
    const client = { query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      if (sql.includes("current_setting('role')")) return { rows: [{ role: 'authenticated', claim: 'authenticated' }] };
      if (sql.includes('platform_settings')) return { rows: [{ value: { enabled, allowed_org_ids: ['org'] }, feature_flags: { usage_events: true } }] };
      return { rows: [{ id: 'usage' }] };
    } } as unknown as Client;
    const result = await recordUsage(client, { orgId: 'org', dimension: 'stored_bytes', quantity: BigInt('9007199254740993'), occurredAt: '2026-11-01', sourceTable: 'files', sourceId: 'id', dedupeKey: 'key' });
    assert.equal(result.state, enabled ? 'recorded' : 'off');
    const recorder = calls.filter(c => /app\.(usage_events|prop07_record_usage)/.test(c.sql));
    assert.equal(recorder.length, enabled ? 1 : 0);
    if (!enabled) assert.ok(!calls.some(c => /current_setting|set_config|SET LOCAL ROLE/.test(c.sql)));
    if (enabled) {
      assert.equal(recorder[0].values?.[2], '9007199254740993');
      assert.deepEqual(calls.at(-2)?.values, ['authenticated', 'authenticated']);
    }
    assert.ok(!calls.some(c => /^(BEGIN|COMMIT|ROLLBACK)$/.test(c.sql)));
  }
});


test('flag cache is per client, org and transaction, including rollback cleanup', async () => {
  const calls: string[] = [];
  let enabled = false;
  const client = { query: async (sql: string, values?: unknown[]) => {
    calls.push(sql);
    if (sql.includes('platform_settings')) return { rows: [{ value: { enabled, allowed_org_ids: [values?.[0]] }, feature_flags: { usage_events: true } }] };
    if (sql.includes("current_setting('role')")) return { rows: [{ role: 'authenticated', claim: 'authenticated' }] };
    return { rows: [{ id: 'usage' }] };
  } } as unknown as Client;
  const input = { orgId: 'org', dimension: 'units' as const, quantity: BigInt(1), occurredAt: '2026-11-01', sourceTable: 'units', sourceId: 'id', dedupeKey: 'key' };
  await withUsageTransaction(client, async () => {
    assert.equal((await recordUsage(client, input)).state, 'off');
    const count = calls.length;
    assert.equal((await recordUsage(client, input)).state, 'off');
    assert.equal(calls.length, count);
    await recordUsage(client, { ...input, orgId: 'other' });
    assert.equal(calls.filter(sql => sql.includes('platform_settings')).length, 2);
    assert.ok(!calls.some(sql => sql.includes('current_setting')));
  });
  enabled = true;
  await assert.rejects(withUsageTransaction(client, async () => {
    assert.equal((await recordUsage(client, input)).state, 'recorded');
    assert.equal((await recordUsage(client, input)).state, 'recorded');
    assert.equal(calls.filter(sql => sql.includes('platform_settings')).length, 3);
    throw new Error('business rollback');
  }), /business rollback/);
  enabled = false;
  await withUsageTransaction(client, async () => assert.equal((await recordUsage(client, input)).state, 'off'));
  assert.equal(calls.filter(sql => sql.includes('platform_settings')).length, 4);
});

test('dispatch admission OFF falls back to B-029; invalid source stays empty; stable OFF preserves query order', async () => {
  const history = { id: 'first-job', ticket: 'ticket', vendor: 'vendor', at: '2026-11-01T00:00:00Z' };
  for (const mode of ['off', 'toggle', 'invalid'] as const) {
    const calls: string[] = [];
    const client = { query: async (sql: string, values?: unknown[]) => {
      calls.push(sql);
      if (sql.includes("current_setting('role')")) return { rows: [{ role: 'authenticated', claim: 'authenticated' }] };
      if (sql.includes('platform_settings')) return { rows: [{ value: { enabled: !sql.includes("key='usage_subscriptions'") || mode !== 'off', allowed_org_ids: ['org'] }, feature_flags: { usage_events: true, usage_subscriptions: true } }] };
      if (sql.includes('b030_vendor_dispatch_source')) return { rows: mode === 'toggle' ? [{ state: 'off' }] : [] };
      if (sql.includes('WITH history')) return { rows: [history] };
      if (sql.includes('prop07_record_usage')) {
        assert.equal(values?.[5], history.id);
        assert.equal(values?.[6], 'vendor_jobs:repair_vendor_jobs:first-job:ticket:vendor');
        return { rows: [{ id: 'usage' }] };
      }
      return { rows: [] };
    } } as unknown as Client;
    assert.equal((await recordVendorDispatchUsage(client, 'org', 'job')).state, mode === 'invalid' ? 'empty' : 'recorded');
    assert.equal(calls.some(sql => sql.includes('WITH history')), mode !== 'invalid');
    if (mode === 'off') assert.deepEqual(calls.map(sql => sql.trim().split('\n')[0]), [
      'SAVEPOINT usage_event',
      "SELECT (SELECT value FROM platform_settings WHERE key='usage_events') AS value, feature_flags FROM organizations WHERE id=$1",
      "SELECT current_setting('role') AS role, current_setting('request.jwt.claim.role',true) AS claim",
      'SET LOCAL ROLE service_role', "SELECT set_config('request.jwt.claim.role','service_role',true)",
      "SELECT (SELECT value FROM platform_settings WHERE key='usage_subscriptions') AS value, feature_flags FROM organizations WHERE id=$1",
      'WITH history AS (', 'SELECT app.prop07_record_usage($1,$2,$3::bigint,$4::timestamptz,$5,$6,$7)::text AS id',
      "SELECT set_config('role',$1,true),set_config('request.jwt.claim.role',$2,true)", 'RELEASE SAVEPOINT usage_event',
    ]);
  }
});

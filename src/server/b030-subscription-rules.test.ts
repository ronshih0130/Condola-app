import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { evaluateSubscription, usagePeriodInstant, localMockEnabled, usageSubscriptionsOn, verifyMockFixture, type SubscriptionPlan } from './b030-subscription-rules';
import { usageSubscriptionCopy } from '@/i18n/usage-subscriptions';
const secret = randomBytes(32).toString('hex');
const now = Date.parse('2026-11-06T12:00:00.000Z'), timestamp = String(now / 1000);
const fixture = { provider: 'local_mock', eventId: randomUUID(), orgId: randomUUID(), sequence: 1, state: 'trialing', occurredAt: new Date(now).toISOString(), planKey: 'unconfigured', planVersion: 1 };
const sign = (body: string, at = timestamp) => createHmac('sha256', secret).update(`${at}.${body}`).digest('hex');

test('subscription flag requires strict global/org booleans and array allowlist', () => {
  const good = { enabled: true, allowed_org_ids: ['org'] };
  assert.equal(usageSubscriptionsOn(good, { usage_subscriptions: true }, 'org'), true);
  for (const value of [null, [], true, {}, { ...good, enabled: 'true' }, { ...good, allowed_org_ids: 'org' }, { ...good, allowed_org_ids: {} }, { ...good, allowed_org_ids: [] }]) {
    assert.equal(usageSubscriptionsOn(value, { usage_subscriptions: true }, 'org'), false);
  }
  for (const value of [null, [], true, {}, { usage_subscriptions: 'true' }, { usage_subscriptions: 1 }, { usage_subscriptions: false }]) assert.equal(usageSubscriptionsOn(good, value, 'org'), false);
});
test('local mock requires explicit switch and loopback DB without connection overrides', () => {
  const env = { B030_MOCK_PROVIDER_ENABLED: 'true', DATABASE_URL: 'postgres://local@127.0.0.1:55432/disposable' };
  assert.equal(localMockEnabled(env), true);
  for (const DATABASE_URL of ['postgres://external.test/db', 'postgres://localhost/db?host=external.test', 'https://localhost/db', '', 'postgres://localhost']) assert.equal(localMockEnabled({ ...env, DATABASE_URL }), false);
  assert.equal(localMockEnabled({ ...env, B030_MOCK_PROVIDER_ENABLED: 'TRUE' }), false);
});
test('exact HMAC fixture verifies; forged, stale, future and missing secret fail', () => {
  const raw = JSON.stringify(fixture);
  assert.deepEqual(verifyMockFixture(raw, timestamp, sign(raw), secret, now), fixture);
  for (const [body, at, signature, key, clock] of [
    [raw + ' ', timestamp, sign(raw), secret, now], [raw, timestamp, '0'.repeat(64), secret, now],
    [raw, timestamp, sign(raw), undefined, now], [raw, timestamp, sign(raw), 'short', now],
    [raw, timestamp, sign(raw), secret, now + 300001], [raw, timestamp, sign(raw), secret, now - 300001],
  ] as const) assert.throws(() => verifyMockFixture(body, at, signature, key, clock));
});
test('signed malformed, excessive and real-provider payloads fail before storage', () => {
  for (const value of [{ ...fixture, provider: 'real' }, { ...fixture, sequence: 0 }, { ...fixture, sequence: 1.5 },
    { ...fixture, state: 'paid' }, { ...fixture, occurredAt: '2026-11-06' }, { ...fixture, planVersion: 0 },
    { ...fixture, orgId: 'other' }, { ...fixture, price: 100 }, [], null]) {
    const raw = JSON.stringify(value);
    assert.throws(() => verifyMockFixture(raw, timestamp, sign(raw), secret, now));
  }
  const raw = ' '.repeat(8193);
  assert.throws(() => verifyMockFixture(raw, timestamp, sign(raw), secret, now));
});
const plan: SubscriptionPlan = { enabled: true, state: 'grace', planKey: 'unconfigured', planVersion: 1, pricing: 'not_configured', priceAmountMinor: null, priceCurrency: null,
  graceSeconds: null, graceEndsAt: null, limits: { units: null, signatures: null, stored_bytes: null, notifications: null, vendor_jobs: null }, restrictionRules: null };
test('null limits/grace mean not configured, never an implicit zero quota', () => {
  const result = evaluateSubscription(plan, { units: '9007199254740993' }, now);
  assert.equal(result.grace, 'not_configured');
  assert.ok(result.limits.every(l => l.status === 'not_configured'));
  assert.equal(result.restrictOperations, false);
  assert.equal(result.retainedDataReadable, true);
});
test('grace and bigint limits have exact boundaries with inert restrictions for every state', () => {
  const configured = { ...plan, graceSeconds: '0', graceEndsAt: new Date(now).toISOString(), limits: { ...plan.limits, units: '0', stored_bytes: '9007199254740993' } };
  assert.equal(evaluateSubscription(configured, {}, now - 1).grace, 'open');
  assert.equal(evaluateSubscription(configured, {}, now).grace, 'expired');
  assert.equal(evaluateSubscription(configured, { units: '0' }, now).limits[0].status, 'within');
  assert.equal(evaluateSubscription(configured, { units: '1' }, now).limits[0].status, 'exceeded');
  assert.equal(evaluateSubscription(configured, { stored_bytes: '9007199254740993' }, now).limits[2].status, 'within');
  assert.equal(evaluateSubscription(configured, { stored_bytes: '9007199254740994' }, now).limits[2].status, 'exceeded');
  for (const state of ['trialing', 'active', 'grace', 'restricted', 'canceled'] as const) {
    const result = evaluateSubscription({ ...configured, state }, { units: '99999' }, now);
    assert.equal(result.restrictOperations, false); assert.equal(result.retainedDataReadable, true);
  }
  assert.equal(evaluateSubscription({ enabled: false }, {}).restrictOperations, false);
});
test('both locales state unconfigured pricing without currency amounts', () => {
  assert.equal(usageSubscriptionCopy('en').pricingNotConfigured, 'Pricing not configured');
  assert.equal(usageSubscriptionCopy('zh-TW').pricingNotConfigured, '尚未設定價格');
  for (const locale of ['en', 'zh-TW']) assert.doesNotMatch(JSON.stringify(usageSubscriptionCopy(locale)), /\d|\$|NTD|TWD/);
});

test('period instants require valid explicit offsets and preserve all six fractional digits', () => {
  const instant = usagePeriodInstant('2026-11-01T08:30:00.123456Z');
  assert.equal(usagePeriodInstant('2026-11-01T01:30:00.123456-07:00'), instant);
  assert.equal(usagePeriodInstant('2026-11-01T14:00:00.123456+05:30'), instant);
  assert.equal(usagePeriodInstant('2026-11-01T01:30:00.123456-08:00')! - instant!, BigInt(3600000000));
  assert.equal(usagePeriodInstant('2026-03-08T03:00:00-07:00')! - usagePeriodInstant('2026-03-08T01:59:59.999999-08:00')!, BigInt(1));
  assert.equal(usagePeriodInstant('2026-11-01T08:30:00.123457Z')! - instant!, BigInt(1));
  assert.equal(usagePeriodInstant('2026-11-01T08:30:00.1Z'), usagePeriodInstant('2026-11-01T08:30:00.100000+00:00'));
  for (const value of ['2026-11-01', '2026-11-01T08:30:00', '2026-11-01T08:30:00.1234567Z',
    '2026-02-29T00:00:00Z', '2026-04-31T00:00:00Z', '0000-01-01T00:00:00Z', '2026-00-01T00:00:00Z',
    '2026-11-01T24:00:00Z', '2026-11-01T23:59:60Z', '2026-11-01T08:30:00-00:00',
    '2026-11-01T08:30:00+14:01', '2026-11-01T08:30:00+01:60', 'infinity']) assert.equal(usagePeriodInstant(value), null, value);
  assert.notEqual(usagePeriodInstant('2024-02-29T00:00:00Z'), null);
});

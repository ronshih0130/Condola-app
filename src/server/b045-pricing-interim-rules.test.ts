// FILE: src/server/b045-pricing-interim-rules.test.ts
// B-045 (pricing_interim) — fail-closed admission + flag-ON display/calculator,
// apply-form validation and trial CTA routing. Ref: PRINCIPLES 51.
// AC: R11 (admission), PLT-26-AC2 (calculator), PLT-30-AC2 (apply form),
// C1 rev 23:37 / PLT-28-AC2 / PLT-39-AC3 (trial + paid CTA routing).
// Deterministic: no I/O, no network, no billing.ts import.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  pricingInterimOn,
  pricingInterimGloballyEnabled,
  pricingInterimAdmitted,
  pricingInterimPublicEnabled,
  pricingApplyAccessAllowed,
  quoteInterim,
  parseInterimUnits,
  validateApplyInput,
  trialCtaHref,
  paidApplyHref,
  formatNtInterim,
} from './b045-pricing-interim-rules';

// A) admission — R11, fail-closed
const goodGlobal = { enabled: true, allowed_org_ids: ['org'] };
const goodFlags = { pricing_interim: true };

test('pricingInterimOn admits only strict booleans + array allowlist that includes org', () => {
  assert.equal(pricingInterimOn(goodGlobal, goodFlags, 'org'), true);
  // bad global shapes / enabled
  for (const value of [null, undefined, [], true, {}, 'x', 1,
    { ...goodGlobal, enabled: false }, { ...goodGlobal, enabled: 'true' }, { ...goodGlobal, enabled: 1 }]) {
    assert.equal(pricingInterimOn(value, goodFlags, 'org'), false);
  }
  // bad allowlist / org membership
  for (const value of [{ enabled: true }, { ...goodGlobal, allowed_org_ids: 'org' },
    { ...goodGlobal, allowed_org_ids: {} }, { ...goodGlobal, allowed_org_ids: [] },
    { ...goodGlobal, allowed_org_ids: ['other'] }]) {
    assert.equal(pricingInterimOn(value, goodFlags, 'org'), false);
  }
  // bad flags shapes / pricing_interim value
  for (const value of [null, undefined, [], true, {}, 'x', 1,
    { pricing_interim: 'true' }, { pricing_interim: 1 }, { pricing_interim: false }]) {
    assert.equal(pricingInterimOn(goodGlobal, value, 'org'), false);
  }
});

test('pricingInterimOn does not treat a different flag as admission', () => {
  assert.equal(pricingInterimOn(goodGlobal, { usage_subscriptions: true }, 'org'), false);
  assert.equal(pricingInterimOn(goodGlobal, { pricing_trial: true }, 'org'), false);
});

test('pricingInterimGloballyEnabled is true only for a plain object with enabled === true', () => {
  // true: plain object with strict-boolean enabled; allowed_org_ids is NOT required
  assert.equal(pricingInterimGloballyEnabled({ enabled: true }), true);
  assert.equal(pricingInterimGloballyEnabled({ enabled: true, allowed_org_ids: [] }), true);
  assert.equal(pricingInterimGloballyEnabled(goodGlobal), true);

  // false: bad shapes, non-boolean enabled, enabled false/missing, allowlist-only, empty object
  for (const value of [null, undefined, [], 'true', 1,
    { enabled: 'true' }, { enabled: 1 }, { enabled: false },
    { allowed_org_ids: ['org'] }, {}]) {
    assert.equal(pricingInterimGloballyEnabled(value), false);
  }
});

test('pricingInterimAdmitted rejects null/undefined/empty org even with good global/flags', () => {
  assert.equal(pricingInterimAdmitted(goodGlobal, goodFlags, 'org'), true);
  for (const orgId of [null, undefined, '']) {
    assert.equal(pricingInterimAdmitted(goodGlobal, goodFlags, orgId), false);
  }
  // still defers to the fail-closed core for non-empty orgs
  assert.equal(pricingInterimAdmitted(goodGlobal, goodFlags, 'other'), false);
});

// A2) public-mode detection — PLT-30-AC1, C3, R11: public mode requires BOTH
// strict-boolean enabled===true AND public===true, independent of the allowlist.
test('pricingInterimPublicEnabled is true only for strict enabled===true AND public===true', () => {
  // true: public mode is independent of allowlist contents
  assert.equal(pricingInterimPublicEnabled({ enabled: true, public: true }), true);
  assert.equal(pricingInterimPublicEnabled({ enabled: true, public: true, allowed_org_ids: ['org'] }), true);

  // false: bad shapes, non-boolean fields, missing/false public, kill switch, internal-only ON
  for (const value of [null, undefined, [], 'true', 1, {},
    { enabled: true },
    { enabled: true, public: false },
    { enabled: true, public: 'true' },
    { enabled: true, public: 1 },
    { enabled: false, public: true },
    { enabled: 'true', public: true },
    { public: true },
    { enabled: true, allowed_org_ids: [] },
    { enabled: true, allowed_org_ids: ['org'] }]) {
    assert.equal(pricingInterimPublicEnabled(value), false);
  }
});

// A3) apply-gate access — PLT-30-AC2, C3, R11, Q-C: fail-closed; kill switch wins;
// public mode is open to all; internal-only mode defers to allowlist + flags.
test('pricingApplyAccessAllowed gates by kill switch, public mode and allowlist', () => {
  // OFF: enabled false / missing / malformed => false for anyone (anon or good org)
  for (const global of [{ enabled: false, allowed_org_ids: ['org'] }, { allowed_org_ids: ['org'] },
    null, undefined, {}, 'true', []]) {
    for (const orgId of [null, undefined, '', 'org']) {
      assert.equal(pricingApplyAccessAllowed({ global, flags: goodFlags, orgId }), false);
    }
  }

  // Internal-only ON (no public / public:false) + good flags => allowlist decides
  for (const global of [{ enabled: true, allowed_org_ids: ['org'] },
    { enabled: true, public: false, allowed_org_ids: ['org'] }]) {
    for (const orgId of [null, undefined, '']) {
      assert.equal(pricingApplyAccessAllowed({ global, flags: goodFlags, orgId }), false);
    }
    assert.equal(pricingApplyAccessAllowed({ global, flags: goodFlags, orgId: 'org' }), true);
    assert.equal(pricingApplyAccessAllowed({ global, flags: goodFlags, orgId: 'other' }), false);
    // allowlisted org still needs strict-boolean flags
    for (const flags of [undefined, { pricing_interim: false }, { pricing_interim: 'true' }]) {
      assert.equal(pricingApplyAccessAllowed({ global, flags, orgId: 'org' }), false);
    }
  }

  // Public mode: open path unchanged — everyone passes regardless of allowlist contents
  for (const global of [{ enabled: true, public: true },
    { enabled: true, public: true, allowed_org_ids: [] },
    { enabled: true, public: true, allowed_org_ids: ['org'] }]) {
    for (const orgId of [null, undefined, '', 'org', 'other']) {
      assert.equal(pricingApplyAccessAllowed({ global, flags: goodFlags, orgId }), true);
    }
  }

  // Kill switch: enabled:false wins even with public:true, anon or listed org
  for (const orgId of [null, undefined, '', 'org']) {
    assert.equal(
      pricingApplyAccessAllowed({ global: { enabled: false, public: true, allowed_org_ids: ['org'] }, flags: goodFlags, orgId }),
      false,
    );
  }
});

// B) quoteInterim — PLT-26-AC2
test('quoteInterim: free units, boundaries, rates and non-finite guard', () => {
  for (const tier of ['standard', 'pro'] as const) {
    assert.deepEqual(quoteInterim(0, tier), { monthly: 0, yearly: 0, rate: tier === 'pro' ? 59 : 39 });
    assert.deepEqual(quoteInterim(5, tier), { monthly: 0, yearly: 0, rate: tier === 'pro' ? 59 : 39 });
  }
  assert.deepEqual(quoteInterim(6, 'standard'), { monthly: 39, yearly: 429, rate: 39 });
  assert.deepEqual(quoteInterim(8, 'standard'), { monthly: 117, yearly: 1287, rate: 39 });
  assert.deepEqual(quoteInterim(8, 'pro'), { monthly: 177, yearly: 1947, rate: 59 });

  // floor behaviour
  assert.equal(quoteInterim(5.9, 'standard').monthly, 0);
  assert.equal(quoteInterim(6.9, 'standard').monthly, 39);

  for (const units of [NaN, Infinity, -Infinity]) {
    assert.throws(() => quoteInterim(units, 'standard'), RangeError);
  }
});

// C) parseInterimUnits — PLT-30
test('parseInterimUnits accepts non-negative base-10 integers after trim', () => {
  assert.deepEqual(parseInterimUnits('0'), { ok: true, value: 0 });
  assert.deepEqual(parseInterimUnits('5'), { ok: true, value: 5 });
  assert.deepEqual(parseInterimUnits('08'), { ok: true, value: 8 });
  assert.deepEqual(parseInterimUnits(' 12 '), { ok: true, value: 12 });
  for (const raw of ['', '  ', '1.5', '-1', '1e2', '+', 'abc']) {
    assert.deepEqual(parseInterimUnits(raw), { ok: false }, raw);
  }
});

test('parseInterimUnits enforces the pg integer bound and rejects overflow/non-safe-integer', () => {
  // upper boundary stays valid
  assert.deepEqual(parseInterimUnits('2147483647'), { ok: true, value: 2147483647 });
  // one past the integer bound
  assert.deepEqual(parseInterimUnits('2147483648'), { ok: false });
  // very long digit string -> Infinity / non-safe-integer
  assert.deepEqual(parseInterimUnits('9'.repeat(20)), { ok: false });
  // 16-digit value exceeding the bound (and non-safe as an integer)
  assert.deepEqual(parseInterimUnits('9999999999999999'), { ok: false });
});

// D) validateApplyInput — PLT-30-AC2
test('validateApplyInput accepts valid input and normalizes plan/note', () => {
  const r = validateApplyInput({ companyName: ' Acme ', phone: ' 0912 ', units: '0', plan: 'premium', note: '  hi  ' });
  assert.equal(r.ok, true);
  assert.ok(r.ok);
  assert.deepEqual(r.value, { companyName: 'Acme', phone: '0912', units: 0, plan: 'pro', note: 'hi' });

  const unsure = validateApplyInput({ companyName: 'A', phone: '1', units: '3', plan: 'unsure' });
  assert.ok(unsure.ok);
  assert.equal(unsure.value.plan, 'unsure');

  const emptyPlan = validateApplyInput({ companyName: 'A', phone: '1', units: '3', plan: '' });
  assert.ok(emptyPlan.ok);
  assert.equal(emptyPlan.value.plan, null);

  const blankNote = validateApplyInput({ companyName: 'A', phone: '1', units: '3', note: '   ' });
  assert.ok(blankNote.ok);
  assert.equal(blankNote.value.note, null);

  // unknown plan does not fail the form; plan becomes null
  const gold = validateApplyInput({ companyName: 'A', phone: '1', units: '3', plan: 'gold' });
  assert.ok(gold.ok);
  assert.equal(gold.value.plan, null);
});

test('validateApplyInput flags blank fields and reports first invalid in field order', () => {
  const both = validateApplyInput({ companyName: '  ', phone: '  ', units: '3' });
  assert.ok(!both.ok);
  assert.deepEqual(both.errors, { companyName: true, phone: true });
  assert.equal(both.first, 'companyName');

  const phoneFirst = validateApplyInput({ companyName: 'A', phone: '  ', units: '3' });
  assert.ok(!phoneFirst.ok);
  assert.deepEqual(phoneFirst.errors, { phone: true });
  assert.equal(phoneFirst.first, 'phone');

  for (const units of ['-1', '1.5']) {
    const unitsFirst = validateApplyInput({ companyName: 'A', phone: '1', units });
    assert.ok(!unitsFirst.ok);
    assert.deepEqual(unitsFirst.errors, { units: true });
    assert.equal(unitsFirst.first, 'units');
  }
});

// E) trialCtaHref / paidApplyHref — C1 rev 23:37, PLT-28-AC2, PLT-39-AC3
test('trialCtaHref routes by auth/role and surfaces pro as "premium" in the query', () => {
  assert.equal(trialCtaHref({ plan: 'standard', signedIn: false }), '/signup?trial=standard');
  assert.equal(trialCtaHref({ plan: 'pro', signedIn: false }), '/signup?trial=premium');
  assert.equal(trialCtaHref({ plan: 'pro', signedIn: true, isAdmin: true }), '/m/settings?trial=premium');
  // non-admin (explicit false or omitted) routes to the paid apply form
  assert.equal(trialCtaHref({ plan: 'standard', signedIn: true, isAdmin: false }), '/pricing/apply?plan=standard');
  assert.equal(trialCtaHref({ plan: 'standard', signedIn: true }), '/pricing/apply?plan=standard');

  // internal "pro" must never leak into the query
  for (const signedIn of [true, false]) {
    assert.doesNotMatch(trialCtaHref({ plan: 'pro', signedIn, isAdmin: signedIn }), /pro/);
  }
  // logged-out CTAs must never route to /m/settings
  assert.doesNotMatch(trialCtaHref({ plan: 'standard', signedIn: false }), /\/m\/settings/);
  assert.doesNotMatch(trialCtaHref({ plan: 'pro', signedIn: false }), /\/m\/settings/);
});

test('paidApplyHref builds the apply URL with the public plan token', () => {
  assert.equal(paidApplyHref(), '/pricing/apply');
  assert.equal(paidApplyHref('standard'), '/pricing/apply?plan=standard');
  assert.equal(paidApplyHref('pro'), '/pricing/apply?plan=premium');
  assert.equal(paidApplyHref('unsure'), '/pricing/apply?plan=unsure');
});

// F) formatNtInterim
test('formatNtInterim renders NT$ with thousands separators', () => {
  assert.equal(formatNtInterim(1287), 'NT$1,287');
  assert.equal(formatNtInterim(0), 'NT$0');
});

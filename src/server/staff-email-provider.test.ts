import assert from 'node:assert/strict';
import test from 'node:test';
import { createStaffEmailMockAdapter, type MockTransport } from './staff-email-provider';

const userId = '10000000-0000-4000-8000-000000000001';
const otherId = '10000000-0000-4000-8000-000000000002';
const state = { userId, current: 'old@example.test', target: 'new@example.test', privileged: [] as string[], pending: null as string | null, pendingUnexpired: false };
const pending = { ...state, pending: state.target, pendingUnexpired: true };
const partial = { msg: 'Confirmation link accepted. Please proceed to confirm link sent to the other email', code: '200' };
function user(email = state.current) {
  return { id: userId, email, email_confirmed_at: '2026-01-01T00:00:00Z', is_anonymous: false, app_metadata: { provider: 'email', providers: ['email'] }, identities: [{ id: 'provider-identity-id', user_id: userId, provider: 'email', identity_data: { email, email_verified: true } }] };
}
function setup(responses: unknown[]) {
  const calls: { url: string; method: string; headers: Record<string,string>; body?: string; redirect: string }[] = [];
  const transport: MockTransport = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body, redirect: init.redirect });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return { status: 200, json: async () => next };
  };
  return { calls, adapter: createStaffEmailMockAdapter({ projectOrigin: 'https://project.example.test', publicKey: 'synthetic-public-key', deadlineMs: 30, transport }) };
}

test('fresh bearer is bound to the actual /user before exactly one email-only PUT', async () => {
  const h = setup([{ access_token: 'synthetic-bearer', user: { id: userId } }, user(), { id: userId, new_email: state.target }]);
  assert.equal(await h.adapter.begin(state, 'synthetic-password'), 'pending');
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.calls.map((c) => [c.method, new URL(c.url).pathname]), [['POST','/auth/v1/token'],['GET','/auth/v1/user'],['PUT','/auth/v1/user']]);
  assert.equal(new URL(h.calls[0].url).search, '?grant_type=password');
  assert.equal(h.calls[1].headers.authorization, 'Bearer synthetic-bearer');
  assert.equal(h.calls[2].headers.authorization, 'Bearer synthetic-bearer');
  assert.deepEqual(JSON.parse(h.calls[2].body!), { email: state.target });
  assert.ok(h.calls.every((c) => c.redirect === 'error' && c.headers.apikey === 'synthetic-public-key'));
});

test('wrong grant, owned identity, target identity or unsupported account never writes', async () => {
  const bad = [
    { ...user(), id: otherId },
    { ...user(), identities: [{ ...user().identities[0], user_id: otherId }] },
    { ...user(), identities: [{ ...user().identities[0], identity_data: { email: state.target, email_verified: true } }] },
    { ...user(), identities: [] },
    { ...user(), identities: [{ ...user().identities[0], identity_data: { email: state.current, email_verified: false } }] },
    { ...user(), factors: [{ status: 'verified' }] },
    { ...user(), factors: null },
    { ...user(), is_anonymous: true },
    { ...user(), is_sso_user: true },
    { ...user(), email_confirmed_at: 'not-a-timestamp' },
    { ...user(), email_confirmed_at: '2026-02-30T00:00:00Z' },
    { ...user(), app_metadata: { provider: 'google', providers: ['google'] } },
    { ...user(), email_confirmed_at: null },
  ];
  for (const body of bad) {
    const h = setup([{ access_token: 'synthetic-bearer' }, body]);
    assert.equal(await h.adapter.begin(state, 'password'), 'unavailable');
    assert.equal(h.calls.filter((c) => c.method === 'PUT').length, 0);
  }
  const nestedError = setup([{ access_token: 'synthetic-bearer', user: { id: userId, error: 'failure' } }]);
  assert.equal(await nestedError.adapter.begin(state, 'password'), 'unavailable');
  assert.equal(nestedError.calls.length, 1);
  const spoof = setup([{ access_token: 'synthetic-bearer', user: { id: otherId } }]);
  assert.equal(await spoof.adapter.begin(state, 'password'), 'unavailable');
  assert.equal(spoof.calls.length, 1);
});

test('pending, unsafe configuration, failed transport and unclear mutation do not resend', async () => {
  const already = setup([]);
  assert.equal(await already.adapter.begin(pending, 'password'), 'pending');
  assert.equal(already.calls.length, 0);
  let called = 0;
  const transport: MockTransport = async () => { called++; throw new Error('private detail'); };
  const unsafe = createStaffEmailMockAdapter({ projectOrigin: 'https://project.example.test/path', publicKey: 'key', deadlineMs: 20, transport });
  assert.equal(await unsafe.begin(state, 'password'), 'unavailable');
  assert.equal(called, 0);
  const unknown = setup([{ access_token: 'synthetic-bearer' }, user(), new Error('response lost')]);
  assert.equal(await unknown.adapter.begin(state, 'password'), 'unknown');
  assert.equal(unknown.calls.filter((c) => c.method === 'PUT').length, 1);
  const malformed = setup([{ access_token: 'synthetic-bearer' }, user(), {}]);
  assert.equal(await malformed.adapter.begin(state, 'password'), 'unknown');
  assert.equal(malformed.calls.length, 3);
});

test('deadline covers stalled transport and stalled response body without retry', async () => {
  let count = 0, aborted = false;
  const stalled: MockTransport = async (_url, init) => { count++; init.signal.addEventListener('abort', () => { aborted = true; }); return new Promise(() => {}); };
  const adapter = createStaffEmailMockAdapter({ projectOrigin: 'https://project.example.test', publicKey: 'key', deadlineMs: 5, transport: stalled });
  assert.equal(await adapter.begin(state, 'password'), 'unavailable');
  assert.equal(count, 1); assert.equal(aborted, true);
  let calls = 0;
  const bodyStall: MockTransport = async () => { calls++; return { status: 200, json: () => new Promise(() => {}) }; };
  const adapter2 = createStaffEmailMockAdapter({ projectOrigin: 'https://project.example.test', publicKey: 'key', deadlineMs: 5, transport: bodyStall });
  assert.equal(await adapter2.begin(state, 'password'), 'unavailable');
  assert.equal(calls, 1);
});

test('both proof orders retain leading zero and only yield candidate pending readback', async () => {
  for (const first of ['current','target'] as const) {
    const h = setup([partial, { user: user(state.target), access_token: 'discarded-token' }]);
    assert.equal(await h.adapter.verify(pending, { mailbox: first, token: '012345' }), 'partial');
    assert.equal(await h.adapter.verify(pending, { mailbox: first === 'current' ? 'target' : 'current', token: '001122' }), 'final_candidate');
    assert.deepEqual(JSON.parse(h.calls[0].body!), { type: 'email_change', email: first === 'current' ? state.current : state.target, token: '012345' });
    assert.deepEqual(h.calls.map((c) => [c.method, new URL(c.url).pathname]), [['POST','/auth/v1/verify'],['POST','/auth/v1/verify']]);
  }
});

test('partial and final verification reject contradictory or malformed responses', async () => {
  for (const value of [{}, { ...partial, user: user(state.target) }, { user: user(state.current) }, { user: { ...user(state.target), id: otherId } }, { user: { ...user(state.target), identities: [{ ...user(state.target).identities[0], user_id: otherId }] } }]) {
    const h = setup([value]);
    assert.equal(await h.adapter.verify(pending, { mailbox: 'target', token: '012345' }), 'unknown');
    assert.equal(h.calls.length, 1);
  }
  const nested = setup([{ user: { ...user(state.target), error: 'failure' } }]);
  assert.equal(await nested.adapter.verify(pending, { mailbox: 'target', token: '012345' }), 'unknown');
  const bad = setup([]);
  assert.equal(await bad.adapter.verify(pending, { mailbox: 'current', token: 'oops' }), 'invalid');
  assert.equal(bad.calls.length, 0);
});

test('a possible write with stalled response is unknown, with no automatic repeat', async () => {
  let count = 0, writes = 0, aborted = false;
  const transport: MockTransport = async (_url, init) => {
    count++;
    if (init.method === 'PUT') {
      writes++;
      init.signal.addEventListener('abort', () => { aborted = true; });
      return { status: 200, json: () => new Promise(() => {}) };
    }
    return { status: 200, json: async () => count === 1 ? { access_token: 'synthetic-bearer' } : user() };
  };
  const adapter = createStaffEmailMockAdapter({ projectOrigin: 'https://project.example.test', publicKey: 'key', deadlineMs: 5, transport });
  assert.equal(await adapter.begin(state, 'password'), 'unknown');
  assert.equal(writes, 1); assert.equal(count, 3); assert.equal(aborted, true);
});

test('provider evidence does not repair spaces to plus and rejects contradictory identity email', async () => {
  const plusState = { ...state, current: 'old+tag@example.test', target: 'new+tag@example.test' };
  const valid = user(plusState.current);
  const bad = [
    { ...valid, email: 'old tag@example.test' },
    { ...valid, identities: [{ ...valid.identities[0], identity_data: { email: 'old tag@example.test', email_verified: true } }] },
    { ...valid, identities: [{ ...valid.identities[0], email: 'other@example.test' }] },
    { ...valid, identities: [{ ...valid.identities[0], email: 'old tag@example.test' }] },
  ];
  for (const body of bad) {
    const h = setup([{ access_token: 'synthetic-bearer' }, body]);
    assert.equal(await h.adapter.begin(plusState, 'password'), 'unavailable');
    assert.equal(h.calls.filter((c) => c.method === 'PUT').length, 0);
  }
  const accepted = setup([{ access_token: 'synthetic-bearer' }, valid, { id: userId, new_email: 'NEW+TAG@example.test' }]);
  assert.equal(await accepted.adapter.begin(plusState, 'password'), 'pending');
  const wrong = setup([{ access_token: 'synthetic-bearer' }, valid, { id: userId, new_email: 'new tag@example.test' }]);
  assert.equal(await wrong.adapter.begin(plusState, 'password'), 'unknown');
  const plusPending = { ...plusState, pending: plusState.target, pendingUnexpired: true };
  const targetUser = user(plusState.target);
  for (const invalid of [
    { ...targetUser, email: 'new tag@example.test' },
    { ...targetUser, identities: [{ ...targetUser.identities[0], identity_data: { email: 'new tag@example.test', email_verified: true } }] },
    { ...targetUser, identities: [{ ...targetUser.identities[0], email: 'other@example.test' }] },
  ]) {
    const h = setup([{ user: invalid }]);
    assert.equal(await h.adapter.verify(plusPending, { mailbox: 'target', token: '012345' }), 'unknown');
  }
});

test('mixed success and provider error envelopes fail closed at every stage', async () => {
  for (const key of ['error', 'error_code', 'error_description', 'msg', 'code']) {
    const marker = { [key]: 'failure' };
    const grant = setup([{ access_token: 'synthetic-bearer', ...marker }]);
    assert.equal(await grant.adapter.begin(state, 'password'), 'unavailable');
    assert.equal(grant.calls.length, 1);
    const get = setup([{ access_token: 'synthetic-bearer' }, { ...user(), ...marker }]);
    assert.equal(await get.adapter.begin(state, 'password'), 'unavailable');
    assert.equal(get.calls.length, 2);
    const put = setup([{ access_token: 'synthetic-bearer' }, user(), { id: userId, new_email: state.target, ...marker }]);
    assert.equal(await put.adapter.begin(state, 'password'), 'unknown');
    assert.equal(put.calls.length, 3);
    const verify = setup([{ user: user(state.target), ...marker }]);
    assert.equal(await verify.adapter.verify(pending, { mailbox: 'target', token: '012345' }), 'unknown');
    assert.equal(verify.calls.length, 1);
  }
});

test('stored mailbox and privileged state must be canonical before any transport', async () => {
  const plus = { ...pending, current: 'OLD+TAG@example.test', target: 'NEW+TAG@example.test', pending: 'NEW+TAG@example.test' };
  for (const malformed of [
    { ...plus, current: 'OLD TAG@example.test' },
    { ...plus, pending: 'NEW TAG@example.test' },
    { ...plus, target: 'NEW TAG@example.test' },
    { ...plus, privileged: ['ADMIN TAG@example.test'] },
  ]) {
    for (const mailbox of ['current','target'] as const) {
      const h = setup([]);
      assert.equal(await h.adapter.verify(malformed, { mailbox, token: '012345' }), 'invalid');
      assert.equal(h.calls.length, 0);
    }
  }
  for (const malformed of [{ ...state, current: 'old tag@example.test' }, { ...pending, pending: 'new tag@example.test' }, { ...state, privileged: ['admin tag@example.test'] }]) {
    const h = setup([]);
    assert.equal(await h.adapter.begin(malformed, 'password'), 'invalid');
    assert.equal(h.calls.length, 0);
  }
  const h = setup([partial]);
  assert.equal(await h.adapter.verify(plus, { mailbox: 'target', token: '012345' }), 'partial');
  assert.equal(JSON.parse(h.calls[0].body!).email, 'new+tag@example.test');
  const current = setup([partial]);
  assert.equal(await current.adapter.verify(plus, { mailbox: 'current', token: '012345' }), 'partial');
  assert.equal(JSON.parse(current.calls[0].body!).email, 'old+tag@example.test');
});

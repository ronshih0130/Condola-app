import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { createStaffEmailMockAdapter, type MockTransport } from './staff-email-provider';
import { createStaffEmailFlow, type EmailFlowAdmission, type EmailFlowPending, type EmailFlowPorts } from './staff-email-flow';
import { canonicalStaffEmail } from './staff-email-rules';

const userId = '10000000-0000-4000-8000-000000000001';
const orgId = '20000000-0000-4000-8000-000000000001';
const sessionId = '30000000-0000-4000-8000-000000000001';
const otherId = '40000000-0000-4000-8000-000000000001';
const scope = { userId, orgId, sessionId };
const old = 'old@example.test', target = 'new@example.test';
const proof = { mailbox: 'target' as const, token: '001122' };
const partial = { msg: 'Confirmation link accepted. Please proceed to confirm link sent to the other email', code: '200' };
function providerUser() {
  return { id: userId, email: target, email_confirmed_at: '2026-01-01T00:00:00Z', is_anonymous: false,
    app_metadata: { provider: 'email', providers: ['email'] },
    identities: [{ id: 'fixture-identity', user_id: userId, provider: 'email', identity_data: { email: target, email_verified: true } }] };
}
function canonicalIdentity() {
  return { userId, email: target, confirmed: true, version: 'canonical-v1' };
}
function setup(responses: unknown[] = [{ user: providerUser() }]) {
  const calls = { transport: 0, load: 0, canonical: 0, commit: 0 };
  const order: string[] = [];
  let now = 1000;
  const admission: EmailFlowAdmission = { ...scope, kind: 'staff', role: 'manager', environment: 'live', liveOrgId: orgId,
    activeMember: true, revoked: false, expiresAt: 10000, flag: true };
  let pending: EmailFlowPending | null = { id: 'pending-fixture', ...scope, version: 'v1', current: old, target, expiresAt: 5000, privileged: [] };
  let canonical: unknown = canonicalIdentity();
  let mirrorWrites = 0;
  let beforeCommit: (() => Promise<void>) | undefined;
  const mirrors = { login: old, recovery: old, profile: old };
  const transport: MockTransport = async (_url, init) => {
    calls.transport++; order.push('transport');
    assert.equal(JSON.parse(init.body!).token, '001122');
    const response = responses.shift();
    if (response === 'stall') return new Promise(() => {});
    if (response instanceof Error) throw response;
    return { status: 200, json: async () => response };
  };
  const ports: EmailFlowPorts = {
    admit: async () => { order.push('admit'); return { ...admission }; },
    loadPending: async () => { calls.load++; order.push('load'); return pending; },
    provider: createStaffEmailMockAdapter({ projectOrigin: 'https://fixture.example.test', publicKey: 'fixture-public', deadlineMs: 5, transport }),
    readCanonical: async () => { calls.canonical++; order.push('canonical'); return canonical; },
    commitIdentity: async ({ scope: actor, expected, expectedCanonical, email }) => {
      calls.commit++; order.push('commit');
      await beforeCommit?.();
      // Model the atomic transaction: no await between current-state checks and writes.
      assert.deepEqual(actor, scope);
      if (admission.userId !== actor.userId || admission.orgId !== actor.orgId || admission.sessionId !== actor.sessionId
        || admission.liveOrgId !== actor.orgId || admission.kind !== 'staff' || admission.environment !== 'live'
        || !['admin', 'manager', 'accountant', 'maintenance'].includes(admission.role)
        || admission.activeMember !== true || admission.revoked !== false || admission.flag !== true
        || !Number.isFinite(now) || !Number.isFinite(admission.expiresAt) || admission.expiresAt <= now) return false;
      if (!pending || pending.userId !== actor.userId || pending.orgId !== actor.orgId
        || !Number.isFinite(pending.expiresAt) || pending.expiresAt <= now
        || !Number.isFinite(expected.expiresAt) || expected.expiresAt <= now
        || pending.version !== expected.version || pending.id !== expected.id
        || pending.current !== expected.current || pending.target !== expected.target
        || canonicalStaffEmail(pending.target) !== email
        || Object.values(mirrors).some((value) => value !== expected.current)) return false;
      if (!canonical || typeof canonical !== 'object' || Array.isArray(canonical)) return false;
      const live = canonical as Record<string, unknown>;
      if (expectedCanonical.userId !== actor.userId || canonicalStaffEmail(expectedCanonical.email) !== email
        || expectedCanonical.confirmed !== true || !expectedCanonical.version.trim()
        || live.userId !== expectedCanonical.userId || live.email !== expectedCanonical.email
        || live.confirmed !== expectedCanonical.confirmed || live.version !== expectedCanonical.version) return false;
      mirrorWrites += 3;
      mirrors.login = email; mirrors.recovery = email; mirrors.profile = email; pending = null;
      return true;
    },
    now: () => now,
  };
  return { flow: createStaffEmailFlow(ports), ports, admission, calls, order, mirrors,
    getMirrorWrites: () => mirrorWrites, setBeforeCommit: (hook: () => Promise<void>) => { beforeCommit = hook; },
    setPending: (p: EmailFlowPending | null) => { pending = p; }, getPending: () => pending,
    setCanonical: (value: unknown) => { canonical = value; }, setNow: (value: number) => { now = value; } };
}
function unchanged(h: ReturnType<typeof setup>) {
  assert.deepEqual(h.mirrors, { login: old, recovery: old, profile: old });
  assert.equal(h.getMirrorWrites(), 0);
  assert.equal(h.calls.commit, 0);
}

test('partial verification preserves trusted identity in both mailbox orders', async () => {
  for (const first of ['current', 'target'] as const) {
    const h = setup([partial, { user: providerUser() }]);
    const pending = structuredClone(h.getPending());
    assert.equal(await h.flow.verify(scope, { ...proof, mailbox: first }), 'partial');
    unchanged(h);
    assert.deepEqual(h.getPending(), pending);
    assert.deepEqual(h.calls, { transport: 1, load: 1, canonical: 0, commit: 0 });
    assert.equal(await h.flow.verify(scope, { ...proof, mailbox: first === 'current' ? 'target' : 'current' }), 'committed');
    assert.deepEqual(h.mirrors, { login: target, recovery: target, profile: target });
    assert.equal(h.getMirrorWrites(), 3);
    assert.equal(h.calls.commit, 1);
    assert.ok(h.order.indexOf('canonical') < h.order.indexOf('commit'));
    assert.equal(await h.flow.verify(scope, proof), 'invalid');
    assert.equal(h.calls.transport, 2); // consumed pending cannot replay provider work
    assert.equal(h.calls.commit, 1);
  }
});

test('ambiguous/expired verification never commits or automatically retries', async () => {
  for (const response of ['stall', new Error('fixture-timeout'), {}, { ...partial, user: providerUser() },
    { user: { ...providerUser(), id: otherId } }]) {
    const h = setup([response]);
    assert.equal(await h.flow.verify(scope, proof), 'unknown');
    unchanged(h);
    assert.equal(h.calls.transport, 1);
    assert.equal(h.calls.canonical, 0);
  }
  for (const token of ['', '12x', '001 122', 1122 as unknown as string]) {
    const h = setup();
    assert.equal(await h.flow.verify(scope, { ...proof, token }), 'invalid');
    unchanged(h);
    assert.deepEqual(h.calls, { transport: 0, load: 0, canonical: 0, commit: 0 });
  }
  for (const expiresAt of [1000, 999, NaN]) {
    const h = setup(); h.setPending({ ...h.getPending()!, expiresAt });
    assert.equal(await h.flow.verify(scope, proof), 'expired');
    unchanged(h); assert.equal(h.calls.transport, 0);
  }
});

test('final_candidate requires independent canonical readback', async () => {
  for (const canonical of [null, {}, [], { ...canonicalIdentity(), email: old },
    { ...canonicalIdentity(), userId: otherId }, { ...canonicalIdentity(), confirmed: false },
    { ...canonicalIdentity(), confirmed: 'true' }, { ...canonicalIdentity(), email: ` ${target}` },
    ...[undefined, null, '', ' ', 1, {}].map((version) => ({ ...canonicalIdentity(), version }))]) {
    const h = setup(); h.setCanonical(canonical);
    assert.equal(await h.flow.verify(scope, proof), 'unknown');
    unchanged(h);
    assert.deepEqual(h.calls, { transport: 1, load: 1, canonical: 1, commit: 0 });
  }
  const h = setup();
  h.ports.readCanonical = async () => { h.calls.canonical++; throw new Error('readback unavailable'); };
  assert.equal(await h.flow.verify(scope, proof), 'unknown');
  unchanged(h); assert.equal(h.calls.canonical, 1); assert.equal(h.calls.transport, 1);
});

test('admission precedes provider work and all persistence; only explicit boolean true enables', async () => {
  const denied: Partial<EmailFlowAdmission>[] = [
    { userId: otherId }, { orgId: otherId }, { sessionId: otherId }, { liveOrgId: otherId },
    { revoked: true }, { activeMember: false }, { expiresAt: 1000 }, { expiresAt: NaN },
    { kind: 'tenant' }, { role: 'owner' }, { environment: 'sandbox' },
    ...[false, undefined, null, 'true', 1, {}, [], { enabled: true }].map((flag) => ({ flag })),
  ];
  for (const patch of denied) {
    const h = setup(); Object.assign(h.admission, patch);
    assert.equal(await h.flow.verify(scope, proof), 'denied');
    unchanged(h);
    assert.deepEqual(h.calls, { transport: 0, load: 0, canonical: 0, commit: 0 });
    assert.deepEqual(h.order, ['admit']);
  }
  const h = setup();
  assert.equal(await h.flow.verify(scope, proof), 'committed');
  assert.equal(h.order[0], 'admit'); assert.equal(h.calls.commit, 1);
});

test('foreign pending state, late expiry and revoked admission cannot replace identity', async () => {
  for (const patch of [{ userId: otherId }, { orgId: otherId }, { current: 'bad email' }, { privileged: [target] }]) {
    const h = setup(); h.setPending({ ...h.getPending()!, ...patch });
    assert.equal(await h.flow.verify(scope, proof), 'invalid');
    unchanged(h); assert.equal(h.calls.transport, 0);
  }
  for (const change of ['expiry', 'revoke', 'flag'] as const) {
    const h = setup();
    h.ports.readCanonical = async () => {
      if (change === 'expiry') h.setNow(5000);
      if (change === 'revoke') h.admission.revoked = true;
      if (change === 'flag') h.admission.flag = false;
      return canonicalIdentity();
    };
    assert.equal(await h.flow.verify(scope, proof), change === 'expiry' ? 'expired' : 'denied');
    unchanged(h); assert.equal(h.calls.transport, 1);
  }
});

test('stale pending and uncertain identity commit do not trigger retries', async () => {
  const stale = setup();
  stale.ports.readCanonical = async () => {
    stale.setPending({ ...stale.getPending()!, version: 'v2' });
    return canonicalIdentity();
  };
  assert.equal(await stale.flow.verify(scope, proof), 'stale');
  assert.deepEqual(stale.mirrors, { login: old, recovery: old, profile: old });
  assert.equal(stale.calls.commit, 1);
  const uncertain = setup();
  uncertain.ports.commitIdentity = async () => { uncertain.calls.commit++; throw new Error('unknown commit'); };
  assert.equal(await uncertain.flow.verify(scope, proof), 'unknown');
  assert.equal(uncertain.calls.commit, 1); assert.equal(uncertain.calls.transport, 1);
});

test('throwing scope or proof getters return unknown before any port calls', async () => {
  for (const input of ['scope', 'proof'] as const) {
    const h = setup();
    let clockCalls = 0;
    h.ports.now = () => { clockCalls++; return 1000; };
    const actor = { ...scope }, verification = { ...proof };
    Object.defineProperty(input === 'scope' ? actor : verification, input === 'scope' ? 'userId' : 'token', {
      enumerable: true, get() { throw new Error('private getter detail'); },
    });
    assert.equal(await h.flow.verify(actor, verification), 'unknown');
    unchanged(h);
    assert.equal(clockCalls, 0);
    assert.deepEqual(h.order, []);
    assert.deepEqual(h.calls, { transport: 0, load: 0, canonical: 0, commit: 0 });
  }
});

test('canonical CAS rejects changes during the fourth admission, including mutable readback and version-only changes', async () => {
  for (const patch of [{ confirmed: false }, { userId: otherId }, { email: old }, { version: 'canonical-v2' }]) {
    const h = setup();
    const canonical = canonicalIdentity();
    h.setCanonical(canonical);
    const pending = structuredClone(h.getPending());
    const admit = h.ports.admit;
    let admissions = 0;
    h.ports.admit = async (actor) => {
      const result = await admit(actor);
      if (++admissions === 4) Object.assign(canonical, patch);
      return result;
    };
    const commit = h.ports.commitIdentity;
    h.ports.commitIdentity = async (input) => {
      assert.deepEqual(input.expectedCanonical, canonicalIdentity());
      return commit(input);
    };
    assert.equal(await h.flow.verify(scope, proof), 'stale');
    assert.equal(admissions, 4);
    assert.equal(h.calls.commit, 1);
    assert.equal(h.calls.transport, 1);
    assert.equal(h.getMirrorWrites(), 0);
    assert.deepEqual(h.mirrors, { login: old, recovery: old, profile: old });
    assert.deepEqual(h.getPending(), pending);
  }
});

test('atomic commit rejects authority, expiry and canonical races while commit waits without any mirror writes', async () => {
  const changes: ((h: ReturnType<typeof setup>) => void)[] = [
    (h) => { h.admission.revoked = true; },
    (h) => { h.admission.flag = false; },
    (h) => { h.admission.expiresAt = 1000; },
    (h) => { h.setNow(5000); },
    (h) => { h.setPending({ ...h.getPending()!, expiresAt: 1000 }); },
    (h) => { h.setCanonical({ ...canonicalIdentity(), confirmed: false }); },
    (h) => { h.setCanonical({ ...canonicalIdentity(), userId: otherId }); },
    (h) => { h.setCanonical({ ...canonicalIdentity(), email: old }); },
    (h) => {
      h.setCanonical({ ...canonicalIdentity(), confirmed: false, version: 'canonical-v2' });
      h.setCanonical({ ...canonicalIdentity(), version: 'canonical-v3' }); // ABA: values restored, version changed
    },
  ];
  for (const change of changes) {
    const h = setup();
    let entered!: () => void, resume!: () => void;
    const committing = new Promise<void>((resolve) => { entered = resolve; });
    const paused = new Promise<void>((resolve) => { resume = resolve; });
    h.setBeforeCommit(async () => { entered(); await paused; });
    const result = h.flow.verify(scope, proof);
    await committing;
    change(h);
    const pending = structuredClone(h.getPending());
    resume();
    assert.equal(await result, 'stale');
    assert.equal(h.calls.commit, 1);
    assert.equal(h.calls.transport, 1);
    assert.equal(h.getMirrorWrites(), 0);
    assert.deepEqual(h.mirrors, { login: old, recovery: old, profile: old });
    assert.deepEqual(h.getPending(), pending);
  }
});

test('import guard: no runtime source imports or re-exports the disconnected coordinator', () => {
  const root = process.cwd();
  const violations: string[] = [];
  function scan(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || ['node_modules', 'vendor', 'public'].includes(entry.name)) continue;
      const file = join(dir, entry.name);
      if (entry.isDirectory()) { scan(file); continue; }
      if (!/\.[cm]?[jt]sx?$/.test(file) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(file)
        || relative(root, file) === 'src/server/staff-email-flow.ts') continue;
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      function visit(node: ts.Node) {
        // Covers static/dynamic imports, require, re-exports and literal module paths.
        if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
          && /(?:^|\/)staff-email-flow(?:\.[cm]?[jt]s)?$/.test(node.text)) violations.push(relative(root, file));
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
  scan(root);
  assert.deepEqual(violations, []);
});

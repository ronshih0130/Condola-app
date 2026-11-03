import assert from 'node:assert/strict';
import test from 'node:test';
import { assessStaffEmail, normalizeStaffEmail } from './staff-email-rules';

const base = { current: 'First.Last+box@Example.test', target: 'next@example.test', privileged: [] as string[], pending: null as string | null, pendingUnexpired: false };
test('normalization follows current auth behavior without removing dots or plus', () => {
  assert.equal(normalizeStaffEmail(' First.Last+box@Example.test '), 'first.last+box@example.test');
  assert.equal(normalizeStaffEmail('A B@EXAMPLE.TEST'), 'a+b@example.test');
  assert.equal(normalizeStaffEmail('bad@@example.test'), null);
  assert.equal(assessStaffEmail({ ...base, target: 'first.last+box@example.test' }), 'unchanged');
  assert.equal(assessStaffEmail({ ...base, target: 'firstlast+box@example.test' }), 'ready');
});
test('privileged addresses and pending requests do not authorize a new send', () => {
  assert.equal(assessStaffEmail({ ...base, privileged: ['FIRST.LAST+BOX@example.test'] }), 'excluded');
  assert.equal(assessStaffEmail({ ...base, privileged: ['next@example.test'] }), 'excluded');
  assert.equal(assessStaffEmail({ ...base, privileged: ['not email'] }), 'invalid');
  assert.equal(assessStaffEmail({ ...base, pending: 'NEXT@example.test', pendingUnexpired: true }), 'pending');
  assert.equal(assessStaffEmail({ ...base, pending: 'other@example.test', pendingUnexpired: true }), 'invalid');
});

test('stored addresses and privileged exclusions cannot use form-input repair', () => {
  assert.equal(assessStaffEmail({ ...base, current: 'first.last box@example.test' }), 'invalid');
  assert.equal(assessStaffEmail({ ...base, pending: 'next box@example.test', pendingUnexpired: true }), 'invalid');
  assert.equal(assessStaffEmail({ ...base, privileged: ['admin box@example.test'] }), 'invalid');
  assert.equal(assessStaffEmail({ ...base, pending: null, pendingUnexpired: true }), 'invalid');
});

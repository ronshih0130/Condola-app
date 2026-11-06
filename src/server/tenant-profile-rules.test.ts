import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTenantProfile, tenantPasswordIssue } from './tenant-profile-rules';
const profile = { displayName:'  Test  ', phone:'+14155550123', version:'a'.repeat(32) };
test('profile validates name, E.164 and version; identity fields are not returned', () => {
  assert.deepEqual(parseTenantProfile({...profile,user_id:'forged',org_id:'forged',contact_id:'forged'}),{name:'Test',phone:profile.phone,version:profile.version});
  for (const phone of ['4155550123','+01234','+1','+1234567890123456','+1 4155550123','']) assert.equal(parseTenantProfile({...profile,phone}),null);
  for (const displayName of ['', 'a'.repeat(101), 'bad\nname']) assert.equal(parseTenantProfile({...profile,displayName}),null);
  assert.equal(parseTenantProfile({...profile,version:'forged'}),null);
});
test('password requires fresh re-entry, existing policy, confirmation and bcrypt byte bound', () => {
  const input = {currentPassword:'CurrentSecret7',password:'NewSecret82',confirm:'NewSecret82'};
  assert.equal(tenantPasswordIssue(input),null);
  assert.equal(tenantPasswordIssue({...input,currentPassword:'a'.repeat(100)}),null);
  assert.equal(tenantPasswordIssue({...input,currentPassword:''}),'reauth');
  for (const password of ['password1','short','OnlyLetters','12345678','a1'+'é'.repeat(36)]) assert.equal(tenantPasswordIssue({...input,password,confirm:password}),'weak');
  assert.equal(tenantPasswordIssue({...input,confirm:'different'}),'mismatch');
});

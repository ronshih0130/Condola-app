import assert from 'node:assert/strict';
import test from 'node:test';
import { validCompanyData } from './company-profile-rules';
const data = { legal_name: 'Example firm', tax_id: '', address: { city: '', district: '', street: '' } };
test('company regional contract accepts empty optional data and complete text address', () => {
  assert.equal(validCompanyData(data), true);
  assert.equal(validCompanyData({ ...data, tax_id: 'self-reported', address: { city: 'City', district: 'District', street: 'Street' } }), true);
});
test('company contract rejects unknown regional fields and malformed values', () => {
  for (const value of [null, [], { ...data, country: 'invented' }, { ...data, legal_name: '' }, { ...data, tax_id: 123 },
    { ...data, address: { ...data.address, postal: '123' } }, { ...data, address: { ...data.address, city: 'City' } }]) {
    assert.equal(validCompanyData(value), false);
  }
});
test('company contract bounds text and rejects control characters and untrimmed data', () => {
  for (const value of [' '.repeat(2), 'a\nb', 'a'.repeat(201), ' name ', '\u0000']) {
    assert.equal(validCompanyData({ ...data, legal_name: value }), false);
  }
});

test('company gate requires strict local and global opt-in and a fully valid allowlist', async () => {
  const { companyProfileOn } = await import('./company-profile-rules');
  const org = '10000000-0000-4000-8000-000000000001';
  const on = { enabled: true, allowed_org_ids: [org] };
  assert.equal(companyProfileOn(on, { company_profile_edit: true }, org), true);
  for (const local of [undefined, null, false, 'true', 1, {}, []]) {
    assert.equal(companyProfileOn(on, { company_profile_edit: local }, org), false);
  }
  for (const global of [undefined, null, false, [], { ...on, enabled: 'true' }, { ...on, allowed_org_ids: [org, 123] }, { ...on, allowed_org_ids: [org, 'bad'] }, { ...on, allowed_org_ids: [] }]) {
    assert.equal(companyProfileOn(global, { company_profile_edit: true }, org), false);
  }
});

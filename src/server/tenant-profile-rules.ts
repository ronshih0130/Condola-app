import { passwordAcceptable } from './password';
import { parseStaffDisplayName } from './staff-profile-rules';

export function parseTenantProfile(input: Record<string, unknown>) {
  const name = parseStaffDisplayName(input.displayName);
  const phone = typeof input.phone === 'string' ? input.phone.trim() : '';
  const version = input.version;
  if (!name || !/^\+[1-9][0-9]{1,14}$/.test(phone) || typeof version !== 'string' || !/^[a-f0-9-]{32,36}$/.test(version)) return null;
  return { name, phone, version };
}
export function tenantPasswordIssue(input: Record<string, unknown>): 'reauth' | 'weak' | 'mismatch' | null {
  if (typeof input.currentPassword !== 'string' || !input.currentPassword) return 'reauth';
  if (typeof input.password !== 'string' || !passwordAcceptable(input.password) || Buffer.byteLength(input.password) > 72) return 'weak';
  if (input.password !== input.confirm) return 'mismatch';
  return null;
}

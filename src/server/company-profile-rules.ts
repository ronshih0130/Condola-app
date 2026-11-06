import type { CompanyData } from './company-profiles';

/** Same strict global allowlist and local opt-in as the durable gateway. */
export function companyProfileOn(global: unknown, flags: unknown, orgId: string): boolean {
  if (!global || typeof global !== 'object' || Array.isArray(global)
    || !flags || typeof flags !== 'object' || Array.isArray(flags)) return false;
  const g = global as Record<string, unknown>, f = flags as Record<string, unknown>;
  return g.enabled === true && f.company_profile_edit === true
    && Array.isArray(g.allowed_org_ids) && g.allowed_org_ids.includes(orgId)
    && g.allowed_org_ids.every(id => typeof id === 'string'
      && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id));
}
/** Mirrors the approved regional shape; unknown fields and regions fail closed. */
export function validCompanyData(value: unknown): value is CompanyData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const d = value as Record<string, unknown>;
  const text = (v: unknown, max: number, required = false) => typeof v === 'string' && v === v.trim()
    && v.length <= max && (!required || v.length > 0) && !/[\x00-\x1f\x7f-\x9f]/.test(v);
  if (Object.keys(d).sort().join() !== 'address,legal_name,tax_id' || !text(d.legal_name, 200, true) || !text(d.tax_id, 100)
    || !d.address || typeof d.address !== 'object' || Array.isArray(d.address)) return false;
  const a = d.address as Record<string, unknown>;
  return Object.keys(a).sort().join() === 'city,district,street' && text(a.city, 100) && text(a.district, 100)
    && text(a.street, 300) && ((a.city === '' && a.district === '') || a.street !== '');
}

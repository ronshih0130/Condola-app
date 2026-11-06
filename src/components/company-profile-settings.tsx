import { randomUUID } from 'node:crypto';
import { makeT } from '@/i18n';
import { companyProfileCopy } from '@/i18n/company-profile';
import { companyProfileView } from '@/server/company-profiles';
import { actionSaveCompanyProfile } from '@/server/company-profile-actions';
import type { Session } from '@/server/types';

export async function CompanyProfileSettings({ session, result }: { session: Session; result?: string }) {
  const view = await companyProfileView(session);
  if (view.state !== 'ready' || !view.data) return null;
  const copy = companyProfileCopy(session.locale), t = makeT(session.locale);
  const fields = [
    ['legal_name', t('i_signup_name_firm'), view.data.legal_name, 200], ['tax_id', copy.identifier, view.data.tax_id, 100],
    ['city', t('i_city'), view.data.address.city, 100], ['district', t('i_district'), view.data.address.district, 100],
    ['street', t('i_street'), view.data.address.street, 300],
  ] as const;
  return <form className="card pad" action={actionSaveCompanyProfile}>
    <h3>{copy.title}</h3>
    {result && ['stale', 'invalid', 'unavailable'].includes(result) && <p role="status">{copy[result as 'stale' | 'invalid' | 'unavailable']}</p>}
    <input type="hidden" name="version" value={view.version ?? ''} />
    <input type="hidden" name="requestId" value={randomUUID()} />
    {fields.map(([name, label, value, max]) => <div className="fg" key={name}>
      <label className="f" htmlFor={`company-${name}`}>{label}</label>
      <input className="inp" id={`company-${name}`} name={name} defaultValue={value} maxLength={max} required={name === 'legal_name'} />
    </div>)}
    <button className="btn pri" type="submit">{t('i_save')}</button>
  </form>;
}

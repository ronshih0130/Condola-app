'use server';
import { redirect } from 'next/navigation';
import { requireCurrentConsent } from './consent-gate';
import { getSession } from './session';
import { saveCompanyProfile } from './company-profiles';

export async function actionSaveCompanyProfile(form: FormData) {
  await requireCurrentConsent();
  const session = await getSession();
  const fields = ['legal_name', 'tax_id', 'city', 'district', 'street', 'version', 'requestId'];
  if ([...form.keys()].some(k => !k.startsWith('$ACTION_') && !fields.includes(k)) ||
    fields.some(k => form.getAll(k).length !== 1 || typeof form.get(k) !== 'string')) redirect('/m/settings?company=invalid');
  const value = (key: string) => (form.get(key) as string).trim();
  const result = await saveCompanyProfile(session, { requestId: value('requestId'), expectedVersion: value('version') || null,
    data: { legal_name: value('legal_name'), tax_id: value('tax_id'), address: { city: value('city'), district: value('district'), street: value('street') } } });
  if (result.state === 'updated' || result.state === 'replayed') redirect('/m/settings?saved=1');
  redirect(`/m/settings?company=${result.state === 'stale' || result.state === 'invalid' ? result.state : 'unavailable'}`);
}

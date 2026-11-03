'use server';
import { redirect } from 'next/navigation';
import { requireCurrentConsent } from './consent-gate';
import { getSession } from './session';
import { saveStaffProfile } from './staff-profile';

export async function actionSaveStaffDisplayName(formData:FormData){
 await requireCurrentConsent();
 const session=await getSession();
 const fields=[...formData.keys()].filter(k=>!k.startsWith('$ACTION_'));
 const allowed=fields.every(k=>k==='name'||k==='version')&&formData.getAll('name').length===1&&formData.getAll('version').length===1;
 const result=allowed?await saveStaffProfile(session,formData.get('name'),formData.get('version')):'invalid';
 if(result==='updated'||result==='unchanged')redirect('/m/account');
 redirect(`/m/account?profile=${encodeURIComponent(result)}`);
}

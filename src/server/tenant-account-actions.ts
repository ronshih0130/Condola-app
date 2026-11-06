"use server";
import { redirect } from "next/navigation";
import { requireCurrentConsent } from "./consent-gate";
import { getSession } from "./session";
import { getTenantAccountSession } from "./tenant-account-session";
import { revokeTenantSession } from "./tenant-account";

export async function actionRevokeTenantSession(formData: FormData) {
  await requireCurrentConsent();
  const result = await revokeTenantSession(await getSession(), String(formData.get("sessionId") ?? ""));
  redirect(result.state === "revoked" ? "/t/account?done=1" : "/t/account?error=1");
}

export async function actionSaveTenantProfile(formData: FormData) {
  await requireCurrentConsent(await getTenantAccountSession());
  const session = await getTenantAccountSession();
  const { saveTenantProfile } = await import('./tenant-profile');
  const result = await saveTenantProfile(session, {
    displayName: formData.get('displayName'), phone: formData.get('phone'), version: formData.get('version'),
  });
  redirect(result === 'updated' ? '/t/account?done=profile' : `/t/account?error=${result}`);
}

export async function actionChangeTenantPassword(formData: FormData) {
  await requireCurrentConsent(await getTenantAccountSession());
  const session = await getTenantAccountSession();
  const { changeTenantPassword } = await import('./tenant-profile');
  const result = await changeTenantPassword(session, {
    currentPassword: formData.get('currentPassword'), password: formData.get('password'), confirm: formData.get('confirm'),
  });
  redirect(result === 'changed' ? '/t/account?done=password' : `/t/account?error=${result}`);
}

"use server";

import { clearUnitQrCookie } from "./unit-qr-cookie";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { requireCurrentConsent } from "./consent-gate";
import { getSession } from "./session";
import { completeUnitQr, issueUnitQr, readUnitQrContext, revokeUnitQr } from "./unit-qr-signup";
import { readSignupIdentity } from "./signup";

export async function actionIssueUnitQr(_previous: { id: string; url: string } | null, form: FormData) {
  await requireCurrentConsent();
  const session = await getSession();
  const h = await headers();
  const host = h.get("x-forwarded-host") || h.get("host") || "";
  const issued = await issueUnitQr(session, String(form.get("unitId") ?? ""), host);
  if (!issued) notFound();
  return { id: issued.id, url: issued.url };
}
export async function actionRevokeUnitQr(form: FormData) {
  await requireCurrentConsent();
  if (!await revokeUnitQr(await getSession(), String(form.get("id") ?? ""))) notFound();
  redirect("/m/units/qr");
}
// A pending applicant intentionally has no staff/portal Session. The existing
// signup identity verifies the auth session; completeUnitQr checks current consent.
export async function actionCompleteUnitQr(form: FormData) {
  const identity = await readSignupIdentity();
  if (!identity?.confirmed) redirect("/signup");
  const context = await readUnitQrContext(null, identity.user_id);
  if (!context || context.id !== String(form.get("contextId") ?? "")) notFound();
  const result = await completeUnitQr(identity.user_id, context.id, String(form.get("contactName") ?? ""), String(form.get("phone") ?? ""));
  if (!result) redirect("/signup/firm?error=required");
  clearUnitQrCookie(await cookies());
  redirect("/signup/firm");
}

export async function actionAbandonUnitQr() {
  clearUnitQrCookie(await cookies());
  redirect("/signup");
}

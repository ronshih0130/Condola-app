"use server";
import { redirect } from "next/navigation";
import { requireCurrentConsent } from "./consent-gate";
import { getSession } from "./session";
import { revokeTenantSession } from "./tenant-account";

export async function actionRevokeTenantSession(formData: FormData) {
  await requireCurrentConsent();
  const result = await revokeTenantSession(await getSession(), String(formData.get("sessionId") ?? ""));
  redirect(result.state === "revoked" ? "/t/account?done=1" : "/t/account?error=1");
}

"use server";
import type { ResendResult } from "../lib/portal-resend-state";
import { simulatedResult } from "../lib/portal-resend-state";
import { requireCurrentConsent } from "./consent-gate";
import { resendPortalInvite } from "./portal-resend";
import { getSession } from "./session";

export async function actionResendPortalInvite(_previous: ResendResult | null, form: FormData): Promise<ResendResult> {
  await requireCurrentConsent();
  const session = await getSession();
  const sourceId = form.get("sourceId"), requestId = form.get("requestId");
  if (typeof sourceId !== "string" || typeof requestId !== "string") return simulatedResult("conflict");
  return resendPortalInvite(session, { sourceId, requestId });
}

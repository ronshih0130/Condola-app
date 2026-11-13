"use server";
// B-056 「開始試用」 (MGT-96-AC2, MGT-96-AC4). The settings card and confirm dialog that post here
// ship in PR-6 (mockup b73680e); until then nothing in the UI posts to this action. The org is
// always the session's live org; a client-supplied org id is never read. No outbound.
import { redirect } from "next/navigation";
import { guardEffectiveSession } from "@/server/b017-custom-role-governance";
import { requireCurrentConsent } from "./consent-gate";
import { FlowError } from "./errors";
import { getSession } from "./session";
import { parseTrialPlan } from "./b056-trial-rules";
import { pricingTrialOnFor, startTrial } from "./b056-trial";
import { withClient } from "./db";

function isRedirect(error: unknown) {
  return typeof error === "object" && error !== null && "digest" in error && String((error as { digest?: unknown }).digest).startsWith("NEXT_REDIRECT");
}

function bounce(error: unknown): never {
  if (isRedirect(error)) throw error;
  const key = error instanceof FlowError ? error.key : "errors.generic";
  redirect(`/m/settings?${new URLSearchParams({ error: key }).toString()}`);
}

export async function actionStartTrial(formData: FormData) {
  await requireCurrentConsent();
  const session = await guardEffectiveSession(await getSession(), "settings.edit");
  try {
    const orgId = session.liveOrgId;
    // Flag OFF: the action does not exist for this org.
    if (!orgId || !(await withClient((client) => pricingTrialOnFor(client, orgId)))) throw new FlowError("errors.notFound");
    const plan = parseTrialPlan(formData.get("plan"));
    if (!plan) throw new FlowError("errors.required");
    await startTrial(session, plan);
    redirect("/m/settings?trial=started");
  } catch (error) {
    bounce(error);
  }
}

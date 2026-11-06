"use server";

import { guardEffectiveSession } from "@/server/b017-custom-role-governance";

import { revalidatePath } from "next/cache";
import { requireCurrentConsent } from "./consent-gate";
import { saveOnboarding } from "./onboarding-progress";
import { getSession } from "./session";

export async function actionSaveOnboardingChoices(form: FormData) {
  await requireCurrentConsent();
  const session = await guardEffectiveSession(await getSession(), null);
  const saved = await saveOnboarding(session, { tenant: form.get("tenant") === "on", owner: form.get("owner") === "on", team: form.get("team") === "on" });
  if (saved) revalidatePath("/m");
}

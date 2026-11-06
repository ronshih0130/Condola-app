"use server";

import { guardEffectiveSession } from "@/server/b017-custom-role-governance";

import { requireCurrentConsent } from "./consent-gate";

import { redirect } from "next/navigation";
import { FlowError } from "./errors";
import { dismissSamplePrompt, loadSampleData } from "./sandbox";
import { getSession } from "./session";

function isRedirect(error: unknown) {
  return typeof error === "object" && error !== null && "digest" in error && String((error as { digest: unknown }).digest).startsWith("NEXT_REDIRECT");
}

function fail(error: unknown, to: string): never {
  if (isRedirect(error)) throw error;
  const key = error instanceof FlowError ? error.key : "errors.generic";
  redirect(`${to}?error=${encodeURIComponent(key)}`);
}

export async function actionLoadSample() {
  await requireCurrentConsent();
  const session = await guardEffectiveSession(await getSession(), null);
  try {
    await loadSampleData(session);
  } catch (error) {
    fail(error, "/m");
  }
  redirect("/m/properties");
}

export async function actionBlankSandbox() {
  await requireCurrentConsent();
  const session = await guardEffectiveSession(await getSession(), null);
  try {
    await dismissSamplePrompt(session);
  } catch (error) {
    fail(error, "/m");
  }
  redirect("/m");
}

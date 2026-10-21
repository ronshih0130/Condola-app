"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { FlowError } from "./errors";
import { ENV_COOKIE, ORG_COOKIE } from "./org-scope";
import { appCookieOptions } from "./public-origin";
import { dismissSamplePrompt, goLive, loadSampleData } from "./sandbox";
import { getSession } from "./session";

function isRedirect(error: unknown) {
  return typeof error === "object" && error !== null && "digest" in error && String((error as { digest: unknown }).digest).startsWith("NEXT_REDIRECT");
}

function fail(error: unknown, to: string): never {
  if (isRedirect(error)) throw error;
  const key = error instanceof FlowError ? error.key : "errors.generic";
  redirect(`${to}?error=${encodeURIComponent(key)}`);
}

async function setEnvCookie(environment: "live" | "sandbox", liveOrgId: string) {
  const jar = await cookies();
  const sessionCookie = appCookieOptions({ httpOnly: false });
  jar.set(ENV_COOKIE, environment, sessionCookie);
  jar.set(ORG_COOKIE, liveOrgId, sessionCookie);
}

export async function actionLoadSample() {
  const session = await getSession();
  try {
    await loadSampleData(session);
  } catch (error) {
    fail(error, "/m");
  }
  redirect("/m/properties");
}

export async function actionBlankSandbox() {
  const session = await getSession();
  try {
    await dismissSamplePrompt(session);
  } catch (error) {
    fail(error, "/m");
  }
  redirect("/m");
}

export async function actionGoLive(formData: FormData) {
  const session = await getSession();
  try {
    await goLive(session, formData.get("copy") === "on");
  } catch (error) {
    fail(error, "/m/env");
  }
  await setEnvCookie("live", session.liveOrgId);
  redirect("/m?golive=1");
}

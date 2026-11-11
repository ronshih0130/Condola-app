"use server";

import { guardEffectiveSession } from "@/server/b017-custom-role-governance";

import { requireCurrentConsent } from "./consent-gate";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { sessionCookie, type RequestMeta } from "./auth";
import { FlowError } from "./errors";
import { clearStoredEnvChoice, ENV_COOKIE_MAX_AGE, ORG_COOKIE } from "./org-scope";
import { PORTAL_ROLE_COOKIE } from "./portal-role";
import {
  clearFirmOverride,
  createPartnerCode,
  previewPartnerCode,
  requestUpgrade,
  setFirmOverride,
} from "./partners";
import { isPlatformAdmin } from "./platform";
import { appCookieOptions } from "./public-origin";
import { getSession, requestPrefs } from "./session";
import { partnerRequestMeta } from "./partner-consent";
import { sessionEntryPath } from "./sign-out";
import { signupVerifyType } from "./signup-gotrue";
import {
  changeSignupEmail,
  confirmSignupToken,
  confirmSupabaseAccessToken,
  confirmSupabaseTokenHash,
  createFirm,
  readSignupIdentity,
  signupResendAcknowledgement,
  startSignup,
} from "./signup";

function text(value: FormDataEntryValue | null) {
  return String(value ?? "").trim();
}

function isRedirect(error: unknown) {
  return typeof error === "object" && error !== null && "digest" in error && String((error as { digest?: unknown }).digest).startsWith("NEXT_REDIRECT");
}

async function meta(): Promise<RequestMeta> {
  const h = await headers();
  return { ua: h.get("user-agent"), ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") };
}

async function origin() {
  const h = await headers();
  const host = h.get("x-forwarded-host") || h.get("host") || "";
  const proto = h.get("x-forwarded-proto") || (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return host ? `${proto}://${host}` : "";
}

async function setSession(token: string) {
  const jar = await cookies();
  const cookie = sessionCookie(token, true);
  jar.set(cookie.name, cookie.value, cookie.options);
  clearStoredEnvChoice(jar);
  jar.delete(PORTAL_ROLE_COOKIE);
}

function bounce(path: string, error: unknown): never {
  if (isRedirect(error)) throw error;
  const key = error instanceof FlowError ? error.key : "errors.generic";
  const [pathname, query = ""] = path.split("?");
  const params = new URLSearchParams(query);
  params.set("error", key);
  redirect(`${pathname}?${params.toString()}`);
}

export async function actionPreviewCode(code: string) {
  return previewPartnerCode(code);
}

export async function actionStartSignup(formData: FormData) {
  const result = await startSignup({
    email: text(formData.get("email")),
    password: String(formData.get("password") ?? ""),
    confirm: String(formData.get("confirm") ?? ""),
    partnerCode: text(formData.get("partnerCode")),
    origin: await origin(),
    meta: await meta(),
    consent: formData.get("consent") === "on",
  });
  if (!result.ok) {
    redirect(`/signup?error=${result.error}`);
  }
  if (result.status === "firm") {
    await setSession(result.token);
    redirect(sessionEntryPath("/signup/firm"));
  }
  redirect(verifyTarget(result.email, result, false));
}

function verifyTarget(email: string, result: { devToken: string | null; mail?: "failed" | "wait" }, resent: boolean) {
  const params = new URLSearchParams({ email });
  if (result.mail) params.set("mail", result.mail);
  else if (resent) params.set("resent", "1");
  if (!result.mail && result.devToken) params.set("dev", result.devToken);
  return `/signup/verify?${params.toString()}`;
}

export async function actionResendSignup(formData: FormData) {
  const request = await meta();
  const email = text(formData.get("email"));
  redirect(await signupResendAcknowledgement(email, await origin(), request.ip));
}

export async function actionChangeSignupEmail(formData: FormData) {
  const request = await meta();
  const result = await changeSignupEmail({
    currentEmail: text(formData.get("email")),
    password: String(formData.get("password") ?? ""),
    nextEmail: text(formData.get("nextEmail")),
    origin: await origin(),
    ip: request.ip,
  });
  if (!result.ok) redirect(`/signup/verify?email=${encodeURIComponent(text(formData.get("email")))}&error=${result.error}`);
  redirect(verifyTarget(result.email, result, true));
}

export async function actionConfirmToken(formData: FormData) {
  const result = await confirmSignupToken(text(formData.get("token")), await meta());
  if (!result.ok) redirect("/signup/confirm?expired=1");
  await setSession(result.token);
  redirect(sessionEntryPath("/signup/firm"));
}

export async function actionConfirmSupabaseHash(formData: FormData) {
  const type = signupVerifyType(text(formData.get("type")));
  if (!type) redirect("/signup/confirm?expired=1");
  const result = await confirmSupabaseTokenHash(text(formData.get("token_hash")), type, await meta());
  if (!result.ok) redirect("/signup/confirm?expired=1");
  await setSession(result.token);
  redirect(sessionEntryPath("/signup/firm"));
}

export async function actionConfirmSupabase(accessToken: string) {
  try {
    const result = await confirmSupabaseAccessToken(accessToken, await meta());
    if (!result.ok) redirect("/signup/confirm?expired=1");
    await setSession(result.token);
    redirect(sessionEntryPath("/signup/firm"));
  } catch (error) {
    if (isRedirect(error)) throw error;
    // Do not log error. A server-action failure can include the argument.
    console.error("confirm access token failed");
    redirect("/signup/confirm?expired=1");
  }
}

export async function actionCreateFirm(formData: FormData) {
  const identity = await readSignupIdentity();
  if (!identity) redirect("/signup");
  if (!identity.confirmed) redirect(`/signup/verify?email=${encodeURIComponent(identity.email)}`);
  if (identity.org_id) redirect("/m");
  try {
    const created = await createFirm({
      userId: identity.user_id,
      email: identity.email,
      kind: text(formData.get("kind")),
      name: text(formData.get("name")),
      contactName: text(formData.get("contactName")),
      phone: text(formData.get("phone")),
      phoneCountry: text(formData.get("phoneCountry")),
      country: text(formData.get("country")),
      partnerCode: text(formData.get("partnerCode")) || identity.partner_code || "",
      partnerConsent: formData.get("partnerConsent") === "on",
      partnerAuthority: formData.get("partnerAuthority") === "on",
      partnerLocale: (await requestPrefs()).locale,
      partnerMeta: partnerRequestMeta(await headers()),
      consent: formData.get("consent") === "on",
    });
    if (!created.ok) redirect(`/signup/firm?error=${created.error === "consent" ? "consent" : "required"}`);
    const jar = await cookies();
    const persisted = appCookieOptions({ httpOnly: false, maxAge: ENV_COOKIE_MAX_AGE });
    clearStoredEnvChoice(jar);
    jar.set(ORG_COOKIE, created.orgId, persisted);
    const params = new URLSearchParams();
    if (created.dupName) params.set("dupFirm", "1");
    if (created.codeIgnored) params.set("code", "list");
    redirect(params.size ? `/m?${params.toString()}` : "/m");
  } catch (error) {
    bounce("/signup/firm", error);
  }
}

export async function actionRequestUpgrade(formData: FormData) {
  await requireCurrentConsent();
  const session = await guardEffectiveSession(await getSession(), null);
  const tier = text(formData.get("tier")) === "pro" ? "pro" : "standard";
  try {
    const result = await requestUpgrade(session, tier, text(formData.get("partnerCode")));
    const params = new URLSearchParams({ sent: "1", tier });
    if (result.codeIgnored) params.set("code", "list");
    redirect(`/m/upgrade?${params.toString()}`);
  } catch (error) {
    bounce("/m/upgrade", error);
  }
}

async function requirePlatformAdmin() {
  const session = await getSession();
  if (!isPlatformAdmin(session.email)) redirect("/m/noperm");
  return session;
}

export async function actionCreatePartnerCode(formData: FormData) {
  await requireCurrentConsent();
  let session = await requirePlatformAdmin();
  session = await guardEffectiveSession(session, null);
  const number = (name: string, fallback: number) => {
    const raw = text(formData.get(name));
    if (!raw) return fallback;
    const value = Number(raw);
    return Number.isInteger(value) ? value : Number.NaN;
  };
  try {
    await createPartnerCode(session.userId, {
      code: text(formData.get("code")),
      partnerName: text(formData.get("partnerName")),
      standardPrice: number("standardPrice", 0),
      proPrice: number("proPrice", 0),
      freeUnits: number("freeUnits", 4),
      trialMonths: number("trialMonths", 3),
      lockMonths: number("lockMonths", 12),
      maxUses: number("maxUses", 1),
      expiresAt: text(formData.get("expiresAt")) || null,
    });
  } catch (error) {
    bounce("/m/admin", error);
  }
  redirect("/m/admin?saved=1");
}

export async function actionSetPriceOverride(formData: FormData) {
  await requireCurrentConsent();
  let session = await requirePlatformAdmin();
  session = await guardEffectiveSession(session, null);
  try {
    await setFirmOverride(session.userId, text(formData.get("orgId")), Number(text(formData.get("rate"))));
  } catch (error) {
    bounce("/m/admin", error);
  }
  redirect("/m/admin?saved=1");
}

export async function actionClearPriceOverride(formData: FormData) {
  await requireCurrentConsent();
  let session = await requirePlatformAdmin();
  session = await guardEffectiveSession(session, null);
  try {
    await clearFirmOverride(session.userId, text(formData.get("orgId")));
  } catch (error) {
    bounce("/m/admin", error);
  }
  redirect("/m/admin?saved=1");
}

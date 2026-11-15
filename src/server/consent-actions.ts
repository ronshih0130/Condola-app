"use server";

import { guardEffectiveSession } from "@/server/b017-custom-role-governance";

import { redirect } from "next/navigation";
import { passConsentGate, consentNextPath } from "./consent-gate";
import { roleHomeForSession } from "./role-home-v3";
import { readSignupIdentity } from "./signup";
import { readSession } from "./session";

function text(value: FormDataEntryValue | null) {
  return String(value ?? "").trim();
}

export async function actionAcceptReconsent(formData: FormData) {
  if (formData.get("partnerConsentPage") === "1") {
    return (await import("./partner-consent-submit")).submitPartnerConsent(formData);
  }
  const identity = await readSignupIdentity();
  if (!identity) redirect("/login");
  const session = await guardEffectiveSession(await readSession(), null);
  const raw = text(formData.get("next"));
  // The brand lookup runs only when `next` gives no usable destination (flag OFF adds no query otherwise).
  const next = consentNextPath(raw, "") || (session ? await roleHomeForSession(session) : "/signup/firm");
  if (session && (session.kind === "owner" || session.kind === "tenant")) {
    redirect(`/consent/portal?next=${encodeURIComponent(next)}`);
  }
  const gate = await passConsentGate(identity.user_id, "reconsent", formData.get("consent") === "on");
  if (!gate.ok) redirect(`/consent?next=${encodeURIComponent(next)}&error=consent`);
  redirect(next);
}

export async function actionAcceptPortalConsent(formData: FormData) {
  const session = await guardEffectiveSession(await readSession(), null);
  if (!session) redirect("/login");
  const raw = text(formData.get("next"));
  const next = consentNextPath(raw, "") || await roleHomeForSession(session);
  if (session.kind !== "owner" && session.kind !== "tenant") {
    redirect(`/consent?next=${encodeURIComponent(next)}`);
  }
  const gate = await passConsentGate(session.userId, "portal", formData.get("consent") === "on");
  if (!gate.ok) redirect(`/consent/portal?next=${encodeURIComponent(next)}&error=consent`);
  redirect(next);
}

"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  acceptInvite,
  beginMfa,
  challengeCookie,
  changePassword,
  CHALLENGE_COOKIE,
  completeSecondFactor,
  confirmMfa,
  disableMfa,
  inviteMember,
  requestPasswordReset,
  resendInvite,
  resetPassword,
  verifyRecoveryTokenHash,
  revokeInvite,
  revokeOtherSessions,
  revokeSession,
  sessionCookie,
  setMemberActive,
  setMemberRole,
  setOwnerPrivacy,
  setRequireMfa,
  normalizeEmail,
  signIn,
  signInWithLine,
  SESSION_COOKIE,
  type RequestMeta,
} from "./auth";
import { BACKUP_COOKIE } from "./backup";
import { forgotSentLocation, resetFlashCookie } from "./reset-flash";
import { demoModeEnabled } from "./demo";
import { addExpense, closeMonth, reversePayment } from "./domain";
import { FlowError } from "./errors";
import { appCookieOptions, sameAppPath } from "./public-origin";
import { getSession, readSession } from "./session";
import type { OrgRole } from "./types";

function isRedirect(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "digest" in error &&
    String((error as { digest?: string }).digest).startsWith("NEXT_REDIRECT")
  );
}

function text(value: FormDataEntryValue | null) {
  return String(value ?? "");
}

function safeNext(value: string) {
  const path = sameAppPath(value);
  if (!path || path.startsWith("/login") || path.startsWith("/auth/continue")) return "";
  return path;
}

async function meta(): Promise<RequestMeta> {
  const h = await headers();
  return {
    ua: h.get("user-agent"),
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip"),
  };
}

function bounce(path: string, error: unknown): never {
  if (isRedirect(error)) throw error;
  const key = error instanceof FlowError ? error.key : "errors.generic";
  const [pathname, query = ""] = path.split("?");
  const params = new URLSearchParams(query);
  params.set("error", key);
  redirect(`${pathname}?${params.toString()}`);
}

async function rememberBackup(codes: string[]) {
  const jar = await cookies();
  jar.set(BACKUP_COOKIE, codes.join(" "), appCookieOptions({ maxAge: 300 }));
}

export async function actionSignIn(formData: FormData) {
  const next = safeNext(text(formData.get("next")));
  const email = normalizeEmail(text(formData.get("email"))) || text(formData.get("email")).trim();
  const result = await signIn(text(formData.get("email")), text(formData.get("password")), formData.get("remember") === "on", await meta());
  const jar = await cookies();
  const nextQuery = next ? `&next=${encodeURIComponent(next)}` : "";
  if (result.ok) {
    const cookie = sessionCookie(result.token, result.remember);
    jar.set(cookie.name, cookie.value, cookie.options);
    jar.delete(CHALLENGE_COOKIE);
    redirect(result.destination === "firm" ? "/signup/firm" : next || "/auth/continue");
  }
  if ("step" in result) {
    const cookie = challengeCookie(result.challengeId);
    jar.set(cookie.name, cookie.value, cookie.options);
    redirect(`/login?step=${result.step}${nextQuery}`);
  }
  if (result.error === "unconfirmed") {
    redirect(`/login?error=unconfirmed&email=${encodeURIComponent(email)}${nextQuery}`);
  }
  redirect(`/login?error=${result.error}${nextQuery}`);
}

export async function actionVerifyRecovery(formData: FormData) {
  const type = text(formData.get("type")).trim();
  if (type !== "recovery") redirect("/reset?expired=1");
  const result = await verifyRecoveryTokenHash(text(formData.get("token_hash")));
  if (!result.ok) redirect("/reset?expired=1");
  redirect(`/reset/${encodeURIComponent(result.token)}`);
}

export async function actionLineLogin() {
  const result = await signInWithLine(await meta());
  const jar = await cookies();
  if (result.ok) {
    const cookie = sessionCookie(result.token, result.remember);
    jar.set(cookie.name, cookie.value, cookie.options);
    jar.delete(CHALLENGE_COOKIE);
    redirect("/auth/continue");
  }
  if ("step" in result) {
    const cookie = challengeCookie(result.challengeId);
    jar.set(cookie.name, cookie.value, cookie.options);
    redirect(`/login?step=${result.step}`);
  }
  redirect(`/login?error=${result.error}`);
}

export async function actionSecondFactor(formData: FormData) {
  const jar = await cookies();
  const challengeId = jar.get(CHALLENGE_COOKIE)?.value ?? "";
  const next = safeNext(text(formData.get("next")));
  const result = await completeSecondFactor(challengeId, text(formData.get("code")), await meta());
  if (!result.ok) {
    const step = text(formData.get("step")) === "enroll" ? "enroll" : "2fa";
    redirect(`/login?step=${step}&error=invalid${next ? `&next=${encodeURIComponent(next)}` : ""}`);
  }
  const cookie = sessionCookie(result.token, result.remember);
  jar.set(cookie.name, cookie.value, cookie.options);
  jar.delete(CHALLENGE_COOKIE);
  if (result.backupCodes?.length) await rememberBackup(result.backupCodes);
  redirect(result.backupCodes?.length ? "/login?step=backup" : next || "/auth/continue");
}

export async function actionForgot(formData: FormData) {
  const email = text(formData.get("email"));
  await requestPasswordReset(email);
  const jar = await cookies();
  const cookie = resetFlashCookie(email);
  jar.set(cookie.name, cookie.value, cookie.options);
  redirect(forgotSentLocation());
}

export async function actionReset(formData: FormData) {
  const token = text(formData.get("token"));
  const result = await resetPassword(token, text(formData.get("password")), text(formData.get("confirm")));
  if (!result.ok) redirect(`/reset/${encodeURIComponent(token)}?error=${result.error}`);
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  redirect("/login?reset=1");
}

export async function actionAccept(formData: FormData) {
  const token = text(formData.get("token"));
  const result = await acceptInvite(token, text(formData.get("name")), text(formData.get("password")), text(formData.get("confirm")), await meta());
  if (!result.ok) redirect(`/accept/${encodeURIComponent(token)}?error=${result.error}`);
  const jar = await cookies();
  const cookie = sessionCookie(result.token, true);
  jar.set(cookie.name, cookie.value, cookie.options);
  redirect("/auth/continue");
}

export async function actionInvite(formData: FormData) {
  const back = "/m/team";
  try {
    const session = await getSession();
    const invited = await inviteMember(session, {
      email: text(formData.get("email")),
      name: text(formData.get("name")),
      role: text(formData.get("role")),
    });
    const link = demoModeEnabled() ? invited.token : "";
    redirect(link ? `${back}?invited=1&token=${encodeURIComponent(link)}` : `${back}?invited=1`);
  } catch (error) {
    bounce(back, error);
  }
}

export async function actionResendInvite(formData: FormData) {
  const back = "/m/team";
  try {
    const session = await getSession();
    const invited = await resendInvite(session, text(formData.get("invitationId")));
    redirect(demoModeEnabled() ? `${back}?invited=1&token=${encodeURIComponent(invited.token)}` : `${back}?invited=1`);
  } catch (error) {
    bounce(back, error);
  }
}

export async function actionRevokeInvite(formData: FormData) {
  try {
    const session = await getSession();
    await revokeInvite(session, text(formData.get("invitationId")));
    redirect("/m/team");
  } catch (error) {
    bounce("/m/team", error);
  }
}

export async function actionMemberRole(formData: FormData) {
  try {
    const session = await getSession();
    await setMemberRole(session, text(formData.get("memberId")), text(formData.get("role")) as OrgRole);
    redirect("/m/team");
  } catch (error) {
    bounce("/m/team", error);
  }
}

export async function actionMemberActive(formData: FormData) {
  try {
    const session = await getSession();
    const active = text(formData.get("active")) === "1";
    await setMemberActive(session, text(formData.get("memberId")), active, text(formData.get("confirm")) === "yes");
    redirect("/m/team");
  } catch (error) {
    bounce("/m/team", error);
  }
}

export async function actionChangePassword(formData: FormData) {
  try {
    const session = await getSession();
    await changePassword(session, text(formData.get("current")), text(formData.get("password")), text(formData.get("confirm")));
    redirect("/m/account?saved=1");
  } catch (error) {
    bounce("/m/account", error);
  }
}

export async function actionBeginMfa() {
  try {
    const session = await getSession();
    const started = await beginMfa(session);
    const jar = await cookies();
    const cookie = challengeCookie(started.challengeId);
    jar.set(cookie.name, cookie.value, cookie.options);
    redirect("/m/account?enroll=1");
  } catch (error) {
    bounce("/m/account", error);
  }
}

export async function actionConfirmMfa(formData: FormData) {
  try {
    const session = await getSession();
    const jar = await cookies();
    const codes = await confirmMfa(session, jar.get(CHALLENGE_COOKIE)?.value ?? "", text(formData.get("code")));
    jar.delete(CHALLENGE_COOKIE);
    await rememberBackup(codes);
    redirect("/m/account?backup=1");
  } catch (error) {
    bounce("/m/account?enroll=1", error);
  }
}

export async function actionDisableMfa() {
  try {
    const session = await getSession();
    await disableMfa(session);
    redirect("/m/account?saved=1");
  } catch (error) {
    bounce("/m/account", error);
  }
}

export async function actionRequireMfa(formData: FormData) {
  try {
    const session = await getSession();
    await setRequireMfa(session, formData.get("require") === "on");
    redirect("/m/account?saved=1");
  } catch (error) {
    bounce("/m/account", error);
  }
}

export async function actionOwnerPrivacy(formData: FormData) {
  try {
    const session = await getSession();
    await setOwnerPrivacy(session, {
      showName: formData.get("showName") === "on",
      showPhone: formData.get("showPhone") === "on",
    });
    redirect("/m/roles?saved=1");
  } catch (error) {
    bounce("/m/roles", error);
  }
}

export async function actionRevokeSession(formData: FormData) {
  const session = await getSession();
  const id = text(formData.get("sessionId"));
  await revokeSession(session.userId, id);
  if (id === session.sessionId) {
    const jar = await cookies();
    jar.delete(SESSION_COOKIE);
    redirect("/login");
  }
  redirect("/m/account");
}

export async function actionRevokeOthers() {
  const session = await getSession();
  await revokeOtherSessions(session.userId, session.sessionId);
  redirect("/m/account?saved=1");
}

export async function actionClearBackup() {
  const jar = await cookies();
  jar.delete(BACKUP_COOKIE);
}

export async function actionSignOut() {
  const session = await readSession();
  if (session) await revokeSession(session.userId, session.sessionId);
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  jar.delete(CHALLENGE_COOKIE);
  jar.delete("condola_env");
  redirect("/login");
}

export async function actionAddExpense(formData: FormData) {
  try {
    const session = await getSession();
    await addExpense(session, {
      propertyId: text(formData.get("propertyId")),
      description: text(formData.get("description")),
      amountMajor: Number(text(formData.get("amount"))),
      receiptName: text(formData.get("receipt")),
    });
    redirect("/m/statements?saved=1");
  } catch (error) {
    bounce("/m/statements", error);
  }
}

export async function actionReversePayment(formData: FormData) {
  try {
    const session = await getSession();
    await reversePayment(session, text(formData.get("paymentId")), text(formData.get("reason")));
    redirect("/m/payments?saved=1");
  } catch (error) {
    bounce("/m/payments", error);
  }
}

export async function actionCloseMonth(formData: FormData) {
  try {
    const session = await getSession();
    await closeMonth(session, text(formData.get("month")), text(formData.get("note")));
    redirect("/m/close?saved=1");
  } catch (error) {
    bounce("/m/close", error);
  }
}

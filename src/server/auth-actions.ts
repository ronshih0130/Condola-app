"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  acceptInvite,
  beginMfa,
  describeInvite,
  challengeCookie,
  changePassword,
  CHALLENGE_COOKIE,
  completeSecondFactor,
  confirmMfa,
  disableMfa,
  inviteMember,
  completePasswordReset,
  requestPasswordReset,
  resendInvite,
  revokeInvite,
  revokeAllSessions,
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
import { saveMemberEmailPrefs, saveOrgMailSettings } from "./mail-settings";
import { forgotSentLocation, resetFlashCookie } from "./reset-flash";
import { demoModeEnabled } from "./demo";
import { closeMonth, reversePayment } from "./domain";
import { addExpense, approveExpense, createExpense, updateExpense, voidExpense } from "./expenses";
import { FlowError, isDbTimeout } from "./errors";
import { portalPageTarget, sameId } from "@/lib/portal-page";
import { issuePortalInvite } from "./portal-invite";
import { clearStoredEnvChoice } from "./org-scope";
import { PORTAL_ROLE_COOKIE } from "./portal-role";
import { appCookieOptions, sameAppPath } from "./public-origin";
import { clearAuthCookies, sessionEntryPath } from "./sign-out";
import { getSession, readSession } from "./session";
import { TEAM_INVITES_ENABLED, assertTeamInvitesEnabled } from "./team-invites";
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
    clearStoredEnvChoice(jar);
    jar.delete(PORTAL_ROLE_COOKIE);
    redirect(sessionEntryPath(result.destination === "firm" ? "/signup/firm" : next || "/auth/continue"));
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

export async function actionLineLogin() {
  const result = await signInWithLine(await meta());
  const jar = await cookies();
  if (result.ok) {
    const cookie = sessionCookie(result.token, result.remember);
    jar.set(cookie.name, cookie.value, cookie.options);
    jar.delete(CHALLENGE_COOKIE);
    clearStoredEnvChoice(jar);
    jar.delete(PORTAL_ROLE_COOKIE);
    redirect(sessionEntryPath("/auth/continue"));
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
  clearStoredEnvChoice(jar);
  jar.delete(PORTAL_ROLE_COOKIE);
  if (result.backupCodes?.length) await rememberBackup(result.backupCodes);
  redirect(sessionEntryPath(result.backupCodes?.length ? "/login?step=backup" : next || "/auth/continue"));
}

async function requestOrigin() {
  const h = await headers();
  const host = h.get("x-forwarded-host") || h.get("host") || "";
  const proto = h.get("x-forwarded-proto") || (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return host ? `${proto}://${host}` : "";
}

export async function actionForgot(formData: FormData) {
  const email = text(formData.get("email"));
  const info = await meta();
  await requestPasswordReset(email, await requestOrigin(), info);
  const jar = await cookies();
  const cookie = resetFlashCookie();
  jar.set(cookie.name, cookie.value, cookie.options);
  redirect(forgotSentLocation());
}

export async function actionReset(formData: FormData) {
  const token = text(formData.get("token"));
  const tokenHash = text(formData.get("token_hash")).trim();
  const type = text(formData.get("type")).trim();
  const result = await completePasswordReset({
    token,
    tokenHash,
    type,
    password: text(formData.get("password")),
    confirm: text(formData.get("confirm")),
  });
  if (!result.ok) {
    if (tokenHash) {
      if (result.error === "expired") redirect("/reset?expired=1");
      redirect(`/reset?token_hash=${encodeURIComponent(tokenHash)}&type=recovery&error=${result.error}`);
    }
    redirect(`/reset/${encodeURIComponent(token)}?error=${result.error}`);
  }
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  redirect("/login?reset=1");
}

export async function actionEmailPrefs(formData: FormData) {
  try {
    const session = await getSession();
    await saveMemberEmailPrefs(session, {
      leaseExpiry: formData.get("leaseExpiry") === "on",
      rentOverdue: formData.get("rentOverdue") === "on",
    });
    redirect("/m/account?saved=1");
  } catch (error) {
    bounce("/m/account", error);
  }
}

export async function actionOrgMail(formData: FormData) {
  try {
    const session = await getSession();
    await saveOrgMailSettings(session, {
      tenantLease: formData.get("tenantLease") === "on",
      tenantOverdue: formData.get("tenantOverdue") === "on",
      contactEmail: text(formData.get("contactEmail")),
      contactPhone: text(formData.get("contactPhone")),
    });
    redirect("/m/settings?saved=1");
  } catch (error) {
    bounce("/m/settings", error);
  }
}

export async function actionAccept(formData: FormData) {
  const token = text(formData.get("token"));
  if (!TEAM_INVITES_ENABLED) {
    const invite = await describeInvite(token, await meta());
    if (invite.kind === "team_member") {
      redirect(`/accept/${encodeURIComponent(token)}?error=errors.teamInvitesSoon`);
    }
  }
  const current = await readSession();
  const result = await acceptInvite(
    token,
    text(formData.get("name")),
    text(formData.get("password")),
    text(formData.get("confirm")),
    await meta(),
    text(formData.get("email")),
    current?.email ?? "",
    formData.get("consent") === "on",
  );
  if (!result.ok) {
    const portal = result.kind === "owner" || result.kind === "tenant" || result.kind === "unknown";
    const fieldError =
      result.error === "weak" ||
      result.error === "mismatch" ||
      result.error === "email" ||
      result.error === "auth" ||
      result.error === "timeout" ||
      result.error === "bound" ||
      result.error === "failed" ||
      result.error === "account";
    if (portal && !fieldError) {
      redirect(`/accept/${encodeURIComponent(token)}`);
    }
    redirect(`/accept/${encodeURIComponent(token)}?error=${result.error}`);
  }
  const jar = await cookies();
  const cookie = sessionCookie(result.token, true);
  jar.set(cookie.name, cookie.value, cookie.options);
  clearStoredEnvChoice(jar);
  jar.delete(PORTAL_ROLE_COOKIE);
  if ("destination" in result && result.destination) redirect(result.destination);
  redirect(sessionEntryPath("/auth/continue"));
}

export async function actionIssuePortalInvite(input: {
  kind: string;
  contactId: string;
  pageId: string;
  leaseId?: string;
  rotate?: boolean;
}) {
  try {
    const session = await getSession();
    const kind = input.kind === "owner" || input.kind === "tenant" ? input.kind : "";
    if (!kind || !input.contactId || !input.pageId) return { ok: false as const, error: "errors.required" };
    const path = (await headers()).get("x-pathname") || "";
    const page = portalPageTarget(path);
    if (!page || page.kind !== kind || !sameId(page.pageId, input.pageId)) {
      return { ok: false as const, error: "errors.portalMismatch" };
    }
    if (kind === "owner" && !sameId(input.pageId, input.contactId)) {
      return { ok: false as const, error: "errors.portalMismatch" };
    }
    if (kind === "tenant" && !sameId(input.pageId, input.leaseId || "")) {
      return { ok: false as const, error: "errors.portalMismatch" };
    }
    const issued = await issuePortalInvite(
      session,
      {
        kind,
        contactId: input.contactId,
        pageId: input.pageId,
        leaseId: input.leaseId || undefined,
        rotate: input.rotate === true,
      },
      await requestOrigin(),
    );
    if (issued.activated) return { ok: true as const, activated: true as const, contactId: issued.contactId };
    return {
      ok: true as const,
      activated: false as const,
      url: issued.url,
      contactId: issued.contactId,
      name: issued.name,
      email: issued.email,
    };
  } catch (error) {
    if (isRedirect(error)) throw error;
    if (error instanceof FlowError) return { ok: false as const, error: error.key };
    if (isDbTimeout(error)) return { ok: false as const, error: "errors.portalTimeout" };
    return { ok: false as const, error: "errors.generic" };
  }
}

export async function actionInvite(formData: FormData) {
  const back = "/m/team";
  try {
    assertTeamInvitesEnabled();
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
    assertTeamInvitesEnabled();
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
    clearAuthCookies(jar);
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
  const jar = await cookies();
  clearAuthCookies(jar);
  if (session) {
    try {
      await revokeAllSessions(session.userId);
    } catch (error) {
      console.error("sign out", error);
    }
  }
  redirect("/login");
}

function expenseFields(formData: FormData) {
  return {
    propertyId: text(formData.get("propertyId")),
    unitId: text(formData.get("unitId")),
    category: text(formData.get("category")),
    amountText: text(formData.get("amount")),
    incurredOn: text(formData.get("incurredOn")),
    vendorName: text(formData.get("vendorName")),
    description: text(formData.get("note")),
  };
}

export async function actionAddExpense(formData: FormData) {
  try {
    const session = await getSession();
    await addExpense(session, {
      propertyId: text(formData.get("propertyId")),
      description: text(formData.get("description")),
      amountText: text(formData.get("amount")),
      receiptName: text(formData.get("receipt")),
    });
    redirect("/m/statements?saved=1");
  } catch (error) {
    bounce("/m/statements", error);
  }
}

export async function actionCreateExpense(formData: FormData) {
  try {
    const session = await getSession();
    const created = await createExpense(session, expenseFields(formData));
    redirect(`/m/expenses/${created.expenseId}?saved=1`);
  } catch (error) {
    bounce("/m/expenses/new", error);
  }
}

export async function actionUpdateExpense(formData: FormData) {
  const id = text(formData.get("expenseId"));
  try {
    const session = await getSession();
    await updateExpense(session, id, expenseFields(formData));
    redirect(`/m/expenses/${id}?saved=1`);
  } catch (error) {
    bounce(id ? `/m/expenses/${id}` : "/m/expenses", error);
  }
}

export async function actionApproveExpense(formData: FormData) {
  const id = text(formData.get("expenseId"));
  try {
    const session = await getSession();
    await approveExpense(session, id);
    redirect(`/m/expenses/${id}?approved=1`);
  } catch (error) {
    bounce(id ? `/m/expenses/${id}` : "/m/expenses", error);
  }
}

export async function actionVoidExpense(formData: FormData) {
  const id = text(formData.get("expenseId"));
  try {
    const session = await getSession();
    await voidExpense(session, id, text(formData.get("reason")));
    redirect(`/m/expenses/${id}?voided=1`);
  } catch (error) {
    bounce(id ? `/m/expenses/${id}` : "/m/expenses", error);
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

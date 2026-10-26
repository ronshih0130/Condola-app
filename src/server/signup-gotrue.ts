/** GoTrue shapes and the public confirm URL. No database access. */

const CONFIRM_PATH = "/signup/confirm";

/** Hosts this app serves. condola.app is the marketing site, not an app host. */
const APP_HOSTS = ["staging.condola.app", "app.condola.app"] as const;

export function parseSupabaseSignup(
  status: number,
  body: unknown,
): { id: string; confirmed: boolean } | "duplicate" | "unavailable" {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const nested = record.user && typeof record.user === "object" ? (record.user as Record<string, unknown>) : null;
  if (status < 200 || status >= 300) {
    const text = [record.msg, record.error_description, record.message, record.error_code, record.error]
      .filter((part) => typeof part === "string")
      .join(" ")
      .toLowerCase();
    if (status === 422 || status === 400 || /already|registered|exists/.test(text)) return "duplicate";
    return "unavailable";
  }
  // Email confirmation on: GoTrue returns the user at the top level (id, not user.id).
  // Autoconfirm and some client versions nest it under user.
  const nestedId = typeof nested?.id === "string" ? nested.id : "";
  const topId = typeof record.id === "string" ? record.id : "";
  const id = nestedId || topId;
  if (!id) return "unavailable";
  const confirmedAt = nested ? nested.email_confirmed_at : record.email_confirmed_at;
  return { id, confirmed: Boolean(confirmedAt) };
}

/** redirect_to is a query param. The JS client's options.emailRedirectTo is not part of the REST body. */
export function gotrueEndpoint(authBase: string, path: string, redirectTo: string) {
  const base = authBase.replace(/\/$/, "");
  const endpoint = new URL(path, `${base}/`);
  endpoint.searchParams.set("redirect_to", redirectTo);
  return endpoint.toString();
}

function canonicalConfirmOrigin(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || !(APP_HOSTS as readonly string[]).includes(host)) return null;
    return `https://${host}`;
  } catch {
    return null;
  }
}

function loopbackOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:") return null;
    if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Allow-listed site origin. An app host on the request wins. A non-app host
 * (workers.dev, condola.app, anything else) uses CONDOLA_SITE_URL, then
 * CONDOLA_ENV. Loopback is kept only for local dev.
 */
export function publicSiteOrigin(requestOrigin: string) {
  const fromRequest = canonicalConfirmOrigin(requestOrigin);
  if (fromRequest) return fromRequest;
  const fromEnv = canonicalConfirmOrigin(process.env.CONDOLA_SITE_URL || "");
  if (fromEnv) return fromEnv;
  const name = process.env.CONDOLA_ENV?.trim().toLowerCase();
  if (name === "production") return "https://app.condola.app";
  if (name === "staging" || name === "staging-real") return "https://staging.condola.app";
  const local = loopbackOrigin(requestOrigin);
  return local || "http://127.0.0.1:43123";
}

/** Confirmation links land on /signup/confirm of the allow-listed origin. */
export function signupConfirmUrl(requestOrigin: string) {
  return `${publicSiteOrigin(requestOrigin)}${CONFIRM_PATH}`;
}

/** Recovery links land on /reset of the same allow-listed origin. */
export function passwordResetUrl(requestOrigin: string) {
  return `${publicSiteOrigin(requestOrigin)}/reset`;
}

/** Signup confirmation accepts signup and email OTP types. Anything else is ignored. */
export function signupVerifyType(value: string | null | undefined): "signup" | "email" | null {
  const type = (value ?? "").trim().toLowerCase();
  if (type === "email") return "email";
  if (type === "signup" || type === "") return "signup";
  return null;
}

export function gotrueVerifyBody(type: "signup" | "email" | "recovery", tokenHash: string) {
  return { type, token_hash: tokenHash.trim() };
}

/** Unset or "app" sends signup mail from the app. "supabase" restores GoTrue's own mail. */
export function signupMailVia(env?: { SIGNUP_MAIL_VIA?: string }): "app" | "supabase" {
  const value = env ? env.SIGNUP_MAIL_VIA : process.env.SIGNUP_MAIL_VIA;
  return value?.trim().toLowerCase() === "supabase" ? "supabase" : "app";
}

/** Confirm link the signup mail carries. The confirm page already accepts this shape. */
export function signupConfirmLink(requestOrigin: string, hashedToken: string) {
  const url = new URL(signupConfirmUrl(requestOrigin));
  url.searchParams.set("token_hash", hashedToken);
  url.searchParams.set("type", "signup");
  return url.toString();
}

export type SignupGenerateLink =
  | { ok: true; hashedToken: string; userId: string; confirmed: boolean }
  | { ok: false; error: "duplicate" | "weak" | "unavailable" };

function generateLinkErrorText(body: unknown) {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const text = [record.error_code, record.error, record.msg, record.message, record.error_description]
    .filter((part): part is string => typeof part === "string")
    .join(" ")
    .toLowerCase();
  const code = String(record.error_code || record.error || "").toLowerCase();
  return { record, text, code };
}

/**
 * Admin generate_link type=signup.
 * Confirmed address → 422 email_exists. Weak password → 422 weak_password or 400.
 * A 2xx body carries hashed_token and the user id. GoTrue does not send mail.
 */
export function classifySignupGenerateLink(status: number, body: unknown): SignupGenerateLink {
  if (status >= 200 && status < 300) {
    const parsed = parseGenerateLink(body);
    if (!parsed?.hashedToken || !parsed.userId) return { ok: false, error: "unavailable" };
    const { record } = generateLinkErrorText(body);
    const nested = record.user && typeof record.user === "object" ? (record.user as Record<string, unknown>) : null;
    const confirmedAt = nested ? nested.email_confirmed_at : record.email_confirmed_at;
    return { ok: true, hashedToken: parsed.hashedToken, userId: parsed.userId, confirmed: Boolean(confirmedAt) };
  }
  const { text, code } = generateLinkErrorText(body);
  if (
    code === "email_exists" ||
    code === "user_already_exists" ||
    /already been registered|already registered|email_exists|user already exists/.test(text)
  ) {
    return { ok: false, error: "duplicate" };
  }
  const passwordProblem =
    code === "weak_password" ||
    /weak_password|password should be|password is known|signup requires a valid password|password/.test(text);
  if ((status === 422 || status === 400) && passwordProblem) return { ok: false, error: "weak" };
  return { ok: false, error: "unavailable" };
}

/** Admin generate_link does not send mail. hashed_token is the token_hash the confirm page posts. */
export function parseGenerateLink(body: unknown): { hashedToken: string; userId: string } | null {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const hashed = typeof record.hashed_token === "string" ? record.hashed_token.trim() : "";
  if (!hashed) return null;
  const nested = record.user && typeof record.user === "object" ? (record.user as Record<string, unknown>) : null;
  const userId =
    (typeof record.id === "string" && record.id) || (typeof nested?.id === "string" && nested.id) || "";
  return { hashedToken: hashed, userId };
}

/** User id from a GoTrue verify response. Nested user.id and a top-level id both count. */
export function parseGotrueUserId(body: unknown): { id: string; email: string } | null {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const nested = record.user && typeof record.user === "object" ? (record.user as Record<string, unknown>) : null;
  const id = (typeof nested?.id === "string" && nested.id) || (typeof record.id === "string" && record.id) || "";
  if (!id) return null;
  const email =
    (typeof nested?.email === "string" && nested.email) || (typeof record.email === "string" && record.email) || "";
  return { id, email };
}

/**
 * Password grant failures. Only a real bad-credential response is "invalid".
 * email_not_confirmed is separate. Other GoTrue errors must not look like a wrong password.
 */
export function classifyPasswordGrant(
  status: number,
  body: unknown,
): { userId: string } | "unconfirmed" | "invalid" | "unavailable" {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (status >= 200 && status < 300) {
    const user = parseGotrueUserId(body);
    return user ? { userId: user.id } : "unavailable";
  }
  const text = [record.error_code, record.error, record.msg, record.message, record.error_description]
    .filter((part) => typeof part === "string")
    .join(" ")
    .toLowerCase();
  if (text.includes("email_not_confirmed") || text.includes("email not confirmed")) return "unconfirmed";
  if (
    text.includes("invalid_grant") ||
    text.includes("invalid_credentials") ||
    text.includes("invalid login") ||
    text.includes("invalid credentials")
  ) {
    return "invalid";
  }
  return "unavailable";
}

/** Where to send a hash access_token that landed on the wrong page. Null when this page should consume it. */
export function confirmHashTarget(pathname: string, hash: string): string | null {
  const fragment = hash.startsWith("#") ? hash : hash ? `#${hash}` : "";
  const access = new URLSearchParams(fragment.replace(/^#/, "")).get("access_token");
  if (!access) return null;
  if (pathname === CONFIRM_PATH) return null;
  return `${CONFIRM_PATH}${fragment}`;
}

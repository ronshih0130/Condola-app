/** GoTrue shapes and the public confirm URL. No database access. */

const CONFIRM_PATH = "/signup/confirm";

/** Hosts Supabase is allowed to send a confirmation link back to. */
const CONFIRM_HOSTS = ["staging.condola.app", "app.condola.app", "condola.app"] as const;

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
    if (url.protocol !== "https:" || !(CONFIRM_HOSTS as readonly string[]).includes(host)) return null;
    // Production mail uses the allow-listed app host. condola.app serves the same app.
    if (host === "condola.app" || host === "app.condola.app") return "https://app.condola.app";
    return "https://staging.condola.app";
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
 * Confirmation links must land on an allow-listed URL:
 * https://staging.condola.app/signup/confirm or https://app.condola.app/signup/confirm.
 * A public request origin wins. Otherwise CONDOLA_SITE_URL, then CONDOLA_ENV.
 */
export function signupConfirmUrl(requestOrigin: string) {
  const fromRequest = canonicalConfirmOrigin(requestOrigin);
  if (fromRequest) return `${fromRequest}${CONFIRM_PATH}`;
  const fromEnv = canonicalConfirmOrigin(process.env.CONDOLA_SITE_URL || "");
  if (fromEnv) return `${fromEnv}${CONFIRM_PATH}`;
  const name = process.env.CONDOLA_ENV?.trim().toLowerCase();
  if (name === "production") return `https://app.condola.app${CONFIRM_PATH}`;
  if (name === "staging" || name === "staging-real") return `https://staging.condola.app${CONFIRM_PATH}`;
  const local = loopbackOrigin(requestOrigin);
  return `${local || "http://127.0.0.1:43123"}${CONFIRM_PATH}`;
}

/** Where to send a hash access_token that landed on the wrong page. Null when this page should consume it. */
export function confirmHashTarget(pathname: string, hash: string): string | null {
  const fragment = hash.startsWith("#") ? hash : hash ? `#${hash}` : "";
  const access = new URLSearchParams(fragment.replace(/^#/, "")).get("access_token");
  if (!access) return null;
  if (pathname === CONFIRM_PATH) return null;
  return `${CONFIRM_PATH}${fragment}`;
}

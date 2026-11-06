/** Hosts that serve the production app. condola.app is the app until a marketing site exists. */
export const PRODUCTION_HOSTS = ["app.condola.app", "condola.app"] as const;

export function isProductionEnv() {
  return process.env.CONDOLA_ENV?.trim().toLowerCase() === "production";
}

export function isProductionAppHost(host: string | null | undefined) {
  const name = host?.split(",")[0]?.trim().split(":")[0]?.toLowerCase() ?? "";
  return (PRODUCTION_HOSTS as readonly string[]).includes(name);
}

/**
 * Accept a same-app path, or an absolute https URL on a production host.
 * Anything else becomes an empty string so redirects stay on this app.
 */
export function sameAppPath(value: string | null | undefined) {
  const raw = (value ?? "").trim();
  // Browsers normalize backslashes to slashes in navigation URLs. Reject them
  // and embedded control characters before accepting a relative return path.
  if (raw.includes("\\") || Array.from(raw).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return "";
  if (raw.startsWith("/") && !raw.startsWith("//")) return raw;
  try {
    const url = new URL(raw);
    if (url.protocol === "https:" && isProductionAppHost(url.hostname) && !url.pathname.startsWith("//")) {
      return `${url.pathname}${url.search}`;
    }
  } catch {
    return "";
  }
  return "";
}

/** Shared by app.condola.app and condola.app. Unset outside production. */
export function productionCookieDomain() {
  return isProductionEnv() ? ".condola.app" : undefined;
}

type CookieExtra = { httpOnly?: boolean; path?: string; maxAge?: number };

export function appCookieOptions(extra: { httpOnly?: boolean; path?: string; maxAge: number }): {
  httpOnly: boolean;
  sameSite: "lax";
  secure: boolean;
  path: string;
  domain?: string;
  maxAge: number;
};
export function appCookieOptions(extra?: { httpOnly?: boolean; path?: string }): {
  httpOnly: boolean;
  sameSite: "lax";
  secure: boolean;
  path: string;
  domain?: string;
};
export function appCookieOptions(extra?: CookieExtra) {
  const domain = productionCookieDomain();
  const options = {
    httpOnly: extra?.httpOnly ?? true,
    sameSite: "lax" as const,
    secure: isProductionEnv() || process.env.NODE_ENV === "production",
    path: extra?.path ?? "/",
    ...(domain ? { domain } : {}),
  };
  if (extra?.maxAge == null) return options;
  return { ...options, maxAge: extra.maxAge };
}

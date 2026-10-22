import { appCookieOptions } from "./public-origin";

export const CLEARED_COOKIES = [
  "condola_session",
  "condola_challenge",
  "condola_env",
  "condola_org",
  "condola_tenant_focus",
  "condola_backup",
  "condola_portal_role",
];

/** Host-only cookies from before Domain=.condola.app, plus every domain this app has set. */
const COOKIE_DOMAINS = [undefined, ".condola.app", "condola.app", "app.condola.app", "staging.condola.app"] as const;

export function expiredNamedCookies(names: string[]) {
  const lines: string[] = [];
  for (const name of names) {
    for (const domain of COOKIE_DOMAINS) {
      for (const secure of [false, true]) {
        for (const httpOnly of [false, true]) {
          const parts = [`${name}=`, "Path=/", "Max-Age=0", "Expires=Thu, 01 Jan 1970 00:00:00 GMT", "SameSite=Lax"];
          if (httpOnly) parts.push("HttpOnly");
          if (domain) parts.push(`Domain=${domain}`);
          if (secure) parts.push("Secure");
          lines.push(parts.join("; "));
        }
      }
    }
  }
  return lines;
}

/** Sign-in must drop every condola_env, including a host-only sandbox cookie the jar cannot expire. */
export function expiredEnvChoiceCookies() {
  return expiredNamedCookies(["condola_env"]);
}

export function sessionEntryPath(next: string) {
  const safe = next.startsWith("/") && !next.startsWith("//") ? next : "/auth/continue";
  return `/api/auth/enter?next=${encodeURIComponent(safe)}`;
}

export function expiredAuthCookies(extraNames: string[] = []) {
  const names = [
    ...CLEARED_COOKIES,
    ...extraNames.filter((name) => name.startsWith("sb-") && !CLEARED_COOKIES.includes(name)),
  ];
  return expiredNamedCookies(names);
}

type CookieSetter = {
  getAll: () => { name: string }[];
  set: (
    name: string,
    value: string,
    options: {
      httpOnly?: boolean;
      path?: string;
      maxAge?: number;
      expires?: Date;
      secure?: boolean;
      sameSite?: "lax";
      domain?: string;
    },
  ) => void;
};

/** Drop the cookies this app sets. The sign-out route also expires every domain variant. */
export function clearAuthCookies(jar: CookieSetter) {
  const extras = jar.getAll().map((cookie) => cookie.name).filter((name) => name.startsWith("sb-"));
  for (const name of [...CLEARED_COOKIES, ...extras]) {
    try {
      jar.set(name, "", { ...appCookieOptions({ maxAge: 0 }), expires: new Date(0) });
    } catch (error) {
      console.error("clear cookie", name, error);
    }
  }
}

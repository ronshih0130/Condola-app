import { UNIT_QR_COOKIE } from "./unit-qr-signup";

export const UNIT_QR_COOKIE_PATH = "/signup";
type CookieWriter = { set(name: string, value: string, options: { path: string; maxAge?: number; httpOnly: boolean; sameSite: "lax" }): unknown };
export function clearUnitQrCookie(jar: CookieWriter) {
  jar.set(UNIT_QR_COOKIE, "", { path: UNIT_QR_COOKIE_PATH, maxAge: 0, httpOnly: true, sameSite: "lax" });
}

/** A session tombstone has no bearer lifetime: only abandon/rescan clears it. */
export function invalidateUnitQrCookie(jar: CookieWriter) {
  jar.set(UNIT_QR_COOKIE, "invalid", { path: UNIT_QR_COOKIE_PATH, httpOnly: true, sameSite: "lax" });
}

import { appCookieOptions } from "./public-origin";

export const RESET_FLASH_COOKIE = "condola_reset_flash";

/** Long enough to render the confirmation, then the page clears it. */
const MAX_AGE_SECONDS = 60;

/** The address is not part of the URL, so it stays out of history and access logs. */
export function forgotSentLocation() {
  return "/forgot";
}

export function resetFlashCookie(email: string) {
  return {
    name: RESET_FLASH_COOKIE,
    value: email.trim(),
    options: appCookieOptions({ path: "/forgot", maxAge: MAX_AGE_SECONDS }),
  };
}

/** Showing the address is one-time. The cookie is cleared immediately after. */
export function resetFlashDisplay(value: string | undefined) {
  return { email: (value ?? "").trim(), clearCookie: true as const };
}

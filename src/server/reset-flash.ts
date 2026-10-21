import { appCookieOptions } from "./public-origin";

export const RESET_FLASH_COOKIE = "condola_reset_flash";

/** Long enough to render the confirmation, then the page clears it. */
const MAX_AGE_SECONDS = 60;

/** The address is not part of the URL, so it stays out of history and access logs. */
export function forgotSentLocation() {
  return "/forgot";
}

/** The confirmation does not include the address, so the cookie is only a flag. */
export function resetFlashCookie() {
  return {
    name: RESET_FLASH_COOKIE,
    value: "1",
    options: appCookieOptions({ path: "/forgot", maxAge: MAX_AGE_SECONDS }),
  };
}

/** Any non-empty value shows the same sentence. The cookie is cleared immediately after. */
export function resetFlashDisplay(value: string | undefined) {
  return { sent: (value ?? "").trim().length > 0, clearCookie: true as const };
}

import type { Locale } from "./index";

/** Neutral response for every unauthenticated resend outcome. */
export function signupResendAcknowledgementText(locale: Locale): string {
  return locale === "en"
    ? "If your signup still needs confirmation, check your inbox and spam folder for a confirmation email."
    : "如果您的註冊尚待確認，請查看收件匣與垃圾郵件中的確認信。";
}

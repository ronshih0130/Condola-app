/** Approved in-app support channel. It is not a LINE product feature. */
export const LINE_SUPPORT_CONTACT = "LINE @644odqoe（租多啦官方客服帳號）";

/** True when text mentions LINE other than the support contact. */
export function footerHasProductLine(text: string) {
  return text.split(LINE_SUPPORT_CONTACT).join("").includes("LINE");
}

/**
 * Live app footers keep the support contact and drop LINE product copy
 * (login, push, LINE ID binding, official-account invites).
 * Sandbox and DEMO_MODE keep the original sentence.
 */
export function appFooterText(text: string, demoLine: boolean) {
  if (demoLine || !text.includes("LINE")) return text;
  const chunks = text.split(LINE_SUPPORT_CONTACT);
  const cleaned = chunks.map((chunk) =>
    chunk
      .split(/(?<=[。！？.!?])/)
      .filter((sentence) => !sentence.includes("LINE"))
      .join(""),
  );
  return cleaned
    .join(LINE_SUPPORT_CONTACT)
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Walk steps that mention LINE, and the new-lease LINE ID field.
 * `lineLoginEnabled()` is off in production, including the sample company.
 */
export function visibleWalkSteps(steps: readonly string[], lineOn: boolean) {
  return steps.filter((step) => lineOn || !step.includes("LINE"));
}

/** The LINE ID label, and the invalid-id message, only when that field is shown. */
export function leaseLineCopy(t: (key: string) => string, showLine: boolean, error = "") {
  return {
    field: showLine ? t("lease_line_id") : "",
    invalid: error === "errors.lineId" ? (showLine ? t("lease_line_invalid") : t("i_generic")) : "",
  };
}

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

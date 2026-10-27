import privacy from "../../content/legal/privacy.md";
import agreementZh from "../../content/partner/partner-agreement.zh-TW.md";
import agreementEn from "../../content/partner/partner-agreement.en.md";

/** Static imports are shared by integrity verification and the public document route. */
const bundled: Record<string, string> = {
  "content/legal/privacy.md": privacy,
  "content/partner/partner-agreement.zh-TW.md": agreementZh,
  "content/partner/partner-agreement.en.md": agreementEn,
};

export function partnerBundledText(source: string): string {
  const text = bundled[source];
  if (typeof text !== "string") throw new Error("partner document not bundled");
  return text;
}

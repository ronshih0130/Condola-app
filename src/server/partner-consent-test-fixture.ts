import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { partnerDocumentConfig } from "./partner-consent-rules";
import type { PartnerRuntime } from "./partner-consent";

/** Privacy fixtures deliberately do not depend on the independent privacy lane. */
export function partnerTestRuntime(
  privacyText = "# Privacy\n\n- 版本：v2\n- 生效日期：2026-10-27\n",
  privacyVersion = "2026-10-27",
): PartnerRuntime {
  const config = structuredClone(partnerDocumentConfig);
  return {
    config,
    privacyVersion,
    text: (entry) => entry.source === config.documents.privacy[0].source
      ? privacyText : readFileSync(resolve(entry.source), "utf8"),
    report: () => {},
  };
}

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { partnerDocumentConfig } from "./partner-consent-rules";
import type { PartnerRuntime } from "./partner-consent";

/** Exercise active flows before the independent privacy-copy lane merges. */
export function partnerTestRuntime(): PartnerRuntime {
  const config = structuredClone(partnerDocumentConfig);
  const privacy = config.documents.privacy[0];
  const text = `# Privacy\n\n- 版本：${privacy.version}\n- 生效日期：${privacy.effective_date}\n`;
  privacy.sha256 = createHash("sha256").update(text).digest("hex");
  return {
    config,
    text: (entry) => entry.source === privacy.source ? text : readFileSync(resolve(entry.source), "utf8"),
    report: () => {},
  };
}

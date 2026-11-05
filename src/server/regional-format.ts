import type { LocalizationContext } from "./localization";
import type { ExportExplanation } from "./regional-format-helpers";
import { requireOrgScope } from "./org-guard";
import type { Session } from "./types";

export type RegionalFormatContext =
  | { enabled: false }
  | { enabled: true; context: LocalizationContext; explain: ExportExplanation };

/** Build-only inert context; validate org scope before returning always OFF. */
export function getRegionalFormatContext(session: Session): RegionalFormatContext {
  requireOrgScope(session);
  return { enabled: false };
}

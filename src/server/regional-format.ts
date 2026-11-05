import { requireOrgScope } from "./org-guard";
import type { Session } from "./types";

export type RegionalFormatContext = { enabled: false };

/** Build-only inert context; validate org scope before returning always OFF. */
export function getRegionalFormatContext(session: Session): RegionalFormatContext {
  requireOrgScope(session);
  return { enabled: false };
}

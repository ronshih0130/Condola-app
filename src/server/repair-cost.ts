import { requireOrgScope } from "./org-guard";
import type { Session } from "./types";

export type RepairCostFoundationStatus = { enabled: false };

/** Build-only inert status; validate org scope before returning always OFF. */
export function getRepairCostFoundationStatus(session: Session): RepairCostFoundationStatus {
  requireOrgScope(session);
  return { enabled: false };
}

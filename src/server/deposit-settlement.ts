import { requireOrgScope } from "./org-guard";
import type { Session } from "./types";

export type DepositSettlementStatus = { enabled: false };

/** Build-only inert status. Writers/UI land in B-011. Always enabled:false. */
export function getDepositSettlementStatus(session: Session): DepositSettlementStatus {
  requireOrgScope(session); // fail-closed on bad org/env
  return { enabled: false };
}

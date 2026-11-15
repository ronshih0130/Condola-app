import { randomUUID } from "node:crypto";
import { guardEffectiveSession } from "./b017-custom-role-governance";
import { ownerHistory, ownerPending, repairApprovalsEnabled } from "./repair-approval";
import { approvalAmount } from "./repair-approval-rules";
import { displaySampleName } from "./sandbox-data";
import type { Session } from "./types";
import type { OwnerHomeState } from "../components/v3/owner/home";

/** Preserve bigint precision and the estimate's own currency/scale, not a fixed cents assumption. */
export function ownerEstimateAmount(amount: string, currency: string, scale: number) {
  const exact = approvalAmount(amount, currency.trim(), scale).split(" ")[1];
  const [whole, fraction] = exact.split(".");
  const value = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fraction && /[1-9]/.test(fraction) ? "." + fraction : "");
  return (currency.trim() === "TWD" ? "NT$" : currency.trim() + " ") + value;
}

export async function ownerHomeEstimates(input: Session): Promise<OwnerHomeState> {
  // B-017: the same effective-session guard the owner pages use, before any read.
  const session = await guardEffectiveSession(input, null);
  try {
    if (!(await repairApprovalsEnabled(session.orgId))) return { status: "ready", rows: [] };
    const pending = await ownerPending(session, { homeDetails: true });
    const rows = await Promise.all(pending.map(async row => {
      if (typeof row.property_name !== "string" || typeof row.item !== "string") throw new Error("Estimate details unavailable");
      const emergency = row.has_emergency
        ? (await ownerHistory(session, { ticketId: row.ticket_id })).find(history => history.version_id === row.version_id) ?? null : null;
      // Never silently lose emergency information in the new decision surface.
      if (row.has_emergency && !emergency?.emergency_category) throw new Error("Emergency details unavailable");
      return {
        ticketId: row.ticket_id, versionId: row.version_id, version: row.version_no, requestId: randomUUID(),
        property: displaySampleName(row.property_name), item: row.item,
        amount: ownerEstimateAmount(row.amount_minor, row.currency, row.minor_unit), vendor: row.vendor_name,
        scope: row.work_scope, managementExplanation: row.management_explanation ?? null, emergency,
      };
    }));
    return { status: "ready", rows };
  } catch { return { status: "error" }; }
}

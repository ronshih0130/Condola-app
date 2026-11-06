import React from "react";
import { VendorEstimatePanel } from "./vendor-estimate-panel";
import { repairApprovalCopy } from "@/i18n/repair-approval";
import { managerApprovalView, repairApprovalPanelPolicy } from "@/server/repair-approval";
import type { Session } from "@/server/types";

export async function ApprovalPanel({ session, ticketId }: { session: Session; ticketId: string }) {
  const policy = await repairApprovalPanelPolicy(session.orgId, true);
  if (!policy.approvals) return null;
  if (session.kind !== "staff" || session.role === null || !["admin", "manager"].includes(session.role)) return null;
  const rows = await managerApprovalView(session, { ticketId });
  const ApprovalHistoryCards = rows.length
    ? (await import("@/app/o/approvals/approval-cards")).ApprovalHistoryCards : null;
  return <>
    <VendorEstimatePanel session={session} ticketId={ticketId} enabled={policy.estimates} />
    {ApprovalHistoryCards && <section>
    <h2>{repairApprovalCopy(session.locale).title}</h2>
    <ApprovalHistoryCards rows={rows} locale={session.locale} />
  </section>}
  </>;
}

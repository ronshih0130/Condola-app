import { repairApprovalCopy } from "@/i18n/repair-approval";
import { managerApprovalView, repairApprovalsEnabled } from "@/server/repair-approval";
import type { Session } from "@/server/types";
import { ApprovalHistoryCards } from "@/app/o/approvals/approval-cards";

export async function ApprovalPanel({ session, ticketId }: { session: Session; ticketId: string }) {
  if (!(await repairApprovalsEnabled(session.orgId))) return null;
  if (session.kind !== "staff" || session.role === null || !["admin", "manager"].includes(session.role)) return null;
  const rows = await managerApprovalView(session, { ticketId });
  if (!rows.length) return null;
  return <section>
    <h2>{repairApprovalCopy(session.locale).title}</h2>
    <ApprovalHistoryCards rows={rows} locale={session.locale} />
  </section>;
}

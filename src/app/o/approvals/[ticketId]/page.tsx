import { Suspense } from "react";
import { DecidedLoading } from "@/components/v3/o/decided/decided";
import { DecidedTicketPage } from "@/components/v3/o/decided/page";
import { brandV3EnabledForOrg } from "@/server/brand-v3";
import { requireCurrentConsent } from "@/server/consent-gate";
import { makeT } from "@/i18n";
import { brandV2EnabledForOrg } from "@/server/brand-v2";
import { getSession } from "@/server/session";
import { ownerHistory, ownerPending, repairApprovalsEnabled } from "@/server/repair-approval";
import { isUuid } from "@/server/repair-rules";
import { notFound, redirect } from "next/navigation";
import { ApprovalHistoryCards } from "../approval-cards";

export const dynamic = "force-dynamic";

export default async function ApprovalHistoryPage({ params }: {
  params: Promise<{ ticketId: string }>;
}) {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  const v2 = await brandV2EnabledForOrg(session.orgId);
  const t = makeT(session.locale);
  if (!(await repairApprovalsEnabled(session.orgId))) {
  return (
    <div data-v2-page={v2 ? "o-approvals" : undefined}>
      <h2>{t("i_approvals")}</h2>
      <p>{t("i_no_approvals")}</p>
    </div>
  );
  }
  const { ticketId } = await params;
  if (!isUuid(ticketId)) notFound();
  if (await brandV3EnabledForOrg(session.orgId)) {
    const pending = await ownerPending(session);
    if (pending.some(row => row.ticket_id === ticketId)) redirect(`/o?estimate=${encodeURIComponent(ticketId)}`);
    // B-093 / OWN-35-AC2 (OQ-055): under brand_v3 a decided ticket opens the RO-DECIDED read-only view.
    return <Suspense fallback={<DecidedLoading locale={session.locale} detail />}>
      <DecidedTicketPage session={session} ticketId={ticketId} />
    </Suspense>;
  }
  const rows = await ownerHistory(session, { ticketId });
  return (
    <div data-v2-page={v2 ? "o-approvals" : undefined}>
      <h2>{t("i_approvals")}</h2>
      <ApprovalHistoryCards rows={rows} locale={session.locale} />
    </div>
  );
}

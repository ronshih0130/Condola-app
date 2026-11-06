import { requireCurrentConsent } from "@/server/consent-gate";
import { makeT } from "@/i18n";
import { brandV2EnabledForOrg } from "@/server/brand-v2";
import { getSession } from "@/server/session";
import { ownerHistory, ownerPending, repairApprovalsEnabled } from "@/server/repair-approval";
import { ApprovalCards } from "./approval-cards";

export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
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
  const pending = await ownerPending(session);
  const rows = await Promise.all(pending.map(async row => ({
    ...row,
    emergency: row.has_emergency
      ? (await ownerHistory(session, { ticketId: row.ticket_id })).find(v => v.version_id === row.version_id) ?? null
      : null,
  })));
  return (
    <div data-v2-page={v2 ? "o-approvals" : undefined}>
      <h2>{t("i_approvals")}</h2>
      {rows.length ? <ApprovalCards rows={rows} locale={session.locale} /> : <p>{t("i_no_approvals")}</p>}
    </div>
  );
}

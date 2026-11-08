import { requireCurrentConsent } from "@/server/consent-gate";
import Link from "next/link";
import { notFound } from "next/navigation";
import { makeT } from "@/i18n";
import { PdfDownloadButton } from "@/components/pdf-download-button";
import { StatementDocument } from "@/components/statement-document";
import { PageHeader } from "@/components/ui";
import { brandV2EnabledForOrg } from "@/server/brand-v2";
import { statementDetail } from "@/server/queries";
import { getSession } from "@/server/session";
import { OwnerNetLedgerPanel } from "@/components/owner-net-ledger-panel";
import { ownerNetLedgerView } from "@/server/owner-net-ledger";
import { ledgerPanelView } from "@/server/owner-net-ledger-presentation";
import { OwnerReportReplies } from "@/components/owner-report-replies";
import { ownerTransferHistory, reportRepliesView } from "@/server/owner-finance-replies";
import { repliesPanelView } from "@/server/owner-finance-replies-presentation";

export const dynamic = "force-dynamic";

export default async function StatementPage({ params }: { params: Promise<{ id: string }> }) {
  await requireCurrentConsent(undefined, "page");
  const { id } = await params;
  const session = await getSession();
  const v2 = await brandV2EnabledForOrg(session.orgId);
  const t = makeT(session.locale);
  const detail = await statementDetail(session, id);
  if (!detail) notFound();
  const row = detail.statement;
  const ledger = await ownerNetLedgerView(session, id);
  const [transfers, replies] = await Promise.all([ownerTransferHistory(session, id), reportRepliesView(session, id)]);
  const versionNumbers = new Map((ledger?.versions ?? []).map((v) => [v.id, v.version_no]));
  return (
    <>
      <PageHeader
        title={row.owner_name}
        crumb={<Link href="/m/statements">{t("i_nav_stmt")}</Link>}
        actions={
          <PdfDownloadButton
            href={`/api/pdf/statements/${id}`}
            label={t("s_874a842")}
            failed={t("pdf_failed")}
            fontFailed={t("pdf_font_missing")}
            testId="download-statement-pdf"
          />
        }
      />
      <p className="muted">
        {row.period_start} – {row.period_end}
      </p>
      <StatementDocument
        {...(v2 ? { v2: true } : {})}
        t={t}
        locale={session.locale}
        row={row}
        lines={detail.lines}
        note={
          <>
            <p className="small">{t("i_actor")}</p>
            <p className="small muted">{t("i_einvoice")}</p>
          </>
        }
      />
      {ledger && <OwnerNetLedgerPanel view={ledgerPanelView(ledger, { statementId: id, locale: session.locale })} locale={session.locale} negativeLabel={t("owner_owes")} />}
      {(transfers || replies) && <OwnerReportReplies view={repliesPanelView({ statementId: id, locale: session.locale, transfers, replies, versionNumbers, displayedVersionId: ledger ? ledger.latest?.id ?? null : undefined })} locale={session.locale} />}
    </>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { makeT } from "@/i18n";
import { PdfDownloadButton } from "@/components/pdf-download-button";
import { StatementDocument } from "@/components/statement-document";
import { PageHeader } from "@/components/ui";
import { formatMailMonth } from "@/server/mail-copy";
import { statementDetail } from "@/server/queries";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function StatementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  const t = makeT(session.locale);
  const detail = await statementDetail(session, id);
  if (!detail) notFound();
  const row = detail.statement;
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
      <p className="muted">{formatMailMonth(row.period_start)}</p>
      <StatementDocument
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
    </>
  );
}

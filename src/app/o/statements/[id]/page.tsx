import Link from "next/link";
import { notFound } from "next/navigation";
import { makeT } from "@/i18n";
import { PdfDownloadButton } from "@/components/pdf-download-button";
import { StatementDocument } from "@/components/statement-document";
import { ownerPrivacy, tenantDisplayNames } from "@/server/auth";
import { maskTenantNames } from "@/server/privacy";
import { statementDetail } from "@/server/queries";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function OwnerStatementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  const t = makeT(session.locale);
  const detail = await statementDetail(session, id);
  if (!detail) notFound();
  const privacy = await ownerPrivacy(session.orgId);
  const hidden = t("i_tenant_hidden");
  const names = privacy.showName ? [] : await tenantDisplayNames(session.orgId);
  const lines = detail.lines.map((line) => ({
    ...line,
    description: line.description && !privacy.showName ? maskTenantNames(line.description, names, hidden) : line.description,
  }));
  const row = detail.statement;
  return (
    <div>
      <p>
        <Link href="/o/statements">{t("i_back_list")}</Link>
      </p>
      <h2>{row.period_start.slice(0, 7)}</h2>
      <p>
        <PdfDownloadButton
          href={`/api/pdf/statements/${id}`}
          label={t("s_874a842")}
          failed={t("pdf_failed")}
          fontFailed={t("pdf_font_missing")}
          testId="download-statement-pdf"
        />
      </p>
      <StatementDocument
        t={t}
        locale={session.locale}
        row={row}
        lines={lines}
        note={<p className="small">{t("i_actor")}</p>}
      />
    </div>
  );
}
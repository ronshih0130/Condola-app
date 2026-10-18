import Link from "next/link";
import { notFound } from "next/navigation";
import { makeT } from "@/i18n";
import { StatementDocument } from "@/components/statement-document";
import { PageHeader } from "@/components/ui";
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
      <PageHeader title={row.owner_name} crumb={<Link href="/m/statements">{t("i_nav_stmt")}</Link>} />
      <p className="muted">
        {row.period_start} – {row.period_end}
      </p>
      <StatementDocument
        t={t}
        locale={session.locale}
        row={row}
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

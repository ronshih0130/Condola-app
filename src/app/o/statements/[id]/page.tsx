import Link from "next/link";
import { notFound } from "next/navigation";
import { makeT } from "@/i18n";
import { StatementDocument } from "@/components/statement-document";
import { statementDetail } from "@/server/queries";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function OwnerStatementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  const t = makeT(session.locale);
  const detail = await statementDetail(session, id);
  if (!detail) notFound();
  const row = detail.statement;
  return (
    <div>
      <p>
        <Link href="/o/statements">{t("i_back_list")}</Link>
      </p>
      <h2>{row.period_start.slice(0, 7)}</h2>
      <StatementDocument
        t={t}
        locale={session.locale}
        row={row}
        note={<p className="small">{t("i_actor")}</p>}
      />
    </div>
  );
}
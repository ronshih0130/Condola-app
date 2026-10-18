import Link from "next/link";
import { makeT } from "@/i18n";
import { StatementForm } from "@/components/dialogs";
import { ErrorBanner, PageHeader } from "@/components/ui";
import { formatMoney } from "@/server/format";
import { taipeiToday } from "@/server/money";
import { listOwners, listStatements } from "@/server/queries";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function StatementsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const session = await getSession();
  const t = makeT(session.locale);
  const params = await searchParams;
  const [owners, statements] = await Promise.all([listOwners(session), listStatements(session)]);
  return (
    <>
      <PageHeader title={t("s_423eca6")} />
      <ErrorBanner t={t} error={params.error} />
      <StatementForm
        owners={owners}
        existing={statements.map((row) => ({ ownerId: row.owner_id, month: row.period_start }))}
        month={taipeiToday().slice(0, 7)}
      />
      <div className="card" style={{ marginTop: 16 }}>
        <div className="hd">
          <h3>{t("i_statement_list")}</h3>
        </div>
        {statements.length === 0 ? (
          <div className="empty">{t("i_statement_empty")}</div>
        ) : (
          <table className="t">
            <tbody>
              {statements.map((row) => (
                <tr key={row.id}>
                  <td>{row.owner_name}</td>
                  <td>{row.period_start.slice(0, 7)}</td>
                  <td className="num">{formatMoney(Number(row.rent), row.currency, session.locale)}</td>
                  <td>
                    <Link href={`/m/statements/${row.id}`}>{t("i_view")}</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

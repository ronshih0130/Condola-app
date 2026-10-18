import Link from "next/link";
import { notFound } from "next/navigation";
import { makeT } from "@/i18n";
import { PageHeader } from "@/components/ui";
import { formatMoney } from "@/server/format";
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
  const money = (minor: string) => formatMoney(Number(minor), row.currency, session.locale);
  const lines = [
    ["i_opening", row.opening, ""],
    ["i_rent_received", row.rent, "statement-rent"],
    ["i_other_income", row.other, ""],
    ["i_fee", row.fee, "statement-fee"],
    ["i_expenses", row.expenses, ""],
    ["i_payouts", row.payouts, ""],
    ["i_closing", row.closing, "statement-closing"],
  ] as const;
  return (
    <>
      <PageHeader title={row.owner_name} crumb={<Link href="/m/statements">{t("i_nav_stmt")}</Link>} />
      <p className="muted">
        {row.period_start} – {row.period_end}
      </p>
      <div className="card" style={{ maxWidth: 640 }}>
        <table className="t">
          <tbody>
            {lines.map(([key, amount, testid]) => (
              <tr key={key}>
                <td>{t(key)}</td>
                <td className="num" data-testid={testid || undefined}>
                  {money(amount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="bd">
          <p className="small">{t("i_actor")}</p>
          <p className="small muted">{t("i_einvoice")}</p>
        </div>
      </div>
    </>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { makeT } from "@/i18n";
import { formatMoney } from "@/server/format";
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
  const money = (minor: string) => formatMoney(Number(minor), row.currency, session.locale);
  return (
    <div>
      <p>
        <Link href="/o/statements">{t("i_back_list")}</Link>
      </p>
      <h2>{row.period_start.slice(0, 7)}</h2>
      <p data-testid="statement-rent">
        {t("i_rent_received")} {money(row.rent)}
      </p>
      <p data-testid="statement-fee">
        {t("i_fee")} {money(row.fee)}
      </p>
      <p>
        {t("i_closing")} {money(row.closing)}
      </p>
      <p className="small">{t("i_actor")}</p>
    </div>
  );
}

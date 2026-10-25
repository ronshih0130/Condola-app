import Link from "next/link";
import { makeT } from "@/i18n";
import { moneyLabel, ownerSettlement, signedMoneyLabel, statementPeriodNet } from "@/server/format";
import { listStatements } from "@/server/queries";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function OwnerStatementsPage() {
  const session = await getSession();
  const t = makeT(session.locale);
  const rows = await listStatements(session);
  return (
    <div>
      <h2>{t("i_owner_nav_stmt")}</h2>
      {rows.length === 0 ? (
        <p>{t("i_statement_empty")}</p>
      ) : (
        rows.map((row) => {
          const figures = ownerSettlement({
            opening: Number(row.opening),
            rent: Number(row.rent),
            other: Number(row.other),
            fee: Number(row.fee),
            expenses: Number(row.expenses),
            payouts: Number(row.payouts),
            closing: Number(row.closing),
          });
          const periodNet = statementPeriodNet(figures);
          const amount = periodNet < 0
            ? signedMoneyLabel(periodNet, row.currency, session.locale)
            : moneyLabel(periodNet, row.currency, session.locale);
          return (
            <p key={row.id}>
              <Link href={`/o/statements/${row.id}`}>
                {row.period_start.slice(0, 7)} ·{" "}
                {periodNet < 0 ? (
                  <span className="chip warn" data-testid="owner-owes">
                    {t("owner_owes")} {amount}
                  </span>
                ) : (
                  amount
                )}
              </Link>
            </p>
          );
        })
      )}
    </div>
  );
}

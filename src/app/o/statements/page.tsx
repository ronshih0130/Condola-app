import Link from "next/link";
import { makeT } from "@/i18n";
import { moneyLabel, ownerSettlement } from "@/server/format";
import { formatMailMonth } from "@/server/mail-copy";
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
          const amount = moneyLabel(figures.owes > 0 ? figures.owes : Math.max(0, figures.payable), row.currency, session.locale);
          return (
            <p key={row.id}>
              <Link href={`/o/statements/${row.id}`}>
                {formatMailMonth(row.period_start)} ·{" "}
                {figures.owes > 0 ? (
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

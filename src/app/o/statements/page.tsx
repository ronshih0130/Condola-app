import Link from "next/link";
import { makeT } from "@/i18n";
import { formatMoney } from "@/server/format";
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
        rows.map((row) => (
          <p key={row.id}>
            <Link href={`/o/statements/${row.id}`}>
              {row.period_start.slice(0, 7)} · {formatMoney(Number(row.closing), row.currency, session.locale)}
            </Link>
          </p>
        ))
      )}
    </div>
  );
}

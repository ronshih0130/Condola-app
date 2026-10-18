import Link from "next/link";
import { makeT } from "@/i18n";
import { StatementForm } from "@/components/dialogs";
import { Cell, RfTable } from "@/components/rf";
import { ErrorBanner, PageHeader } from "@/components/ui";
import { actionStatement } from "@/server/actions";
import { moneyLabel, ownerSettlement } from "@/server/format";
import { taipeiToday } from "@/server/money";
import { listOwners, listStatements, statementRoster } from "@/server/queries";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function StatementsPage({ searchParams }: { searchParams: Promise<{ error?: string; month?: string }> }) {
  const session = await getSession();
  const t = makeT(session.locale);
  const params = await searchParams;
  const month = params.month && /^\d{4}-\d{2}$/.test(params.month) ? params.month : taipeiToday().slice(0, 7);
  const [owners, statements, roster] = await Promise.all([
    listOwners(session),
    listStatements(session),
    statementRoster(session, month),
  ]);
  const dash = "—";
  return (
    <>
      <PageHeader title={t("s_423eca6")} />
      <ErrorBanner t={t} error={params.error} />
      <StatementForm
        owners={owners}
        existing={statements.map((row) => ({ ownerId: row.owner_id, month: row.period_start }))}
        month={month}
      />
      <div className="card" style={{ marginTop: 16 }}>
        <div className="hd">
          <h3>{t("i_statement_list")}</h3>
        </div>
        {roster.length === 0 ? (
          <div className="empty">{t("i_statement_empty")}</div>
        ) : (
          <RfTable testId="statement-list">
            <thead>
              <tr>
                <th>{t("i_owner")}</th>
                <th>{t("i_col_property")}</th>
                <th>{t("i_fee_rule")}</th>
                <th>{t("i_rent_this_month")}</th>
                <th>{t("i_net_owner")}</th>
                <th>{t("i_status")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {roster.map((row) => {
                const figures = row.generated
                  ? ownerSettlement({
                      opening: Number(row.opening),
                      rent: Number(row.rent),
                      other: Number(row.other),
                      fee: Number(row.fee),
                      expenses: Number(row.expenses),
                      payouts: Number(row.payouts),
                      closing: Number(row.closing),
                    })
                  : null;
                const label = (minor: number) => moneyLabel(minor, row.currency, session.locale);
                const period = row.period_start.slice(0, 7);
                return (
                  <tr key={`${row.owner_id}-${period}`}>
                    <Cell>
                      <b>{row.owner_name}</b>
                      <div className="small muted">{period}</div>
                    </Cell>
                    <Cell label={t("i_col_property")}>{row.properties || dash}</Cell>
                    <Cell label={t("i_fee_rule")}>{row.fee_rule || dash}</Cell>
                    <Cell label={t("i_rent_this_month")}>{figures ? label(figures.rent) : dash}</Cell>
                    <Cell label={t("i_net_owner")}>
                      {figures && figures.owes > 0 ? (
                        <span className="chip warn" data-testid="owner-owes">
                          {t("owner_owes", { amount: label(figures.owes) })}
                        </span>
                      ) : figures ? (
                        label(figures.payable)
                      ) : (
                        dash
                      )}
                    </Cell>
                    <Cell label={t("i_status")}>
                      <span className={`chip ${row.generated ? "ok" : ""}`}>{row.generated ? t("i_generated") : t("i_not_generated")}</span>
                    </Cell>
                    <Cell action>
                      <Link className="btn" href={row.id ? `/m/statements/${row.id}` : `/m/statements/preview?owner=${row.owner_id}&month=${period}`}>
                        {t("i_preview")}
                      </Link>
                      <form action={actionStatement}>
                        <input type="hidden" name="ownerContactId" value={row.owner_id} />
                        <input type="hidden" name="month" value={period} />
                        <button className={row.generated ? "btn" : "btn pri"} type="submit">
                          {row.generated ? t("s_1bd133f") : t("s_705a524")}
                        </button>
                      </form>
                    </Cell>
                  </tr>
                );
              })}
            </tbody>
          </RfTable>
        )}
      </div>
    </>
  );
}

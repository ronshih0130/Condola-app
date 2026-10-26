import { requireCurrentConsent } from "@/server/consent-gate";
import Link from "next/link";
import { makeT } from "@/i18n";
import { StatementForm } from "@/components/dialogs";
import { Cell, RfTable } from "@/components/rf";
import { ErrorBanner, PageHeader } from "@/components/ui";
import { actionAddExpense } from "@/server/auth-actions";
import { actionStatement } from "@/server/actions";
import { moneyLabel, ownerSettlement, signedMoneyLabel, statementPeriodNet } from "@/server/format";
import { taipeiToday } from "@/server/money";
import { can, rolesFor } from "@/server/perms";
import { listOwners, listProperties, listStatements, statementRoster } from "@/server/queries";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function StatementsPage({ searchParams }: { searchParams: Promise<{ error?: string; month?: string }> }) {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  const t = makeT(session.locale);
  const params = await searchParams;
  const month = params.month && /^\d{4}-\d{2}$/.test(params.month) ? params.month : taipeiToday().slice(0, 7);
  const [owners, statements, roster, properties] = await Promise.all([
    listOwners(session),
    listStatements(session),
    statementRoster(session, month),
    listProperties(session),
  ]);
  const canGenerate = can(session.role, "stmt.generate");
  const canExpense = can(session.role, "exp.add");
  const roleLabel: Record<string, string> = {
    admin: "i_role_admin",
    manager: "i_role_manager",
    accountant: "i_role_accountant",
    maintenance: "i_role_maintenance",
  };
  const denied = t("pm_need", {
    roles: rolesFor("stmt.generate")
      .map((role) => t(roleLabel[role]))
      .join(t("i_list_sep")),
  });
  const dash = "—";
  return (
    <>
      <PageHeader title={t("s_423eca6")} />
      <ErrorBanner t={t} error={params.error} />
      <StatementForm
        owners={owners}
        existing={statements.map((row) => ({ ownerId: row.owner_id, month: row.period_start }))}
        month={month}
        canGenerate={canGenerate}
        deniedReason={denied}
      />
      {canExpense ? (
        <>
        <p style={{ marginTop: 16 }}>
          <Link className="btn" href="/m/expenses" data-testid="open-expenses">
            {t("i_nav_expenses")}
          </Link>
        </p>
        <form className="card pad" action={actionAddExpense} style={{ marginTop: 16, maxWidth: 640 }} data-testid="expense-form">
          <h3>{t("i_add_expense")}</h3>
          <div className="fg">
            <label className="f">{t("i_col_property")}</label>
            <select className="inp" name="propertyId" data-testid="expense-property" defaultValue="">
              <option value="">{t("i_choose")}</option>
              {properties.map((property) => (
                <option key={property.id} value={property.id}>
                  {property.name}
                </option>
              ))}
            </select>
          </div>
          <div className="fg">
            <label className="f">{t("i_description")}</label>
            <input className="inp" name="description" data-testid="expense-description" required />
          </div>
          <div className="fg">
            <label className="f">{t("i_amount_label")}</label>
            <input className="inp" name="amount" data-testid="expense-amount" inputMode="decimal" required />
          </div>
          <div className="fg">
            <label className="f">{t("i_receipt")}</label>
            <input className="inp" name="receipt" data-testid="expense-receipt" required />
          </div>
          <button className="btn pri" type="submit">
            {t("i_add_expense")}
          </button>
        </form>
        </>
      ) : null}
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
                const signed = (minor: number) => signedMoneyLabel(minor, row.currency, session.locale);
                const periodNet = figures ? statementPeriodNet(figures) : 0;
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
                      {figures && periodNet < 0 ? (
                        <span className="chip warn" data-testid="owner-owes">
                          {t("owner_owes")} {signed(periodNet)}
                        </span>
                      ) : figures ? (
                        label(periodNet)
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
                      {canGenerate ? (
                        <form action={actionStatement}>
                          <input type="hidden" name="ownerContactId" value={row.owner_id} />
                          <input type="hidden" name="month" value={period} />
                          <button className={row.generated ? "btn" : "btn pri"} type="submit">
                            {row.generated ? t("s_1bd133f") : t("s_705a524")}
                          </button>
                        </form>
                      ) : (
                        <button className="btn" type="button" disabled title={denied} aria-disabled="true">
                          {row.generated ? t("s_1bd133f") : t("s_705a524")}
                        </button>
                      )}
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

import { ManagementEmptyState } from "@/components/management-empty-state";
import { requireCurrentConsent } from "@/server/consent-gate";
import Link from "next/link";
import { redirect } from "next/navigation";
import { noPermHref } from "@/server/perms";
import { makeT } from "@/i18n";
import { Cell, RfTable } from "@/components/rf";
import { ErrorBanner, PageHeader, expenseCategoryKey, expenseStatusClass, expenseStatusKey } from "@/components/ui";
import { expenseFormOptions, listExpenses } from "@/server/expenses";
import { moneyLabel } from "@/server/format";
import { displaySampleName } from "@/server/sandbox-data";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; property?: string; unit?: string; status?: string }>;
}) {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  const denied = noPermHref("/m/expenses", session.role);
  if (denied) redirect(denied);
  const t = makeT(session.locale);
  const params = await searchParams;
  const [rows, choices] = await Promise.all([
    listExpenses(session, { propertyId: params.property, unitId: params.unit, status: params.status }),
    expenseFormOptions(session),
  ]);
  const dash = "—";
  const newHref = params.property ? `/m/expenses/new?property=${encodeURIComponent(params.property)}` : "/m/expenses/new";
  const categoryLabel = (category: string) => {
    const key = expenseCategoryKey(category);
    return key ? t(key) : category;
  };
  return (
    <>
      <PageHeader
        title={t("i_nav_expenses")}
        actions={rows.length > 0 ?
          <Link className="btn pri" href={newHref} data-testid="new-expense">
            {t("i_expense_new")}
          </Link> : null
        }
      />
      <p className="small muted">{t("i_expense_hint")}</p>
      <ErrorBanner t={t} error={params.error} />
      <form className="card pad" method="get" data-testid="expense-filters" style={{ margin: "16px 0", maxWidth: 880 }}>
        <div className="row" style={{ gap: 12, alignItems: "end", flexWrap: "wrap" }}>
          <div className="fg" style={{ minWidth: 180 }}>
            <label className="f">{t("i_col_property")}</label>
            <select className="inp" name="property" data-testid="expense-filter-property" defaultValue={params.property ?? ""}>
              <option value="">{t("i_expense_all")}</option>
              {choices.properties.map((property) => (
                <option key={property.id} value={property.id}>
                  {property.name}
                </option>
              ))}
            </select>
          </div>
          <div className="fg" style={{ minWidth: 180 }}>
            <label className="f">{t("i_expense_unit")}</label>
            <select className="inp" name="unit" data-testid="expense-filter-unit" defaultValue={params.unit ?? ""}>
              <option value="">{t("i_expense_all")}</option>
              {choices.units.map((unit) => (
                <option key={unit.id} value={unit.id}>
                  {displaySampleName(unit.property_name)} · {displaySampleName(unit.label)}
                </option>
              ))}
            </select>
          </div>
          <div className="fg" style={{ minWidth: 160 }}>
            <label className="f">{t("i_status")}</label>
            <select className="inp" name="status" data-testid="expense-filter-status" defaultValue={params.status ?? ""}>
              <option value="">{t("i_expense_all")}</option>
              {["draft", "submitted", "approved", "rejected", "posted", "void"].map((status) => (
                <option key={status} value={status}>
                  {t(expenseStatusKey(status))}
                </option>
              ))}
            </select>
          </div>
          <button className="btn" type="submit" data-testid="expense-filter-apply">
            {t("i_filter_apply")}
          </button>
        </div>
      </form>
      <div className="card">
        {rows.length === 0 ? (
          <ManagementEmptyState session={session} page="EXP" actionHref={newHref} />
        ) : (
          <RfTable testId="expense-list">
            <thead>
              <tr>
                <th>{t("i_expense_date")}</th>
                <th>{t("i_col_property")}</th>
                <th>{t("i_expense_unit")}</th>
                <th>{t("i_category")}</th>
                <th>{t("i_expense_vendor")}</th>
                <th>{t("i_note")}</th>
                <th className="num">{t("i_amount_label")}</th>
                <th>{t("i_status")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} data-testid="expense-row" data-status={row.status} data-included={row.included ? "true" : "false"}>
                  <Cell>{row.incurred_on}</Cell>
                  <Cell label={t("i_col_property")}>{displaySampleName(row.property_name)}</Cell>
                  <Cell label={t("i_expense_unit")}>{row.unit_label ? displaySampleName(row.unit_label) : dash}</Cell>
                  <Cell label={t("i_category")}>{categoryLabel(row.category)}</Cell>
                  <Cell label={t("i_expense_vendor")}>{row.vendor_name || dash}</Cell>
                  <Cell label={t("i_note")}>
                    {row.description || dash}
                    {row.ticket_id && row.ticket_number ? (
                      <div className="small">
                        <Link href={`/m/tickets/${row.ticket_id}`} data-testid="expense-ticket">
                          {t("i_expense_ticket", { number: row.ticket_number })}
                        </Link>
                      </div>
                    ) : null}
                  </Cell>
                  <Cell label={t("i_amount_label")} className="num">
                    {moneyLabel(row.amount_minor, row.currency, session.locale)}
                  </Cell>
                  <Cell label={t("i_status")}>
                    <span className={`chip ${expenseStatusClass(row.status)}`} data-testid="expense-status">
                      {t(expenseStatusKey(row.status))}
                    </span>
                    <div className="small" data-testid="expense-included">
                      {row.included ? t("i_expense_included") : t("i_expense_excluded")}
                    </div>
                  </Cell>
                  <Cell action>
                    <Link className="btn sm" href={`/m/expenses/${row.id}`}>
                      {row.status === "void" ? t("i_expense_open") : t("i_edit")}
                    </Link>
                  </Cell>
                </tr>
              ))}
            </tbody>
          </RfTable>
        )}
      </div>
    </>
  );
}

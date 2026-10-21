import Link from "next/link";
import { makeT } from "@/i18n";
import { Cell, RfTable } from "@/components/rf";
import { ErrorBanner, PageHeader, expenseCategoryKey, expenseStatusClass, expenseStatusKey } from "@/components/ui";
import { expenseFormOptions, listExpenses } from "@/server/expenses";
import { formatMoney } from "@/server/format";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; property?: string; unit?: string; status?: string }>;
}) {
  const session = await getSession();
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
        actions={
          <Link className="btn pri" href={newHref} data-testid="new-expense">
            {t("i_expense_new")}
          </Link>
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
                  {unit.property_name} · {unit.label}
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
          <div className="empty" data-testid="expense-empty">
            {t("i_expense_empty")}
          </div>
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
                  <Cell label={t("i_col_property")}>{row.property_name}</Cell>
                  <Cell label={t("i_expense_unit")}>{row.unit_label || dash}</Cell>
                  <Cell label={t("i_category")}>{categoryLabel(row.category)}</Cell>
                  <Cell label={t("i_expense_vendor")}>{row.vendor_name || dash}</Cell>
                  <Cell label={t("i_note")}>
                    {row.description || dash}
                    {row.receipt_name ? <div className="small muted">{row.receipt_name}</div> : null}
                  </Cell>
                  <Cell label={t("i_amount_label")} className="num">
                    {formatMoney(row.amount_minor, row.currency, session.locale)}
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

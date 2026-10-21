import Link from "next/link";
import { notFound } from "next/navigation";
import { makeT } from "@/i18n";
import { ExpenseForm } from "@/components/expense-form";
import { ErrorBanner, PageHeader, expenseCategoryKey, expenseStatusClass, expenseStatusKey } from "@/components/ui";
import { actionApproveExpense, actionUpdateExpense, actionVoidExpense } from "@/server/auth-actions";
import { EXPENSE_CATEGORIES, expenseCanBeApproved, expenseFormOptions, getExpense, majorInput } from "@/server/expenses";
import { formatMoney } from "@/server/format";
import { displaySampleName } from "@/server/sandbox-data";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function ExpenseDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string; voided?: string; approved?: string }>;
}) {
  const session = await getSession();
  const t = makeT(session.locale);
  const { id } = await params;
  const query = await searchParams;
  const [row, choices] = await Promise.all([getExpense(session, id), expenseFormOptions(session)]);
  if (!row) notFound();
  const known = (EXPENSE_CATEGORIES as readonly string[]).includes(row.category);
  const categories = [
    ...(known ? [] : [{ value: row.category, label: row.category }]),
    ...EXPENSE_CATEGORIES.map((value) => ({ value, label: t(expenseCategoryKey(value)) })),
  ];
  const categoryLabel = expenseCategoryKey(row.category) ? t(expenseCategoryKey(row.category)) : row.category;
  const editable = row.status !== "void" && !row.month_closed;
  const canApprove = expenseCanBeApproved(row.status) && !row.month_closed;
  return (
    <>
      <PageHeader title={categoryLabel} crumb={<Link href="/m/expenses">{t("i_nav_expenses")}</Link>} />
      <ErrorBanner t={t} error={query.error} />
      {query.saved === "1" ? (
        <div className="alert ok" data-testid="expense-saved">
          {t("i_expense_saved")}
        </div>
      ) : null}
      {query.voided === "1" ? (
        <div className="alert ok" data-testid="expense-voided">
          {t("i_expense_voided")}
        </div>
      ) : null}
      {query.approved === "1" ? (
        <div className="alert ok" data-testid="expense-approved">
          {t("i_expense_approved")}
        </div>
      ) : null}
      <div className="card pad" style={{ maxWidth: 640, margin: "16px 0" }} data-testid="expense-summary">
        <div className="row" style={{ gap: 8, alignItems: "center" }}>
          <span className={`chip ${expenseStatusClass(row.status)}`} data-testid="expense-status">
            {t(expenseStatusKey(row.status))}
          </span>
          <span data-testid="expense-included">{row.included ? t("i_expense_included") : t("i_expense_excluded")}</span>
        </div>
        <p>
          {displaySampleName(row.property_name)}
          {row.unit_label ? ` · ${displaySampleName(row.unit_label)}` : ""} · {row.incurred_on} · {formatMoney(row.amount_minor, row.currency, session.locale)}
        </p>
        {row.vendor_name ? <p className="small">{row.vendor_name}</p> : null}
        {row.description ? <p>{row.description}</p> : null}
        {row.receipt_file_id && row.receipt_name ? (
          <p>
            <a href={`/api/receipts/${row.receipt_file_id}`} data-testid="receipt-saved">
              {t("i_receipt_view")} {row.receipt_name}
            </a>
          </p>
        ) : null}
        {row.ticket_id && row.ticket_number ? (
          <p>
            <Link href={`/m/tickets/${row.ticket_id}`} data-testid="expense-ticket">
              {t("i_expense_ticket", { number: row.ticket_number })}
            </Link>
          </p>
        ) : null}
      </div>
      {row.status === "void" ? null : row.month_closed ? (
        <p className="small" data-testid="expense-closed">
          {t("i_expense_closed_hint")}
        </p>
      ) : (
        <>
          {row.on_issued ? <p className="small">{t("i_expense_issued_hint")}</p> : null}
          {canApprove ? (
            <form className="card pad" action={actionApproveExpense} data-testid="expense-approve-form" style={{ maxWidth: 640, marginBottom: 16 }}>
              <input type="hidden" name="expenseId" value={row.id} />
              <button className="btn pri" type="submit" data-testid="expense-approve">
                {t("i_expense_approve")}
              </button>
              <p className="small muted">{t("i_expense_approve_hint")}</p>
            </form>
          ) : null}
          <ExpenseForm
            action={actionUpdateExpense}
            properties={choices.properties}
            units={choices.units.map((unit) => ({ id: unit.id, propertyId: unit.property_id, label: unit.label }))}
            vendors={choices.vendors}
            categories={categories}
            lockFinancial={row.on_issued}
            submitLabel={t("i_save")}
            defaults={{
              id: row.id,
              propertyId: row.property_id,
              unitId: row.unit_id ?? "",
              category: row.category,
              amount: majorInput(row.amount_minor),
              incurredOn: row.incurred_on,
              vendorName: row.vendor_name ?? "",
              note: row.description,
              receiptId: row.receipt_file_id ?? "",
              receiptName: row.receipt_name ?? "",
              receiptSize: row.receipt_size ? Number(row.receipt_size) : null,
            }}
          />
          {editable && !row.on_issued ? (
            <form className="card pad" action={actionVoidExpense} data-testid="expense-void-form" style={{ maxWidth: 640, marginTop: 16 }}>
              <h3>{t("i_expense_void")}</h3>
              <input type="hidden" name="expenseId" value={row.id} />
              <div className="fg">
                <label className="f">{t("i_expense_void_reason")}</label>
                <input className="inp" name="reason" data-testid="expense-void-reason" required />
              </div>
              <button className="btn danger" type="submit" data-testid="expense-void">
                {t("i_expense_void")}
              </button>
            </form>
          ) : null}
        </>
      )}
    </>
  );
}

import { requireCurrentConsent } from "@/server/consent-gate";
import Link from "next/link";
import { makeT } from "@/i18n";
import { ExpenseForm } from "@/components/expense-form";
import { ErrorBanner, PageHeader, expenseCategoryKey } from "@/components/ui";
import { actionCreateExpense } from "@/server/auth-actions";
import { EXPENSE_CATEGORIES, expenseFormOptions } from "@/server/expenses";
import { taipeiToday } from "@/server/money";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function NewExpensePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; property?: string }>;
}) {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  const t = makeT(session.locale);
  const params = await searchParams;
  const choices = await expenseFormOptions(session);
  const propertyId = choices.properties.some((property) => property.id === params.property) ? params.property ?? "" : "";
  const categories = EXPENSE_CATEGORIES.map((value) => ({ value, label: t(expenseCategoryKey(value)) }));
  return (
    <>
      <PageHeader title={t("i_expense_new")} crumb={<Link href="/m/expenses">{t("i_nav_expenses")}</Link>} />
      <ErrorBanner t={t} error={params.error} />
      <ExpenseForm
        action={actionCreateExpense}
        properties={choices.properties}
        units={choices.units.map((unit) => ({ id: unit.id, propertyId: unit.property_id, label: unit.label }))}
        vendors={choices.vendors}
        categories={categories}
        lockFinancial={false}
        submitLabel={t("i_expense_new")}
        defaults={{
          propertyId,
          unitId: "",
          category: "repair",
          amount: "",
          incurredOn: taipeiToday(),
          vendorName: "",
          note: "",
        }}
      />
    </>
  );
}

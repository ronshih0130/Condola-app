import { guardEffectiveSession } from "@/server/b017-custom-role-governance";
import { requireCurrentConsent } from "@/server/consent-gate";
import { NextResponse } from "next/server";
import { makeT } from "@/i18n";
import { FlowError } from "@/server/errors";
import { loadIncomeExpense, reportCsv, reportPeriod } from "@/server/income-expense";
import { can } from "@/server/perms";
import { readSession } from "@/server/session";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  let session = await readSession();
  if (!session || session.kind !== "staff" || !can(session, "reports.export")) {
    return NextResponse.json({ error: "errors.forbidden" }, { status: 403 });
  }
  const blocked = await requireCurrentConsent(session, "api");
  if (blocked) return blocked;
  const url = new URL(request.url);
  try {
    session = await guardEffectiveSession(session, "reports.export");
    const period = reportPeriod({
      mode: url.searchParams.get("mode") ?? undefined,
      month: url.searchParams.get("month") ?? undefined,
      from: url.searchParams.get("from") ?? undefined,
      to: url.searchParams.get("to") ?? undefined,
    });
    const rows = await loadIncomeExpense(session, {
      start: period.start,
      end: period.end,
      propertyId: url.searchParams.get("property") ?? undefined,
      ownerId: url.searchParams.get("owner") ?? undefined,
    });
    const t = makeT(session.locale);
    const body = reportCsv(rows, {
      property: t("i_col_property"),
      owner: t("i_owner"),
      currency: t("i_report_currency"),
      income: t("i_report_income"),
      expense: t("i_report_expense"),
      net: t("i_report_net"),
      total: t("i_report_total"),
    });
    return new NextResponse(body, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": "attachment; filename=income-expense.csv",
      },
    });
  } catch (error) {
    if (error instanceof FlowError && error.key === "errors.forbidden") return NextResponse.json({ error: error.key }, { status: 403 });
    if (error instanceof FlowError && error.key === "errors.reportRange") {
      return NextResponse.json({ error: error.key }, { status: 400 });
    }
    throw error;
  }
}

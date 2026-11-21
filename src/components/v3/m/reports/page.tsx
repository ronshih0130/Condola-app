import "./report.css";
import React from "react";
import { incomeExpenseLines, type IncomeReportInput } from "../../../../server/b3-income-report";
import type { Session } from "../../../../server/types";
import { IncomeReportView } from "./report";

export async function IncomeReportPageV3({ session, input }: { session: Session; input: IncomeReportInput }) {
  const data = await incomeExpenseLines(session, input);
  return <IncomeReportView session={session} input={input} data={data} />;
}

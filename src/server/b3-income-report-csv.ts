import { randomUUID } from "node:crypto";
import { incomeReportCopy } from "../i18n/lanes/brand-v3-report";
import type { Locale } from "../i18n";
import { writeIncomeReportExport } from "./audit";
import { incomeExpenseExportData, revalidateIncomeExport, type IncomeReportInput, type IncomeReportReady } from "./b3-income-report";
import type { Session } from "./types";

import { reportMajor } from "./b3-income-report-format";

const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const textCell = (value: string) => quote(/^\s*[=+\-@\t\r\n]/.test(value) ? `'${value}` : value);
export function incomeReportCsv(data: IncomeReportReady, locale: Locale) {
  const c = incomeReportCopy(locale);
  const header = [c.date, c.item, c.property, c.owner, c.currency, c.amount, c.sourceId, c.income, c.expense, c.net, c.deposit].map(textCell).join(",");
  const lines = data.rows.map(row => [textCell(row.date), textCell(`${c[row.kind]} · ${row.item}`), textCell(row.property), textCell(row.owner ?? ""),
    textCell(row.currency), quote(reportMajor(row.amountMinor)), textCell(row.sourceId), "", "", "", ""].join(","));
  const totals = data.totals.map(row => ["", textCell(c.total), "", "", textCell(row.currency), "", "",
    quote(reportMajor(row.incomeMinor)), quote(reportMajor(row.expenseMinor)), quote(reportMajor(row.netMinor)), quote(reportMajor(row.depositMinor))].join(","));
  return `\uFEFF${[header, ...lines, ...totals].join("\r\n")}\r\n`;
}
export type IncomeReportExportAudit = {
  orgId: string; userId: string; actorRole: string; operationId: string;
  start: string; end: string; propertyId: string | null; ownerId: string | null;
  rowCount: number; currencyCount: number;
};
type ExportDeps = {
  read?: typeof incomeExpenseExportData; revalidate?: typeof revalidateIncomeExport;
  audit?: (event: IncomeReportExportAudit) => Promise<void>; operationId?: () => string;
};
/** Each request is a distinct export operation. Retries may create another minimal event;
 * there is no delivery claim or provider call. Do not catch an audit failure and return bytes. */
export async function exportIncomeReport(session: Session, input: IncomeReportInput, deps: ExportDeps = {}) {
  const data = await (deps.read ?? incomeExpenseExportData)(session, input);
  const body = incomeReportCsv(data, session.locale);
  const current = await (deps.revalidate ?? revalidateIncomeExport)(session);
  await (deps.audit ?? writeIncomeReportExport)({ orgId: current.orgId, userId: current.userId, actorRole: current.role ?? current.kind,
    operationId: (deps.operationId ?? randomUUID)(), start: data.period.start, end: data.period.end,
    propertyId: input.property || null, ownerId: input.owner || null, rowCount: data.count, currencyCount: data.totals.length });
  return body;
}

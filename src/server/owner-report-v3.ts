import { ownerPrivacy, tenantDisplayNames } from "./auth";
import { maskTenantNames } from "./privacy";
import { listStatements, statementDetail, ownerStatementRentSource, ownerStatementPropertyNames } from "./queries";
import { ownerNetLedgerView } from "./owner-net-ledger";
import { ledgerPanelView } from "./owner-net-ledger-presentation";
import { ownerTransferHistory, reportRepliesView } from "./owner-finance-replies";
import { repliesPanelView } from "./owner-finance-replies-presentation";
import { makeT } from "@/i18n";
import type { Session } from "./types";

export function selectReportMonth<T extends { id: string; period_start: string; status: string; currency: string; properties?: string }>(rows: T[], requested: unknown) {
  const issued = rows.filter(row => row.status === "issued");
  const months = [...new Set(issued.map(row => row.period_start.slice(0, 7)))].sort().reverse();
  const month = typeof requested === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(requested) && months.includes(requested) ? requested : months[0];
  const index = months.indexOf(month);
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  return { month, previous: months[index + 1], next: index > 0 ? months[index - 1] : undefined,
    rows: issued.filter(row => row.period_start.slice(0, 7) === month)
      .sort((a, b) => compare(a.properties ?? "", b.properties ?? "") || compare(a.currency, b.currency) || compare(a.id, b.id)) };
}

/** Same detail readers, privacy masking and presentation as /o/statements/[id]. */
export async function loadOwnerReport(session: Session, requested: unknown) {
  const selected = selectReportMonth(await listStatements(session), requested);
  if (!selected.month) return { ...selected, reports: [] };
  const properties = new Map((await ownerStatementPropertyNames(session, selected.rows.map(row => row.id)))
    .map(row => [row.id, row.properties ?? ""]));
  const named = selectReportMonth(selected.rows.map(row => ({ ...row, properties: properties.get(row.id) ?? "" })), selected.month);
  const t = makeT(session.locale);
  const privacy = await ownerPrivacy(session.orgId);
  const names = privacy.showName ? [] : await tenantDisplayNames(session.orgId);
  const reports = await Promise.all(named.rows.map(async listed => {
    const detail = await statementDetail(session, listed.id);
    // Authorization may have changed since listing: disclose no partial report.
    if (!detail || detail.statement.status !== "issued") throw new Error("Report unavailable");
    const lines = detail.lines.map(line => ({ ...line,
      description: line.description && !privacy.showName ? maskTenantNames(line.description, names, t("i_tenant_hidden")) : line.description,
    }));
    const ledger = await ownerNetLedgerView(session, listed.id);
    const [transfers, replies] = await Promise.all([ownerTransferHistory(session, listed.id), reportRepliesView(session, listed.id)]);
    const versionNumbers = new Map((ledger?.versions ?? []).map(v => [v.id, v.version_no]));
    // Optional provenance must never make an otherwise readable report unavailable.
    const source = await ownerStatementRentSource(session, listed.id).catch(() => null);
    return { id: listed.id, properties: listed.properties ?? "", row: detail.statement, lines, source,
      ledger: ledger ? ledgerPanelView(ledger, { statementId: listed.id, locale: session.locale }) : null,
      replies: transfers || replies ? repliesPanelView({ statementId: listed.id, locale: session.locale, transfers, replies, versionNumbers, displayedVersionId: ledger ? ledger.latest?.id ?? null : undefined }) : null };
  }));
  return { ...selected, rows: named.rows, reports };
}
export type OwnerReportData = Awaited<ReturnType<typeof loadOwnerReport>>;

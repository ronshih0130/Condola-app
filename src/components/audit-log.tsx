import Link from "next/link";
import { makeT, type T } from "@/i18n";
import { loadAuditHistory, type AuditTable, type AuditView } from "@/server/audit-read";
import { showDemoLineCopy } from "@/server/demo";
import { displaySampleName } from "@/sample-name";
import { getSession } from "@/server/session";

export function AuditRows({ entries, t, testId }: { entries: AuditView[]; t: T; testId: string; demoLine?: boolean }) {
  return (
    <table className="t rf" data-testid={testId}>
      <thead>
        <tr>
          <th>{t("i_audit_who")}</th>
          <th>{t("i_audit_what")}</th>
          <th>{t("i_audit_which")}</th>
          <th>{t("i_audit_when")}</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => {
          const recordText = entry.recordText ? displaySampleName(entry.recordText) : "";
          const record = `${t(entry.recordKey)}${recordText ? ` ${recordText}` : ""}${entry.found ? "" : ` ${t("i_audit_deleted")}`}`;
          return (
            <tr key={entry.cursor} data-testid="audit-row">
              <td>{entry.who || (entry.whoKey ? t(entry.whoKey) : "")}</td>
              <td>
                <div>{t(entry.actionKey)}</div>
                {entry.changes.map((change) => (
                  <div key={change.fieldKey} className="small" data-testid="audit-change">
                    {t(change.fieldKey)} {change.before} → {change.after}
                  </div>
                ))}
                {entry.fields.length ? <div className="small muted">{entry.fields.map((key) => t(key)).join(t("i_list_sep"))}</div> : null}
                {entry.other ? <div className="small muted">{t("i_audit_f_other")}</div> : null}
                {entry.masked ? <div className="small muted">{t("i_audit_masked")}</div> : null}
                {entry.reason ? <div className="small">{entry.reason}</div> : null}
              </td>
              <td data-label={t("i_audit_which")}>
                {entry.href ? <Link href={entry.href}>{record}</Link> : record}
              </td>
              <td data-label={t("i_audit_when")}>{entry.when}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export async function AuditHistory({
  table,
  rowId,
  cursor,
  path,
  preserve,
}: {
  table: AuditTable;
  rowId: string;
  cursor?: string;
  path: string;
  preserve?: Record<string, string | undefined>;
}) {
  const session = await getSession();
  if (session.role !== "admin") return null;
  const t = makeT(session.locale);
  const demoLine = showDemoLineCopy(session.environment);
  const page = await loadAuditHistory(session, table, rowId, cursor);
  const kept = new URLSearchParams();
  for (const [key, value] of Object.entries(preserve ?? {})) {
    if (value) kept.set(key, value);
  }
  const latest = kept.toString() ? `${path}?${kept.toString()}` : path;
  const nextCursor = page.hasMore ? page.entries.at(-1)?.cursor : undefined;
  let nextHref = "";
  if (nextCursor) {
    const next = new URLSearchParams(kept);
    next.set("audit", nextCursor);
    nextHref = `${path}?${next.toString()}`;
  }
  return (
    <div className="card" data-testid="audit-history" style={{ marginTop: 16 }}>
      <div className="hd">
        <h3>{t("i_audit_history")}</h3>
      </div>
      {page.entries.length === 0 ? (
        <div className="empty">{t("i_audit_empty")}</div>
      ) : (
        <AuditRows entries={page.entries} t={t} testId="audit-history-list" demoLine={demoLine} />
      )}
      {cursor || nextHref ? (
        <div className="bd">
          {cursor ? (
            <Link href={latest} data-testid="audit-history-latest">
              {t("i_audit_latest")}
            </Link>
          ) : null}
          {nextHref ? (
            <Link href={nextHref} data-testid="audit-history-next" style={{ marginLeft: 12 }}>
              {t("i_audit_next")}
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

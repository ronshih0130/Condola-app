import Link from "next/link";
import { redirect } from "next/navigation";
import { makeT } from "@/i18n";
import { AuditRows } from "@/components/audit-log";
import { PageHeader } from "@/components/ui";
import {
  AUDIT_ACTIONS,
  AUDIT_EVENTS,
  AUDIT_TABLES,
  actionKey,
  auditListQuery,
  loadAuditScreen,
  recordKey,
} from "@/server/audit-read";
import { noPermHref } from "@/server/perms";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ user?: string; action?: string; record?: string; from?: string; to?: string; cursor?: string }>;
}) {
  const session = await getSession();
  const denied = noPermHref("/m/audit", session.role);
  if (denied) redirect(denied);
  const query = await searchParams;
  const t = makeT(session.locale);
  const page = await loadAuditScreen(session, query);
  const { filters } = page;
  const selectedAction = filters.eventType || filters.action || "";
  const next = page.hasMore ? page.entries.at(-1)?.cursor : undefined;
  const knownActor = filters.actorId && page.actors.some((actor) => actor.id === filters.actorId);
  return (
    <div data-testid="audit-page">
      <PageHeader title={t("i_audit_title")} />
      <p className="muted">{t("i_audit_sub")}</p>
      <p className="small muted">{t("i_audit_mask_note")}</p>
      <div className="card">
      <form className="filters" action="/m/audit" method="get" data-testid="audit-filters">
        <select className="inp" name="user" aria-label={t("i_audit_user")} defaultValue={filters.actorId ?? ""}>
          <option value="">{t("i_audit_all")}</option>
          {page.actors.map((actor) => (
            <option key={actor.id} value={actor.id}>
              {actor.name || t("i_audit_member")}
            </option>
          ))}
          {filters.actorId && !knownActor ? <option value={filters.actorId}>{t("i_audit_member")}</option> : null}
        </select>
        <select className="inp" name="action" aria-label={t("i_audit_action_type")} defaultValue={selectedAction}>
          <option value="">{t("i_audit_all")}</option>
          {AUDIT_ACTIONS.map((action) => (
            <option key={action} value={action}>
              {t(actionKey(action, null))}
            </option>
          ))}
          {AUDIT_EVENTS.map((event) => (
            <option key={event} value={event}>
              {t(actionKey("insert", event))}
            </option>
          ))}
        </select>
        <select className="inp" name="record" aria-label={t("i_audit_record_type")} defaultValue={filters.tableName ?? ""}>
          <option value="">{t("i_audit_all")}</option>
          {AUDIT_TABLES.map((table) => (
            <option key={table} value={table}>
              {t(recordKey(table))}
            </option>
          ))}
        </select>
        <input className="inp" type="date" name="from" aria-label={t("i_audit_from")} defaultValue={filters.from ?? ""} />
        <input className="inp" type="date" name="to" aria-label={t("i_audit_to")} defaultValue={filters.to ?? ""} />
        <button className="btn sm" type="submit">
          {t("i_audit_apply")}
        </button>
        <Link href="/m/audit">{t("i_audit_clear")}</Link>
      </form>
        {page.entries.length === 0 ? (
          <div className="empty" data-testid="audit-empty">
            {t("i_audit_empty")}
          </div>
        ) : (
          <AuditRows entries={page.entries} t={t} testId="audit-list" />
        )}
        {filters.cursor || next ? (
          <div className="bd">
            {filters.cursor ? (
              <Link href={auditListQuery(filters)} data-testid="audit-latest">
                {t("i_audit_latest")}
              </Link>
            ) : null}
            {next ? (
              <Link href={auditListQuery(filters, next)} data-testid="audit-next" style={{ marginLeft: 12 }}>
                {t("i_audit_next")}
              </Link>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

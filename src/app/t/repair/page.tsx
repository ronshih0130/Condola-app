import Link from "next/link";
import { makeT } from "@/i18n";
import { RepairThread } from "@/components/repair-thread";
import { ErrorBanner, statusClass, statusKey } from "@/components/ui";
import { REPAIR_CAT_KEY } from "@/lib/repair-labels";
import { selectedLease } from "@/lib/tenant-lease";
import { actionCancelRepair, actionTicket } from "@/server/actions";
import { isUuid } from "@/server/repair-rules";
import { tenantRepairs, ticketDetail } from "@/server/queries";

export const dynamic = "force-dynamic";

export default async function RepairPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; done?: string; id?: string }>;
}) {
  const { session, lease } = await selectedLease();
  const t = makeT(session.locale);
  const params = await searchParams;
  if (!lease) return <p>{t("i_empty")}</p>;
  const repairs = await tenantRepairs(session, lease.lease_id);
  const selectedId = params.id && isUuid(params.id) ? params.id : "";
  const detail = selectedId ? await ticketDetail(session, selectedId) : null;
  const own = detail && repairs.some((repair) => repair.id === detail.ticket.id) ? detail : null;
  return (
    <div>
      <h2>{t("i_rich_repair")}</h2>
      <ErrorBanner t={t} error={params.error} />
      {params.done ? (
        <div className="alert ok" data-testid="repair-sent">
          <p>{own ? t("i_repair_success_title", { number: own.ticket.number }) : t("i_repair_success_hint")}</p>
          {own ? <p>{t("i_repair_success_hint")}</p> : null}
          {own ? (
            <p>
              <Link href={`/t/repair?id=${own.ticket.id}`}>{t("i_repair_view_progress")}</Link>
              {" · "}
              <Link href="/t">{t("i_repair_home")}</Link>
            </p>
          ) : null}
        </div>
      ) : null}
      {own ? (
        <div className="card pad" style={{ marginBottom: 16 }} data-testid="repair-detail">
          <h3>
            #{own.ticket.number} {own.ticket.title}
          </h3>
          <p className="small muted">
            {t(REPAIR_CAT_KEY[own.ticket.category] ?? "i_cat_other")} · {t(statusKey(own.ticket.status))}
          </p>
          {own.ticket.description ? <p>{own.ticket.description}</p> : null}
          {own.ticket.status === "open" ? (
            <form action={actionCancelRepair}>
              <input type="hidden" name="ticketId" value={own.ticket.id} />
              <p className="small" data-testid="repair-cancel-confirm">{t("i_repair_cancel_confirm")}</p>
              <button className="btn sm" type="submit" data-testid="repair-cancel">
                {t("i_repair_cancel")}
              </button>
            </form>
          ) : own.ticket.status === "cancelled" ? null : (
            <p className="small" data-testid="repair-cancel-locked">
              {t("i_repair_cancel_locked")}
            </p>
          )}
          <RepairThread
            ticketId={own.ticket.id}
            comments={own.comments}
            photos={own.photos}
            t={t}
            locale={session.locale}
            calendar={session.calendar}
            canComment
            canUpload
            allowInternal={false}
            returnTo="tenant"
          />
        </div>
      ) : null}
      <form action={actionTicket}>
        <input type="hidden" name="leaseId" value={lease.lease_id} />
        <h3>{t("i_repair_new")}</h3>
        <div className="fg">
          <label className="f">{t("i_repair_type")}</label>
          <select className="inp" name="category" data-testid="repair-category" defaultValue="">
            <option value="">{t("i_choose")}</option>
            <option value="plumbing">{t("i_cat_plumbing")}</option>
            <option value="electrical">{t("i_cat_electrical")}</option>
            <option value="appliance">{t("i_cat_appliance")}</option>
            <option value="hvac">{t("i_cat_hvac")}</option>
            <option value="other">{t("i_cat_other")}</option>
          </select>
        </div>
        <div className="fg">
          <label className="f">{t("i_repair_short")}</label>
          <input className="inp" name="title" data-testid="repair-title" placeholder={t("i_ph_title")} defaultValue="" />
        </div>
        <div className="fg">
          <label className="f">{t("i_repair_detail_optional")}</label>
          <textarea className="inp" name="description" defaultValue="" />
        </div>
        <button className="btn pri block" type="submit" data-testid="submit-repair">
          {t("i_submit_repair")}
        </button>
      </form>
      <h3 style={{ marginTop: 20 }}>{t("i_repair_mine")}</h3>
      {repairs.length === 0 ? (
        <div data-testid="repair-tenant-empty">
          <p>{t("i_repair_tenant_empty")}</p>
          <p className="small muted">{t("i_repair_tenant_empty_hint")}</p>
        </div>
      ) : null}
      <ul className="repair-timeline" data-testid="tenant-repairs">
        {repairs.map((repair) => (
          <li key={repair.id}>
            <Link href={`/t/repair?id=${repair.id}`} data-testid={`tenant-repair-${repair.number}`}>
              #{repair.number} {repair.title}
            </Link>
            <div className="small muted">
              {t(REPAIR_CAT_KEY[repair.category] ?? "i_cat_other")} ·{" "}
              <span className={`chip ${statusClass(repair.status)}`}>{t(statusKey(repair.status))}</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

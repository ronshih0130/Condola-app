import Link from "next/link";
import { makeT } from "@/i18n";
import { RepairThread } from "@/components/repair-thread";
import { ErrorBanner, statusClass, statusKey } from "@/components/ui";
import { REPAIR_CAT_KEY } from "@/lib/repair-labels";
import { selectedLease } from "@/lib/tenant-lease";
import { actionTicket } from "@/server/actions";
import { isUuid } from "@/server/repair-rules";
import { tenantRepairs, ticketDetail } from "@/server/queries";
import { signTicketPhotoUrls } from "@/server/ticket-photos";

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
  const signed = own ? await signTicketPhotoUrls(own.photos.map((photo) => photo.path)) : {};
  return (
    <div>
      <h2>{t("i_rich_repair")}</h2>
      <ErrorBanner t={t} error={params.error} />
      {params.done ? <div className="alert ok">{t("i_repair_sent", { firm: lease.firm_name })}</div> : null}
      {own ? (
        <div className="card pad" style={{ marginBottom: 16 }} data-testid="repair-detail">
          <h3>
            #{own.ticket.number} {own.ticket.title}
          </h3>
          <p className="small muted">
            {t(REPAIR_CAT_KEY[own.ticket.category] ?? "i_cat_other")} · {t(statusKey(own.ticket.status))}
          </p>
          {own.ticket.description ? <p>{own.ticket.description}</p> : null}
          <RepairThread
            ticketId={own.ticket.id}
            comments={own.comments}
            photos={own.photos.map((photo) => ({ ...photo, url: signed[photo.path] }))}
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
        <div className="fg">
          <label className="f">{t("i_category")}</label>
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
          <label className="f">{t("i_title")}</label>
          <input className="inp" name="title" data-testid="repair-title" placeholder={t("i_ph_title")} defaultValue="" />
        </div>
        <div className="fg">
          <label className="f">{t("i_description")}</label>
          <textarea className="inp" name="description" defaultValue="" />
        </div>
        <button className="btn pri block" type="submit" data-testid="submit-repair">
          {t("i_submit_repair")}
        </button>
      </form>
      <h3 style={{ marginTop: 20 }}>{t("i_repair_history")}</h3>
      <p className="small muted">{t("i_repair_own_hint")}</p>
      {repairs.length === 0 ? <p className="small muted">{t("i_repair_none")}</p> : null}
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

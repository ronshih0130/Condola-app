import Link from "next/link";
import { makeT } from "@/i18n";
import { RepairCreateForm } from "@/components/repair-create-form";
import { RepairThread } from "@/components/repair-thread";
import { ErrorBanner, statusClass, statusKey } from "@/components/ui";
import { REPAIR_CAT_KEY } from "@/lib/repair-labels";
import { selectedLease } from "@/lib/tenant-lease";
import { isUuid } from "@/server/repair-rules";
import { tenantRepairs, ticketDetail } from "@/server/queries";

export const dynamic = "force-dynamic";

export default async function RepairPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; done?: string; id?: string; photoError?: string }>;
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
          {t("i_repair_sent", { firm: lease.firm_name })}
        </div>
      ) : null}
      {params.photoError ? (
        <div className="alert warn" data-testid="repair-photo-partial">
          {t("i_repair_photo_partial")}
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
      <RepairCreateForm
        leaseId={lease.lease_id}
        returnTo="tenant"
        submitTestId="submit-repair"
        categories={[
          { value: "plumbing", label: t("i_cat_plumbing") },
          { value: "electrical", label: t("i_cat_electrical") },
          { value: "appliance", label: t("i_cat_appliance") },
          { value: "hvac", label: t("i_cat_hvac") },
          { value: "other", label: t("i_cat_other") },
        ]}
      />
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

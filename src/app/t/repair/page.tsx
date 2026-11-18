import { Illustration } from "@/components/v3/illustrations";
import { brandV3EnabledForOrg } from "@/server/brand-v3";
import { requireCurrentConsent } from "@/server/consent-gate";
import Link from "next/link";
import { makeT } from "@/i18n";
import { RepairThread } from "@/components/repair-thread";
import { ErrorBanner, statusClass, statusKey } from "@/components/ui";
import { REPAIR_CAT_KEY } from "@/lib/repair-labels";
import { selectedLease } from "@/lib/tenant-lease";
import { actionCancelRepair, actionTicket } from "@/server/actions";
import { isUuid } from "@/server/repair-rules";
import { tenantRepairs, ticketDetail } from "@/server/queries";
import { ticketPhotoRecovery } from "@/server/upload-recovery";
import type { T } from "@/i18n";
import { Suspense } from "react";
import { tenantRepairView } from "@/server/b090-tenant-lease-repair";
import { TenantRepairError, TenantRepairListV3, TenantRepairLoading, TenantRepairProgressV3 } from "@/components/v3/tenant/repair";
import type { Session } from "@/server/types";

function repairStatusLabel(status: string, t: T) {
  if (status === "cancelled") return t("i_repair_cancelled_status");
  return t(statusKey(status));
}

export const dynamic = "force-dynamic";

export default async function RepairPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; done?: string; id?: string; cancel?: string; cancelled?: string }>;
}) {
  await requireCurrentConsent(undefined, "page");
  const { session, lease } = await selectedLease();
  const v3 = await brandV3EnabledForOrg(session.orgId);
  const t = makeT(session.locale);
  const params = await searchParams;
  if (!lease) return <p>{t("i_empty")}</p>;
  // B-090 slice 3, RT-REPAIR read part (TEN-56-AC4/AC5): under brand_v3 the list cards and the progress page.
  // The 新增報修 form, cancel and the comment/photo thread are today's. brand_v3 OFF: the page below, unchanged.
  if (v3) {
    return (
      <Suspense fallback={<TenantRepairLoading />}>
        <TenantRepairV3Body session={session} leaseId={lease.lease_id} company={lease.firm_name} params={params} />
      </Suspense>
    );
  }
  const repairs = await tenantRepairs(session, lease.lease_id);
  const selectedId = params.id && isUuid(params.id) ? params.id : "";
  const detail = selectedId ? await ticketDetail(session, selectedId) : null;
  const own = detail && repairs.some((repair) => repair.id === detail.ticket.id) ? detail : null;
  const confirming = params.cancel === "1" && own?.ticket.status === "open";
  const uploadRecovery = own ? await ticketPhotoRecovery(session, own.ticket.id) : null;
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
      {params.cancelled === "1" && own && own.ticket.status === "cancelled" ? (
        <div className="alert ok" data-testid="repair-cancelled-toast">
          {t("i_repair_cancelled_toast", { number: own.ticket.number })}
        </div>
      ) : null}
      {confirming && own ? cancelDialog(t, own.ticket.id) : null}
      {own ? (
        <div className="card pad" style={{ marginBottom: 16 }} data-testid="repair-detail">
          <h3>
            #{own.ticket.number} {own.ticket.title}
          </h3>
          <p className="small muted">
            {t(REPAIR_CAT_KEY[own.ticket.category] ?? "i_cat_other")} · {repairStatusLabel(own.ticket.status, t)}
          </p>
          {own.ticket.description ? <p>{own.ticket.description}</p> : null}
          {own.ticket.status === "open" && !confirming ? (
            <p>
              <Link className="btn sm" href={`/t/repair?id=${own.ticket.id}&cancel=1`} data-testid="repair-cancel">
                {t("i_repair_cancel")}
              </Link>
            </p>
          ) : own.ticket.status === "cancelled" || confirming ? null : (
            <p className="small" data-testid="repair-cancel-locked">
              {t("i_repair_cancel_locked")}
            </p>
          )}
          {repairThread(t, session, own.ticket.id, own.comments, own.photos, uploadRecovery)}
        </div>
      ) : null}
      {newRepairForm(t, lease.lease_id)}
      <h3 style={{ marginTop: 20 }}>{t("i_repair_mine")}</h3>
      {repairs.length === 0 ? (
        <div data-testid="repair-tenant-empty">
          {v3 ? <Illustration name="08" /> : null}
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
              <span className={`chip ${statusClass(repair.status)}`} data-testid={`tenant-repair-status-${repair.number}`}>
                {repairStatusLabel(repair.status, t)}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Shared by both versions of the page, so each renders exactly what the page rendered before.
function newRepairForm(t: T, leaseId: string) {
  return (
    <form action={actionTicket}>
      <input type="hidden" name="leaseId" value={leaseId} />
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
  );
}

function cancelDialog(t: T, ticketId: string) {
  return (
    <div className="card pad" data-testid="repair-cancel-dialog" style={{ marginBottom: 16 }}>
      <h3>{t("i_repair_cancel")}</h3>
      <p data-testid="repair-cancel-confirm">{t("i_repair_cancel_confirm")}</p>
      <form action={actionCancelRepair}>
        <input type="hidden" name="ticketId" value={ticketId} />
        <button className="btn pri" type="submit" data-testid="repair-cancel-submit">
          {t("i_repair_cancel")}
        </button>{" "}
        <Link className="btn sm" href={`/t/repair?id=${ticketId}`} data-testid="repair-cancel-back">
          {t("i_repair_cancel_back")}
        </Link>
      </form>
    </div>
  );
}

type Thread = NonNullable<Awaited<ReturnType<typeof ticketDetail>>>;
function repairThread(t: T, session: Session, ticketId: string, comments: Thread["comments"], photos: Thread["photos"], uploadRecovery: Awaited<ReturnType<typeof ticketPhotoRecovery>>) {
  return (
    <RepairThread
      ticketId={ticketId}
      comments={comments}
      photos={photos}
      t={t}
      locale={session.locale}
      calendar={session.calendar}
      canComment
      canUpload
      canViewPhotos={true}
      allowInternal={false}
      returnTo="tenant"
      uploadRecovery={uploadRecovery}
    />
  );
}

type RepairParams = { error?: string; done?: string; id?: string; cancel?: string; cancelled?: string };

/**
 * RT-REPAIR body in its own boundary so the skeleton shows while the readers run (G-LOAD); a failed read is G-ERR.
 * The notices (error banner, sent, cancelled, cancel confirmation) are today's, in the same places they had.
 */
async function TenantRepairV3Body({ session, leaseId, company, params }: { session: Session; leaseId: string; company: string; params: RepairParams }) {
  const t = makeT(session.locale);
  const view = await tenantRepairView(session, leaseId, params.id);
  if (view.state === "error") {
    const retry = params.id && isUuid(params.id) ? `/t/repair?id=${params.id}` : "/t/repair";
    return <TenantRepairError locale={session.locale} retryHref={retry} />;
  }
  if (view.state === "list") {
    return (
      <TenantRepairListV3
        repairs={view.repairs}
        locale={session.locale}
        notices={
          <>
            <ErrorBanner t={t} error={params.error} />
            {params.done ? <div className="alert ok" data-testid="repair-sent"><p>{t("i_repair_success_hint")}</p></div> : null}
          </>
        }
        empty={{ title: t("i_repair_tenant_empty"), hint: t("i_repair_tenant_empty_hint") }}
        newForm={newRepairForm(t, leaseId)}
      />
    );
  }
  const { repair } = view;
  const confirming = params.cancel === "1" && repair.status === "open";
  return (
    <TenantRepairProgressV3
      repair={repair}
      locale={session.locale}
      calendar={session.calendar}
      company={company}
      category={{ label: t("i_repair_type"), value: t(REPAIR_CAT_KEY[repair.category] ?? "i_cat_other") }}
      notices={
        <>
          <ErrorBanner t={t} error={params.error} />
          {params.done ? (
            <div className="alert ok" data-testid="repair-sent">
              <p>{t("i_repair_success_title", { number: repair.number })}</p>
              <p>{t("i_repair_success_hint")}</p>
            </div>
          ) : null}
          {params.cancelled === "1" && repair.status === "cancelled" ? (
            <div className="alert ok" data-testid="repair-cancelled-toast">
              {t("i_repair_cancelled_toast", { number: repair.number })}
            </div>
          ) : null}
          {confirming ? cancelDialog(t, repair.id) : null}
        </>
      }
      cancel={
        repair.status === "open" && !confirming ? (
          <p>
            <Link className="t-rp-text" href={`/t/repair?id=${repair.id}&cancel=1`} data-testid="repair-cancel">
              {t("i_repair_cancel")}
            </Link>
          </p>
        ) : repair.status === "cancelled" || confirming ? null : (
          <p className="t-rp-muted" data-testid="repair-cancel-locked">
            {t("i_repair_cancel_locked")}
          </p>
        )
      }
      thread={repairThread(t, session, repair.id, view.comments, view.photos, view.uploadRecovery)}
    />
  );
}

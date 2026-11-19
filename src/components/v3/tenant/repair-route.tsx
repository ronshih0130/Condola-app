import React, { Suspense } from "react";
import Link from "next/link";
import { makeT, type T } from "../../../i18n";
import { REPAIR_CAT_KEY } from "../../../lib/repair-labels";
import { tenantRepairView } from "../../../server/b090-tenant-lease-repair";
import { isUuid } from "../../../server/repair-rules";
import type { Session } from "../../../server/types";
import { RepairThread } from "../../repair-thread";
import { ErrorBanner } from "../../ui";
import { TenantRepairError, TenantRepairListV3, TenantRepairLoading, TenantRepairProgressV3 } from "./repair";

type FormAction = (formData: FormData) => void | Promise<void>;
export type RepairParams = { error?: string; done?: string; id?: string; cancel?: string; cancelled?: string };
type Props = { session: Session; leaseId: string; company: string; params: RepairParams; actions: { ticket: FormAction; cancel: FormAction } };

/** Today's 新增報修 form (same fields, names and action as the existing page), inside the v3 list's card. */
function NewRepairForm({ t, leaseId, action }: { t: T; leaseId: string; action: FormAction }) {
  return <form action={action}>
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
    <button className="btn pri block" type="submit" data-testid="submit-repair">{t("i_submit_repair")}</button>
  </form>;
}

/** Today's cancel confirmation (only while the repair is open), posting to the existing cancel action. */
function CancelDialog({ t, ticketId, action }: { t: T; ticketId: string; action: FormAction }) {
  return <div className="t-rp-card" data-testid="repair-cancel-dialog">
    <h2>{t("i_repair_cancel")}</h2>
    <p data-testid="repair-cancel-confirm">{t("i_repair_cancel_confirm")}</p>
    <form action={action}>
      <input type="hidden" name="ticketId" value={ticketId} />
      <button className="btn pri" type="submit" data-testid="repair-cancel-submit">{t("i_repair_cancel")}</button>{" "}
      <Link className="btn sm" href={`/t/repair?id=${ticketId}`} data-testid="repair-cancel-back">{t("i_repair_cancel_back")}</Link>
    </form>
  </div>;
}

/**
 * RT-REPAIR body in its own boundary so the skeleton shows while the readers run (G-LOAD); a failed read is G-ERR.
 * The notices (error banner, sent, cancelled, cancel confirmation), the cancel control and the thread are today's.
 */
async function TenantRepairBody({ session, leaseId, company, params, actions }: Props) {
  const t = makeT(session.locale);
  const view = await tenantRepairView(session, leaseId, params.id);
  if (view.state === "error") {
    return <TenantRepairError locale={session.locale} retryHref={params.id && isUuid(params.id) ? `/t/repair?id=${params.id}` : "/t/repair"} />;
  }
  if (view.state === "list") {
    return <TenantRepairListV3 repairs={view.repairs} locale={session.locale}
      notices={<>
        <ErrorBanner t={t} error={params.error} />
        {params.done ? <div className="alert ok" data-testid="repair-sent"><p>{t("i_repair_success_hint")}</p></div> : null}
      </>}
      empty={{ title: t("i_repair_tenant_empty"), hint: t("i_repair_tenant_empty_hint") }}
      newForm={<NewRepairForm t={t} leaseId={leaseId} action={actions.ticket} />} />;
  }
  const { repair } = view;
  const confirming = params.cancel === "1" && repair.status === "open";
  return <TenantRepairProgressV3 repair={repair} locale={session.locale} calendar={session.calendar} company={company}
    category={{ label: t("i_repair_type"), value: t(REPAIR_CAT_KEY[repair.category] ?? "i_cat_other") }}
    notices={<>
      <ErrorBanner t={t} error={params.error} />
      {params.done ? <div className="alert ok" data-testid="repair-sent">
        <p>{t("i_repair_success_title", { number: repair.number })}</p>
        <p>{t("i_repair_success_hint")}</p>
      </div> : null}
      {params.cancelled === "1" && repair.status === "cancelled" ? <div className="alert ok" data-testid="repair-cancelled-toast">
        {t("i_repair_cancelled_toast", { number: repair.number })}
      </div> : null}
      {confirming ? <CancelDialog t={t} ticketId={repair.id} action={actions.cancel} /> : null}
    </>}
    cancel={repair.status === "open" && !confirming
      ? <p><Link className="t-rp-text" href={`/t/repair?id=${repair.id}&cancel=1`} data-testid="repair-cancel">{t("i_repair_cancel")}</Link></p>
      : repair.status === "cancelled" || confirming ? null
        : <p className="t-rp-muted" data-testid="repair-cancel-locked">{t("i_repair_cancel_locked")}</p>}
    thread={<RepairThread ticketId={repair.id} comments={view.comments} photos={view.photos} t={t} locale={session.locale} calendar={session.calendar}
      canComment canUpload canViewPhotos={true} allowInternal={false} returnTo="tenant" uploadRecovery={view.uploadRecovery} />} />;
}

export function TenantRepairV3Route(props: Props) {
  return <Suspense fallback={<TenantRepairLoading />}><TenantRepairBody {...props} /></Suspense>;
}

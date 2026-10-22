import { dictionary, type T, type Locale } from "@/i18n";
import { actionConfirmVendor, actionDispatchVendor, actionRevokeVendor } from "@/server/actions";
import { formatDate, formatMoney } from "@/server/format";
import type { CalendarMode } from "@/server/types";
import { VENDOR_LINK_DAYS } from "@/server/vendor-repair-rules";
import type { VendorChoice, VendorDispatchView } from "@/server/vendor-repair";
import { VendorLinkField } from "./vendor-link-field";

export function VendorDispatch({
  ticketId,
  canDispatch,
  canConfirm,
  job,
  vendors,
  currency,
  t,
  locale,
  calendar,
}: {
  ticketId: string;
  canDispatch: boolean;
  canConfirm: boolean;
  job: VendorDispatchView | null;
  vendors: VendorChoice[];
  currency: string;
  t: T;
  locale: Locale;
  calendar: CalendarMode;
}) {
  const dict = dictionary(locale);
  const awaiting = Boolean(job?.reported && !job.confirmed && !job.revoked);
  const showForm = canDispatch && (!job || job.revoked || (!job.linkOpen && !awaiting && !job.confirmed));
  const when = job ? formatDate(job.expiresAt, locale, calendar, dict) : "";
  return (
    <section className="card pad" data-testid="vendor-dispatch" style={{ marginTop: 16 }}>
      <h3>{t("i_vendor_dispatch")}</h3>
      <p className="small" data-testid="vendor-record-only">{t("i_vendor_record_only")}</p>
      <p className="small" data-testid="vendor-notify-tenant">{t("i_vendor_notify_tenant")}</p>
      <p className="tiny muted" data-testid="vendor-notify-via">{t("i_vendor_notify_tenant_hint")}</p>
      {job ? (
        <p className="small" data-testid="vendor-job-status">
          {job.confirmed
            ? t("i_vendor_confirmed")
            : job.revoked
              ? t("i_vendor_status_revoked")
              : job.linkOpen
                ? t("i_vendor_status_open", { when })
                : t("i_vendor_status_expired")}
        </p>
      ) : null}
      {job ? (
        <p className="small" data-testid="vendor-job-summary">
          {job.vendorName} · {job.phone}
          <br />
          {job.window}
        </p>
      ) : null}
      {job?.linkOpen && job.link ? (
        <>
          <label className="f">{t("i_vendor_link")}</label>
          <p className="tiny muted">{t("i_vendor_link_hint", { days: VENDOR_LINK_DAYS })}</p>
          <VendorLinkField url={job.link} copyLabel={t("i_vendor_copy")} copiedLabel={t("i_vendor_copied")} />
        </>
      ) : null}
      {job?.reported && job.reportedCost ? (
        <p data-testid="vendor-reported">
          {t("i_vendor_reported")} {formatMoney(job.reportedCost, currency, locale)}
        </p>
      ) : null}
      {job?.confirmed && job.expenseId ? (
        <p data-testid="vendor-confirmed">
          <a href={`/m/expenses/${job.expenseId}`}>{t("i_vendor_confirmed")}</a>
        </p>
      ) : null}
      {awaiting && canConfirm && job ? (
        <form action={actionConfirmVendor}>
          <input type="hidden" name="ticketId" value={ticketId} />
          <input type="hidden" name="jobId" value={job.jobId} />
          <button className="btn pri" type="submit" data-testid="vendor-confirm">
            {t("i_vendor_confirm")}
          </button>
        </form>
      ) : null}
      {job?.linkOpen && canDispatch && !job.confirmed ? (
        <form action={actionRevokeVendor} style={{ marginTop: 8 }}>
          <input type="hidden" name="ticketId" value={ticketId} />
          <input type="hidden" name="jobId" value={job.jobId} />
          <button className="btn sm" type="submit" data-testid="vendor-revoke">
            {t("i_vendor_revoke")}
          </button>
        </form>
      ) : null}
      {showForm ? (
        <form action={actionDispatchVendor} data-testid="vendor-dispatch-form">
          <input type="hidden" name="ticketId" value={ticketId} />
          <div className="fg">
            <label className="f">{t("i_vendor_pick")}</label>
            <select className="inp" name="vendorId" defaultValue="" data-testid="vendor-pick">
              <option value="">{t("i_vendor_choose")}</option>
              {vendors.map((vendor) => (
                <option key={vendor.id} value={vendor.id}>
                  {[vendor.name, vendor.trade, vendor.phone].filter(Boolean).join(" · ")}
                </option>
              ))}
            </select>
          </div>
          <details data-testid="vendor-add-panel">
            <summary data-testid="vendor-add">{t("i_vendor_add")}</summary>
            <div className="fg">
              <label className="f">{t("i_vendor_name")}</label>
              <input className="inp" name="vendorName" defaultValue="" data-testid="vendor-name" />
            </div>
            <div className="fg">
              <label className="f">{t("i_vendor_trade")}</label>
              <input className="inp" name="vendorTrade" defaultValue="" data-testid="vendor-trade" />
            </div>
            <div className="fg">
              <label className="f">{t("i_vendor_phone")}</label>
              <input className="inp" name="vendorPhone" inputMode="tel" defaultValue="" data-testid="vendor-phone" />
            </div>
          </details>
          <div className="fg">
            <label className="f">{t("i_vendor_window")}</label>
            <input className="inp" name="contactWindow" required defaultValue={job?.window ?? ""} data-testid="vendor-window" />
          </div>
          <button className="btn pri" type="submit" data-testid="vendor-dispatch-send">
            {t("i_vendor_dispatch_send")}
          </button>
        </form>
      ) : null}
    </section>
  );
}

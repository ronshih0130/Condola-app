import { dictionary, type T, type Locale } from "@/i18n";
import { actionAddVendor, actionConfirmVendor, actionDispatchVendor, actionRevokeVendor } from "@/server/actions";
import { formatDate, moneyLabel } from "@/server/format";
import type { CalendarMode } from "@/server/types";
import type { VendorChoice, VendorDispatchView } from "@/server/vendor-repair";
import { VENDOR_CATEGORIES, VENDOR_CATEGORY_KEY, VENDOR_LINK_DAYS, vendorMenuLabel } from "@/server/vendor-repair-rules";
import { vendorLinkCopy } from "@/i18n/lanes/vendor-link";
import { actionApproveVendorSharing } from "@/server/vendor-link-actions";
import { VendorLinkField } from "./vendor-link-field";

function vendorOption(vendor: VendorChoice, t: T) {
  const tradeKey = VENDOR_CATEGORY_KEY[vendor.trade as (typeof VENDOR_CATEGORIES)[number]];
  const trade = tradeKey ? t(tradeKey) : vendor.trade;
  const menu = vendorMenuLabel({ name: vendor.name, trade, lastOn: vendor.lastOn });
  if (menu.key === "i_vendor_option_past") {
    return t(menu.key, { name: menu.name, trade: menu.trade, year: menu.year, month: menu.month });
  }
  if (menu.key === "i_vendor_option") return t(menu.key, { name: menu.name, trade: menu.trade });
  return menu.name;
}

export function VendorDispatch({
  ticketId,
  canDispatch,
  canConfirm,
  job,
  vendors,
  currency,
  selectedVendorId,
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
  selectedVendorId: string;
  t: T;
  locale: Locale;
  calendar: CalendarMode;
}) {
  const dict = dictionary(locale);
  const sharingCopy = vendorLinkCopy(locale);
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
      {canDispatch && job?.linkOpen && job.sharing ? (
        <form action={actionApproveVendorSharing} data-testid="vendor-sharing-form" style={{ marginTop: 16 }}>
          <input type="hidden" name="ticketId" value={ticketId} />
          <input type="hidden" name="jobId" value={job.jobId} />
          <h4>{sharingCopy.review}</h4>
          <p className="small">{sharingCopy.guidance}</p>
          {job.sharing.approved ? <p>{sharingCopy.approved}</p> : null}
          <label className="f" htmlFor="vendor-shared-description">{sharingCopy.description}</label>
          <textarea id="vendor-shared-description" className="inp" name="description" defaultValue="" maxLength={10000} />
          <fieldset>
            <legend>{sharingCopy.photos}</legend>
            {job.sharing.photos.map((photo) => (
              <label key={photo.id} className="f">
                <input type="checkbox" name="attachmentIds" value={photo.id} />
                {photo.name}{" "}
                <a href={`/api/tickets/photos/${photo.id}`} target="_blank" rel="noreferrer">{photo.name}</a>
              </label>
            ))}
          </fieldset>
          <button className="btn pri" type="submit">{sharingCopy.approve}</button>
        </form>
      ) : null}
      {job?.reported && job.reportedCost ? (
        <p data-testid="vendor-reported">
          {t("i_vendor_reported")} {moneyLabel(job.reportedCost, currency, locale)}
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
        <>
        <form action={actionDispatchVendor} data-testid="vendor-dispatch-form">
          <input type="hidden" name="ticketId" value={ticketId} />
          {vendors.length === 0 ? (
            <div data-testid="vendor-empty">
              <p>{t("i_vendor_none")}</p>
              <p className="small muted">{t("i_vendor_none_hint")}</p>
            </div>
          ) : null}
          <div className="fg">
            <label className="f">{t("i_vendor_pick")} *</label>
            <select
              className="inp"
              name="vendorId"
              required
              defaultValue={vendors.some((vendor) => vendor.id === selectedVendorId) ? selectedVendorId : ""}
              data-testid="vendor-pick"
            >
              <option value="">{t("i_vendor_choose")}</option>
              {vendors.map((vendor) => (
                <option key={vendor.id} value={vendor.id}>
                  {vendorOption(vendor, t)}
                </option>
              ))}
            </select>
          </div>
          <div className="fg">
            <label className="f">{t("i_vendor_window")}</label>
            <input className="inp" name="contactWindow" required defaultValue={job?.window ?? ""} data-testid="vendor-window" />
          </div>
          <button className="btn pri" type="submit" data-testid="vendor-dispatch-send">
            {t("i_vendor_dispatch_send")}
          </button>
        </form>
        <details data-testid="vendor-add-panel" style={{ marginTop: 12 }}>
          <summary data-testid="vendor-add">{vendors.length === 0 ? t("i_vendor_add_title") : t("i_vendor_add")}</summary>
          <form action={actionAddVendor} data-testid="vendor-add-form">
            <input type="hidden" name="ticketId" value={ticketId} />
            <h3>{t("i_vendor_add_title")}</h3>
            <div className="fg">
              <label className="f">{t("i_vendor_name")} *</label>
              <input className="inp" name="vendorName" required defaultValue="" data-testid="vendor-name" />
            </div>
            <div className="fg">
              <label className="f">{t("i_vendor_trade")} *</label>
              <select className="inp" name="vendorTrade" required defaultValue="" data-testid="vendor-trade">
                <option value="">{t("i_choose")}</option>
                {VENDOR_CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {t(VENDOR_CATEGORY_KEY[category])}
                  </option>
                ))}
              </select>
            </div>
            <div className="fg">
              <label className="f">{t("i_vendor_phone")} *</label>
              <input className="inp" name="vendorPhone" inputMode="tel" required defaultValue="" data-testid="vendor-phone" />
            </div>
            <button className="btn pri" type="submit" data-testid="vendor-add-save">
              {t("i_vendor_add_title")}
            </button>{" "}
            <a className="btn sm" href={`/m/tickets/${ticketId}`}>
              {t("i_cancel")}
            </a>
          </form>
        </details>
        </>
      ) : null}
    </section>
  );
}

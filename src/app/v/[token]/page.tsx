import { VendorNotificationCenterEntry } from "@/components/notification-center-entry";
import { makeT } from "@/i18n";
import { VendorLinkDetails } from "@/components/vendor-link-details";
import { TicketPhotoUpload } from "@/components/ticket-photos";
import { ErrorBanner } from "@/components/ui";
import { actionVendorReport } from "@/server/actions";
import { brandV2Enabled } from "@/server/brand-v2";
import { loadVendorJob } from "@/server/vendor-repair";
import { resolveVendorJobState } from "@/server/vendor-job";
import { requestPrefs } from "@/server/session";
import { VendorJobControls } from "./vendor-job-controls";

export const dynamic = "force-dynamic";

export default async function VendorJobPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const v2 = brandV2Enabled();
  const { token } = await params;
  const query = await searchParams;
  const prefs = await requestPrefs();
  const t = makeT(prefs.locale);
  const job = await loadVendorJob(token);
  if (!job || job.vendorLink?.capability === "invalid") {
    return (
      <div className="card pad" data-testid="vendor-job" style={{ maxWidth: 560, margin: "24px auto" }}>
        <h1>{t("i_vendor_page_title")}</h1>
        <p data-testid="vendor-closed">{t("i_vendor_job_closed")}</p>
      </div>
    );
  }
  const vendorState = await resolveVendorJobState(token);
  const photoMessages = {
    size: t("i_photo_size"),
    type: t("i_photo_type"),
    heic: t("i_photo_heic"),
    storage: t("i_photo_storage"),
    limit: t("i_photo_limit"),
    generic: t("i_generic"),
    internal: t("i_repair_internal"),
    wait: t("i_repair_upload_wait"),
    failed: t("i_repair_photo_failed"),
  };
  function renderReportControls(enhanced = false) {
    const upload = (
      <div style={{ marginTop: 16 }} data-v2-upload={v2 ? "vendor" : undefined}>
        <TicketPhotoUpload
          ticketId=""
          label={t("i_repair_photo_add")}
          chooseLabel={t("i_repair_photo_choose")}
          hint={t("i_repair_photo_hint")}
          allowInternal={false}
          messages={photoMessages}
          signPath="/api/vendor-jobs/photos/sign"
          confirmPath="/api/vendor-jobs/photos/confirm"
          extra={{ token }}
          inputTestId="vendor-photo"
        />
      </div>
    );
    return (
      <>
        {job!.reported ? (
          <p data-testid="vendor-sent" data-v2-status={v2 ? "sent" : undefined}>{t("i_vendor_sent")}</p>
        ) : (
          <form action={actionVendorReport} data-v2-report={v2 ? "vendor" : undefined}>
            <input type="hidden" name="token" value={token} />
            <label className="small">
              <input type="checkbox" name="done" required data-testid="vendor-done" /> {t(enhanced ? "i_vlink_done" : "i_vendor_done")}
            </label>
            <div className="fg">
              <label className="f">
                {t("i_vendor_cost")} ({job!.currency})
              </label>
              <input className="inp" name="cost" inputMode="decimal" required data-testid="vendor-cost" />
            </div>
            {v2 ? upload : null}
            <button className="btn pri" type="submit" data-testid="vendor-submit">
              {t("i_vendor_submit")}
            </button>
          </form>
        )}
        {job!.reported || !v2 ? upload : null}
      </>
    );
  }
  function renderVendorJobControls() {
    if (vendorState === null) return null;
    if (vendorState.locked) {
      return <p data-testid="vendor-pending-approval">{t("i_vendor_pending_owner_approval")}</p>;
    }
    if (job!.vendorLink && (!job!.vendorLink.sharingApproved || job!.vendorLink.capability !== "write")) return null;
    return (
      <VendorJobControls key={vendorState.requestId}
        copy={{ reported: t("i_vendor_reported_awaiting_company"), unavailable: t("i_generic") }}>
        {vendorState.currentEvent === "vendor_completion_submitted"
          ? <p>{t("i_vendor_reported_awaiting_company")}</p> : null}
        <form action="/api/vendor-job-response" method="post">
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="requestId" value={vendorState.requestId} />
          <input type="hidden" name="versionId" value={vendorState.versionId} />
          <input type="hidden" name="action" value="propose" />
          <fieldset>
            <legend>{t("i_vendor_propose_time")}</legend>
            <label>{t("i_vendor_window")} (1)
              <input className="inp" type="datetime-local" name="proposedStart" required />
            </label>
            <label>{t("i_vendor_window")} (2)
              <input className="inp" type="datetime-local" name="proposedEnd" required />
            </label>
          </fieldset>
          <button className="btn pri" type="submit" style={{ minHeight: 44, minWidth: 44 }} data-testid="vendor-propose">
            {t("i_vendor_propose_time")}
          </button>
        </form>
        <form action="/api/vendor-job-response" method="post">
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="requestId" value={vendorState.requestId} />
          <input type="hidden" name="versionId" value={vendorState.versionId} />
          <input type="hidden" name="action" value="reject" />
          <label>{t("i_vendor_reject_reason")}
            <textarea className="inp" name="reason" required maxLength={4000} />
          </label>
          <button className="btn" type="submit" style={{ minHeight: 44, minWidth: 44 }} data-testid="vendor-reject">
            {t("i_vendor_reject")}
          </button>
        </form>
        <form action="/api/vendor-job-completion" method="post">
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="requestId" value={vendorState.requestId} />
          <input type="hidden" name="versionId" value={vendorState.versionId} />
          <input type="hidden" name="action" value="complete" />
          <label>{t("i_vendor_completion_reason")}
            <textarea className="inp" name="reason" required={job!.donePhotos.length === 0} maxLength={4000} />
          </label>
          <button className="btn pri" type="submit" style={{ minHeight: 44, minWidth: 44 }} data-testid="vendor-complete">
            {t("i_vendor_complete")}
          </button>
        </form>
      </VendorJobControls>
    );
  }
  if (job.vendorLink !== undefined) {
    return (
      <VendorLinkDetails
        job={job}
        vendorLink={job.vendorLink}
        token={token}
        t={t}
        locale={prefs.locale}
      >
        <ErrorBanner t={t} error={query.error} />
        <VendorNotificationCenterEntry token={token} locale={prefs.locale} />
        {(vendorState === null || !vendorState.locked) && job.vendorLink.sharingApproved && job.vendorLink.capability === "write" ? renderReportControls(true) : null}
        {renderVendorJobControls()}
      </VendorLinkDetails>
    );
  }
  return (
    <div className="card pad" data-testid="vendor-job" data-v2-page={v2 ? "v-job" : undefined} style={{ maxWidth: 560, margin: "24px auto" }}>
      <h1>{t("i_vendor_page_title")}</h1>
      <VendorNotificationCenterEntry token={token} locale={prefs.locale} />
      <ErrorBanner t={t} error={query.error} />
      <p className="f">{t("i_vendor_address")}</p>
      <p data-testid="vendor-address">{job.address}</p>
      <p className="f">{t("i_vendor_issue")}</p>
      <p data-testid="vendor-issue" data-v2-issue={v2 ? "title" : undefined}>{job.title}</p>
      {job.description ? <p>{job.description}</p> : null}
      <p className="f">{t("i_vendor_window")}</p>
      <p data-testid="vendor-window-view">{job.window}</p>
      <h2>{t("i_vendor_photos")}</h2>
      {job.issuePhotos.length ? (
        <div className="repair-photos">
          {job.issuePhotos.map((photo, index) => (
            // Ticket photos are private objects. The link check happens on this route.
            // eslint-disable-next-line @next/next/no-img-element
            <img key={photo.id} src={`/api/vendor-jobs/${encodeURIComponent(token)}/photos/${photo.id}`} alt={t("i_repair_photo_alt", { n: index + 1 })} data-testid="vendor-issue-photo" />
          ))}
        </div>
      ) : null}
      {job.donePhotos.length ? (
        <>
          <h2>{t("i_vendor_done_photos")}</h2>
          <div className="repair-photos">
            {job.donePhotos.map((photo, index) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={photo.id} src={`/api/vendor-jobs/${encodeURIComponent(token)}/photos/${photo.id}`} alt={t("i_repair_photo_alt", { n: index + 1 })} data-testid="vendor-done-photo" />
            ))}
          </div>
        </>
      ) : null}
      {vendorState === null || !vendorState.locked ? renderReportControls() : null}
      {renderVendorJobControls()}
    </div>
  );
}

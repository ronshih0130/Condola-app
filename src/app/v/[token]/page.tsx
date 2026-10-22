import { makeT } from "@/i18n";
import { TicketPhotoUpload } from "@/components/ticket-photos";
import { ErrorBanner } from "@/components/ui";
import { actionVendorReport } from "@/server/actions";
import { loadVendorJob } from "@/server/vendor-repair";
import { requestPrefs } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function VendorJobPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const query = await searchParams;
  const prefs = await requestPrefs();
  const t = makeT(prefs.locale);
  const job = await loadVendorJob(token);
  if (!job) {
    return (
      <div className="card pad" data-testid="vendor-job" style={{ maxWidth: 560, margin: "24px auto" }}>
        <h1>{t("i_vendor_page_title")}</h1>
        <p data-testid="vendor-closed">{t("i_vendor_job_closed")}</p>
      </div>
    );
  }
  const photoMessages = {
    size: t("i_photo_size"),
    type: t("i_photo_type"),
    storage: t("i_photo_storage"),
    limit: t("i_photo_limit"),
    generic: t("i_generic"),
    internal: t("i_repair_internal"),
  };
  return (
    <div className="card pad" data-testid="vendor-job" style={{ maxWidth: 560, margin: "24px auto" }}>
      <h1>{t("i_vendor_page_title")}</h1>
      <ErrorBanner t={t} error={query.error} />
      <p className="f">{t("i_vendor_address")}</p>
      <p data-testid="vendor-address">{job.address}</p>
      <p className="f">{t("i_vendor_issue")}</p>
      <p data-testid="vendor-issue">{job.title}</p>
      {job.description ? <p>{job.description}</p> : null}
      <p className="f">{t("i_vendor_window")}</p>
      <p data-testid="vendor-window-view">{job.window}</p>
      <h2>{t("i_vendor_photos")}</h2>
      {job.issuePhotos.length ? (
        <div className="repair-photos">
          {job.issuePhotos.map((photo) => (
            // Ticket photos are private objects. The link check happens on this route.
            // eslint-disable-next-line @next/next/no-img-element
            <img key={photo.id} src={`/api/vendor-jobs/${encodeURIComponent(token)}/photos/${photo.id}`} alt={photo.name} data-testid="vendor-issue-photo" />
          ))}
        </div>
      ) : null}
      {job.donePhotos.length ? (
        <>
          <h2>{t("i_vendor_done_photos")}</h2>
          <div className="repair-photos">
            {job.donePhotos.map((photo) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={photo.id} src={`/api/vendor-jobs/${encodeURIComponent(token)}/photos/${photo.id}`} alt={photo.name} data-testid="vendor-done-photo" />
            ))}
          </div>
        </>
      ) : null}
      {job.reported ? (
        <p data-testid="vendor-sent">{t("i_vendor_sent")}</p>
      ) : (
        <form action={actionVendorReport}>
          <input type="hidden" name="token" value={token} />
          <label className="small">
            <input type="checkbox" name="done" required data-testid="vendor-done" /> {t("i_vendor_done")}
          </label>
          <div className="fg">
            <label className="f">
              {t("i_vendor_cost")} ({job.currency})
            </label>
            <input className="inp" name="cost" inputMode="decimal" required data-testid="vendor-cost" />
          </div>
          <button className="btn pri" type="submit" data-testid="vendor-submit">
            {t("i_vendor_submit")}
          </button>
        </form>
      )}
      <div style={{ marginTop: 16 }}>
        <TicketPhotoUpload
          ticketId=""
          label={t("i_repair_photo_add")}
          hint={t("i_repair_photo_hint")}
          allowInternal={false}
          messages={photoMessages}
          signPath="/api/vendor-jobs/photos/sign"
          confirmPath="/api/vendor-jobs/photos/confirm"
          extra={{ token }}
          inputTestId="vendor-photo"
        />
      </div>
    </div>
  );
}

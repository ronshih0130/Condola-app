import type { ReactNode } from "react";
import type { Locale, makeT } from "@/i18n";
import { vendorLinkCopy } from "@/i18n/lanes/vendor-link";
import type { VendorJobPage } from "@/server/vendor-repair";

type Props = {
  job: VendorJobPage;
  vendorLink: NonNullable<VendorJobPage["vendorLink"]>;
  token: string;
  locale: Locale;
  t: ReturnType<typeof makeT>;
  children?: ReactNode;
};

export function VendorLinkDetails({ job, vendorLink, token, t, locale, children }: Props) {
  if (!vendorLink.sharingApproved) {
    return (
      <div className="card pad" data-testid="vendor-job" style={{ maxWidth: 560, margin: "24px auto" }}>
        <h1>{t("i_vlink_title")}</h1>
        <p data-testid="vendor-sharing-waiting">{vendorLinkCopy(locale).waiting}</p>
      </div>
    );
  }
  const readOnly = vendorLink.capability === "read_only";
  return (
    <div
      className="card pad"
      data-testid="vendor-job"
      style={{
        maxWidth: 560,
        margin: "24px auto",
        minWidth: 0,
        overflowWrap: "anywhere",
      }}
    >
      <h1>{t("i_vlink_title")}</h1>
      <p data-testid="vendor-link-status">{t("i_vlink_status")}</p>
      {readOnly ? (
        <p data-testid="vendor-read-only">{t("i_vlink_read_only")}</p>
      ) : null}
      <p className="f">{t("i_vlink_address")}</p>
      <p data-testid="vendor-address">{job.address}</p>
      <p className="f">{t("i_vlink_issue")}</p>
      <p data-testid="vendor-issue">{job.title}</p>
      {job.description ? <p>{job.description}</p> : null}
      <p className="f">{t("i_vlink_window")}</p>
      <p data-testid="vendor-window-view">{job.window}</p>
      {/* The loader supplies renderableTypeFields(...) output only.
          This is the extension point for reviewed per-job-type templates. */}
      {vendorLink.typeFields.length ? (
        <section data-testid="vendor-type-fields">
          <h2>{t("i_vlink_type_fields")}</h2>
          <dl>
            {vendorLink.typeFields.map((field) => (
              <div key={field.key}>
                <dt className="f">{field.label}</dt>
                <dd style={{ marginInlineStart: 0 }}>{field.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
      <h2>{t("i_vlink_photos")}</h2>
      {job.issuePhotos.length ? (
        <div className="repair-photos">
          {job.issuePhotos.map((photo, index) => (
            // Ticket photos remain authorized by the vendor photo route.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={photo.id}
              src={`/api/vendor-jobs/${encodeURIComponent(token)}/photos/${photo.id}`}
              alt={t("i_repair_photo_alt", { n: index + 1 })}
              data-testid="vendor-issue-photo"
              style={{ maxWidth: "100%", height: "auto", minWidth: 0 }}
            />
          ))}
        </div>
      ) : null}
      {job.donePhotos.length ? (
        <>
          <h2>{t("i_vendor_done_photos")}</h2>
          <div className="repair-photos">
            {job.donePhotos.map((photo, index) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={photo.id} src={`/api/vendor-jobs/${encodeURIComponent(token)}/photos/${photo.id}`} alt={t("i_repair_photo_alt", { n: index + 1 })} data-testid="vendor-done-photo" style={{ maxWidth: "100%", height: "auto", minWidth: 0 }} />
            ))}
          </div>
        </>
      ) : null}
      {children}
    </div>
  );
}

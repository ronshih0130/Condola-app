import React from "react";
import type { Locale } from "../../../i18n";
import { vendorCaseCopy } from "../../../i18n/lanes/brand-v3-vendor-case";
import { vendorCaseStage, type CasePhase, type VendorCase } from "../../../server/b105-vendor-case";
import { CaseStyles } from "./vendor-case";
import { VendorCasePhotoUpload } from "./vendor-case-photo-upload";

/**
 * RV-PHOTOS (open: segmented 處理前／處理後, tiles, one solid upload) and RV-PHOTOS-CLOSED (tiles and the
 * GS-51 info line, no button). A tile shows the image only where the existing byte route serves it (own
 * uploads while open; staff-shared photos after close); otherwise the frame's plain tile with the file name.
 */
export function VendorCasePhotos({ locale, token, heading, phase, value, messages }: {
  locale: Locale; token: string; heading: string; phase: CasePhase; value: VendorCase | null;
  messages: { size: string; type: string; heic: string; limit: string };
}) {
  const copy = vendorCaseCopy(locale);
  const path = `/v/${encodeURIComponent(token)}`;
  if (!value) {
    return <>
      <CaseStyles />
      <div className="v-token-lead"><h1>{copy.photos}</h1></div>
      <div className="v-case-error" role="alert">
        <p>{copy.readError}</p>
        <a className="v-token-secondary" href={`${path}/photos?phase=${phase}`}>{copy.retry}</a>
      </div>
    </>;
  }
  const closed = vendorCaseStage(value) === "closed";
  const photos = value.photos.filter(photo => photo.phase === phase);
  const label = phase === "before" ? copy.before : copy.after;
  return <>
    <CaseStyles />
    <div className="v-token-lead"><h1>{copy.photos}</h1></div>
    {closed ? null : <p className="v-case-crumb">{copy.photosCrumb.replace("{job}", heading)}</p>}
    <nav className="v-case-seg" aria-label={copy.photos}>
      {(["before", "after"] as const).map(item => <a key={item} href={`${path}/photos?phase=${item}`}
        aria-current={item === phase ? "page" : undefined}>{item === "before" ? copy.before : copy.after}</a>)}
    </nav>
    <section className="v-token-card v-case-card" aria-label={label} data-phase={phase}>
      <h2>{label}</h2>
      {photos.length ? <ul className="v-case-tiles">
        {photos.map(photo => <li key={photo.id} data-testid="vendor-case-tile">
          {photo.viewable
            // Private ticket photo; the byte route re-checks this bearer, job and case state on every request.
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={`/api/vendor-jobs/${encodeURIComponent(token)}/photos/${photo.id}`} alt={photo.name} />
            : <span className="v-case-ph" aria-hidden="true" />}
          <span>{photo.name}</span>
        </li>)}
      </ul> : null}
      {closed
        ? <p className="v-case-info">{copy.closedInfo.replace("{company}", value.company)}</p>
        : <VendorCasePhotoUpload token={token} phase={phase} label={phase === "before" ? copy.uploadBefore : copy.uploadAfter}
          messages={{ ...messages, saveError: copy.saveError, retry: copy.retry }} />}
    </section>
  </>;
}

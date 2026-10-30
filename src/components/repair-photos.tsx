import * as React from "react";
import type { T } from "@/i18n";

type Photo = { id: string; name: string; internal: boolean };

export function RepairPhotos({
  photos,
  canView,
  t,
}: {
  photos: Photo[];
  canView: boolean;
  t: T;
}) {
  if (photos.length === 0) {
    return <p className="small muted">{t("i_repair_none")}</p>;
  }

  if (!canView) {
    return (
      <div>
        <div data-testid="repair-photo-noperm" className="repair-photo-noperm" role="note">
          <svg
            aria-hidden="true"
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#687384"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="5" y="10" width="14" height="11" rx="2" />
            <path d="M8 10V7a4 4 0 0 1 8 0v3" />
            <circle cx="12" cy="15" r="1" fill="#687384" />
          </svg>
        </div>
        <p className="tiny muted">{t("i_repair_photo_noperm")}</p>
      </div>
    );
  }

  return (
    <div className="repair-photos" data-testid="repair-photos">
      {photos.map((photo, index) => {
        const href = `/api/tickets/photos/${photo.id}`;
        return (
          <a key={photo.id} href={href} target="_blank" rel="noreferrer">
            {/* The browser follows a short-lived signed URL. The image optimizer would re-encode the file on the server. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={href} alt={t("i_repair_photo_alt", { n: index + 1 })} data-testid="repair-photo-preview" />
            <span className="tiny">
              {photo.name}
              {photo.internal ? ` (${t("i_repair_internal")})` : ""}
            </span>
          </a>
        );
      })}
    </div>
  );
}

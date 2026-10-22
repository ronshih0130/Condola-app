import { dictionary, type T, type Locale } from "@/i18n";
import { formatDate } from "@/server/format";
import { statusKey } from "@/components/ui";
import { TicketPhotoUpload } from "@/components/ticket-photos";
import { actionTicketComment } from "@/server/actions";
import type { CalendarMode } from "@/server/types";

type Comment = {
  id: string;
  body: string | null;
  internal: boolean;
  status_from: string | null;
  status_to: string | null;
  at: string;
  author: string;
};

type Photo = { id: string; name: string; internal: boolean };

export function RepairThread({
  ticketId,
  comments,
  photos,
  t,
  locale,
  calendar,
  canComment,
  canUpload,
  allowInternal,
  returnTo,
}: {
  ticketId: string;
  comments: Comment[];
  photos: Photo[];
  t: T;
  locale: Locale;
  calendar: CalendarMode;
  canComment: boolean;
  canUpload: boolean;
  allowInternal: boolean;
  returnTo: "tenant" | "staff";
}) {
  const dict = dictionary(locale);
  return (
    <div>
      <h3>{t("i_repair_timeline")}</h3>
      {comments.length === 0 ? (
        <p className="small muted">{t("i_repair_none")}</p>
      ) : (
        <ol className="repair-timeline" data-testid="repair-timeline">
          {comments.map((comment) => {
            const status =
              comment.status_to && !comment.status_from
                ? t("i_repair_filed")
                : comment.status_to
                  ? `${t(statusKey(comment.status_from || ""))} → ${t(statusKey(comment.status_to))}`
                  : "";
            return (
              <li key={comment.id} data-testid={`repair-event-${comment.id}`}>
                <div className="small muted">
                  {formatDate(comment.at, locale, calendar, dict)}
                  {comment.internal
                    ? ` · ${comment.author ? t("i_repair_internal_by", { author: comment.author }) : t("i_repair_internal")}`
                    : comment.author
                      ? ` · ${comment.author}`
                      : ""}
                </div>
                {status ? <div>{status}</div> : null}
                {comment.body ? <div>{comment.body}</div> : null}
              </li>
            );
          })}
        </ol>
      )}
      {canComment ? (
        <form action={actionTicketComment} style={{ marginTop: 12 }}>
          <input type="hidden" name="ticketId" value={ticketId} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <div className="fg">
            <label className="f">{t("i_repair_comment")}</label>
            <textarea className="inp" name="body" data-testid="repair-comment" placeholder={t("i_repair_comment_ph")} required />
          </div>
          {allowInternal ? (
            <label className="small">
              <input type="checkbox" name="internal" /> {t("i_repair_internal")}
              <div className="tiny muted">{t("i_repair_internal_hint")}</div>
            </label>
          ) : null}
          <button className="btn sm" type="submit" data-testid="repair-comment-send">
            {t("i_repair_comment_send")}
          </button>
        </form>
      ) : null}
      <h3 style={{ marginTop: 16 }}>{t("i_repair_photos")}</h3>
      {photos.length ? (
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
      ) : (
        <p className="small muted">{t("i_repair_none")}</p>
      )}
      {canUpload ? (
        <TicketPhotoUpload
          ticketId={ticketId}
          label={t("i_repair_photo_add")}
          hint={t("i_repair_photo_hint")}
          allowInternal={allowInternal}
          messages={{
            size: t("i_photo_size"),
            type: t("i_photo_type"),
            heic: t("i_photo_heic"),
            storage: t("i_photo_storage"),
            limit: t("i_photo_limit"),
            generic: t("i_generic"),
            internal: t("i_repair_internal"),
            internalHint: t("i_repair_internal_hint"),
            wait: t("i_repair_upload_wait"),
            failed: t("i_repair_photo_failed"),
          }}
        />
      ) : null}
    </div>
  );
}

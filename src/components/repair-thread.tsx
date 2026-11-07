import { dictionary, type T, type Locale } from "@/i18n";
import { formatDate } from "@/server/format";
import { statusKey } from "@/components/ui";
import { TicketPhotoUpload } from "@/components/ticket-photos";
import { TicketPhotoBatchUpload } from "@/components/ticket-photo-batch";
import { uploadRecoveryCopy } from "@/i18n/upload-recovery";
import type { UploadRecoveryView } from "@/lib/upload-recovery-types";
import { RepairPhotos } from "@/components/repair-photos";
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
  canViewPhotos,
  allowInternal,
  returnTo,
  uploadRecovery = null,
}: {
  ticketId: string;
  comments: Comment[];
  photos: Photo[];
  t: T;
  locale: Locale;
  calendar: CalendarMode;
  canComment: boolean;
  canUpload: boolean;
  canViewPhotos: boolean;
  allowInternal: boolean;
  returnTo: "tenant" | "staff";
  /** B-031 UPLOAD_RECOVERY: null (flag OFF) keeps the existing single-photo uploader unchanged. */
  uploadRecovery?: UploadRecoveryView;
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
      <RepairPhotos photos={photos} canView={canViewPhotos} t={t} />
      {canUpload && uploadRecovery ? (
        <TicketPhotoBatchUpload
          ticketId={ticketId}
          label={t("i_repair_photo_add")}
          chooseLabel={t("i_repair_photo_choose")}
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
          }}
          copy={uploadRecoveryCopy(locale)}
          draft={uploadRecovery.draft}
        />
      ) : canUpload ? (
        <TicketPhotoUpload
          ticketId={ticketId}
          label={t("i_repair_photo_add")}
          chooseLabel={t("i_repair_photo_choose")}
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

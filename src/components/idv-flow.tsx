"use client";

import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import { IdKeepNotice } from "./id-keep";
import { IdPhotoError, prepareIdPhoto } from "@/lib/id-photo";
import { idFileAllowed } from "@/lib/jpeg-size";
import {
  isValidIdNumber,
  maskIdNumber,
  requiredSlots,
  SAMPLE_JPEG_BASE64,
  type IdDocType,
  type IdSlot,
} from "@/lib/idv";
import { NOTICE_LINK_LABEL, splitNoticeLink } from "@/lib/id-notice-display";
import { idClientCompresses } from "@/lib/id-compress";
import { ID_UPLOAD_ESTIMATE_SECONDS, idUploadShowsWaitNote } from "@/lib/id-upload-estimate";
import { useLocale, useT } from "./locale";

type Shot = { url: string; glare: boolean };

export function IdvFlow({
  leaseId,
  status,
  docType,
  numberMasked,
  returnReason,
  photoUrls,
  demo,
  sent,
  notice,
  agreeLabel,
  noticeUrl,
  compress,
}: {
  leaseId: string;
  status: "missing" | "pending_review" | "checked" | "returned";
  docType: IdDocType | null;
  numberMasked: string | null;
  returnReason: string | null;
  photoUrls: { slot: IdSlot; url: string; watermark: string }[];
  demo: boolean;
  sent: boolean;
  notice: string;
  agreeLabel: string;
  noticeUrl: string;
  compress: boolean;
}) {
  const t = useT();
  const locked = status === "pending_review" || status === "checked";
  if (locked) {
    return (
      <div>
        <h2>{t("idv_title")}</h2>
        {sent ? <div className="alert ok" data-testid="idv-toast">{t("idv_sent_toast")}</div> : null}
        <p>{status === "checked" ? t("idv_ten_ok") : t("idv_ten_pending")}</p>
        <p>
          <span className={`chip ${status === "checked" ? "ok" : "warn"}`} data-testid="idv-status">
            {status === "checked" ? t("idv_st_ok") : t("idv_st_pending")}
          </span>
        </p>
        {numberMasked ? <p data-testid="idv-masked">{numberMasked}</p> : null}
        <IdKeepNotice link={noticeUrl} />
        <div className="idv-shots">
          {photoUrls.map((photo) => (
            <div key={photo.slot} className="idv-shot">
              <img src={photo.url} alt="" />
              <div className="idv-watermark" data-testid="idv-watermark">
                {photo.watermark}
              </div>
            </div>
          ))}
        </div>
        <p style={{ marginTop: 12 }}>
          <Link className="btn pri block" href="/t/lease">
            {t("idv_to_sign")}
          </Link>
        </p>
      </div>
    );
  }

  return (
    <Wizard
      leaseId={leaseId}
      notice={notice}
      agreeLabel={agreeLabel}
      noticeUrl={noticeUrl}
      demo={demo}
      compress={compress}
      returned={status === "returned" ? returnReason : null}
      initialType={docType ?? "tw_national_id"}
    />
  );
}

function Wizard({
  leaseId,
  notice,
  agreeLabel,
  noticeUrl,
  demo,
  compress,
  returned,
  initialType,
}: {
  leaseId: string;
  notice: string;
  agreeLabel: string;
  noticeUrl: string;
  demo: boolean;
  compress: boolean;
  returned: string | null;
  initialType: IdDocType;
}) {
  const t = useT();
  const locale = useLocale();
  const [step, setStep] = useState(1);
  const [agreed, setAgreed] = useState(false);
  const [docType, setDocType] = useState<IdDocType>(initialType);
  const [shots, setShots] = useState<Partial<Record<IdSlot, Shot>>>({});
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const busyRef = useRef(false);
  const queueRef = useRef<{ slot: IdSlot; file: File }[]>([]);
  const [number, setNumber] = useState("");
  const steps = [t("idv_s_consent"), t("idv_s_doc"), t("idv_s_selfie"), t("idv_s_review")];
  const slots = requiredSlots(docType);
  const docSlots = slots.filter((slot) => slot !== "selfie");
  const masked = number.trim() ? maskIdNumber(number) : "";
  const compressPhotos = compress || idClientCompresses();
  const photosReady = slots.every((slot) => shots[slot]?.url);
  const numberOk = isValidIdNumber(docType, number);
  const busy = processing || submitting;

  async function prepare(slot: IdSlot, file: File) {
    const prepared = await prepareIdPhoto(file, [], { compress: compressPhotos });
    setShots((current) => ({ ...current, [slot]: { url: prepared.dataUrl, glare: prepared.glare } }));
  }

  function photoMessage(error: unknown) {
    const code = error instanceof IdPhotoError ? error.code : "open";
    return code === "big" ? t("idv_photo_big") : t("idv_photo_open");
  }

  async function drain() {
    if (busyRef.current) return;
    const job = queueRef.current.shift();
    if (!job) {
      setProcessing(false);
      return;
    }
    busyRef.current = true;
    setProcessing(true);
    setPhotoError(null);
    try {
      await prepare(job.slot, job.file);
    } catch (error) {
      setPhotoError(photoMessage(error));
    } finally {
      busyRef.current = false;
      void drain();
    }
  }

  async function take(slot: IdSlot, file: File | undefined) {
    if (!file) return;
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    if (!idFileAllowed(file.type, head)) {
      setPhotoError(t("i_id_photo_type"));
      return;
    }
    queueRef.current.push({ slot, file });
    void drain();
  }

  function useSample() {
    const binary = atob(SAMPLE_JPEG_BASE64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const file = new File([bytes], "sample.jpg", { type: "image/jpeg" });
    for (const slot of slots) queueRef.current.push({ slot, file });
    void drain();
  }

  async function abandonUpload() {
    await fetch("/api/id-documents/finalize", {
      method: "DELETE",
      headers: { "x-id-lease": leaseId },
    }).catch(() => undefined);
  }

  function keepShots() {
    setSubmitError(t("i_id_submit_retry"));
    busyRef.current = false;
    setSubmitting(false);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current || queueRef.current.length > 0 || !photosReady || !numberOk || !agreed) return;
    busyRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    try {
      for (const slot of requiredSlots(docType)) {
        const shot = shots[slot]?.url;
        if (!shot) throw new Error("missing photo");
        const blob = await (await fetch(shot)).blob();
        const uploaded = await fetch("/api/id-documents/photo", {
          method: "POST",
          headers: {
            "content-type": blob.type || "image/jpeg",
            "x-id-slot": slot,
            "x-id-lease": leaseId,
          },
          body: blob,
        });
        if (!uploaded.ok) {
          await abandonUpload();
          keepShots();
          return;
        }
      }
      const finalized = await fetch("/api/id-documents/finalize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ leaseId, docType, number, consent: agreed }),
      });
      if (!finalized.ok) {
        await abandonUpload();
        keepShots();
        return;
      }
      window.location.assign("/t/id?sent=1");
    } catch {
      await abandonUpload();
      keepShots();
    }
  }

  function choose(next: IdDocType) {
    setDocType(next);
  }

  function slotName(slot: IdSlot) {
    if (slot === "selfie") return t("idv_selfie");
    if (slot === "back") return t("idv_back");
    return docType === "passport" ? t("idv_photo") : t("idv_front");
  }

  function missingText(required: IdSlot[]) {
    const missing = required.filter((slot) => !shots[slot]?.url);
    if (!missing.length) return null;
    const names = missing.map((slot) => slotName(slot)).join(locale === "en" ? ", " : "、");
    return (
      <p className="small" data-testid="idv-missing">
        {t("idv_need_both", { missing: names })}
      </p>
    );
  }

  const consent = step === 1;
  return (
    <form className={consent ? "idv-task" : undefined} onSubmit={onSubmit}>
      <div className={consent ? "idv-task-scroll" : undefined}>
      <h2>{t("idv_title")}</h2>
      <p className="small">{t("idv_intro")}</p>
      <div className="steps" data-testid="idv-steps">
        {steps.map((label, index) => (
          <span key={label} className={`s${step === index + 1 ? " on" : ""}`}>
            {index + 1}. {label}
          </span>
        ))}
      </div>
      {returned ? (
        <div className="alert bad" data-testid="idv-returned">
          {t("idv_ten_returned", { r: returned })}
        </div>
      ) : null}
      {busy ? (
        <div className="alert" data-testid="idv-processing" role="status">
          <div>{t("idv_processing")}</div>
          {submitting && idUploadShowsWaitNote() ? (
            <div data-testid="idv-upload-wait">{t("idv_upload_wait", { seconds: ID_UPLOAD_ESTIMATE_SECONDS })}</div>
          ) : null}
        </div>
      ) : null}
      <input type="hidden" name="leaseId" value={leaseId} />
      <input type="hidden" name="docType" value={docType} />
      <input type="hidden" name="consent" value={agreed ? "on" : ""} />
      <input type="hidden" name="front" value={shots.front?.url ?? ""} />
      <input type="hidden" name="back" value={docType === "passport" ? "" : (shots.back?.url ?? "")} />
      <input type="hidden" name="selfie" value={shots.selfie?.url ?? ""} />

      {consent ? (
        <section id="idvConsent">
          <h3>{t("idv_notice_h")}</h3>
          <p id="idvNotice"><NoticeText text={notice} url={noticeUrl} /></p>
        </section>
      ) : null}

      {step === 2 ? (
        <section id="idvDoc">
          <div className="seg idv-seg" role="radiogroup" aria-label={t("idv_s_doc")}>
            {(
              [
                ["tw_national_id", "idv_doc_nid"],
                ["arc_resident_cert", "idv_doc_arc"],
                ["passport", "idv_doc_passport"],
              ] as const
            ).map(([value, key]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={docType === value}
                className={docType === value ? "on" : ""}
                disabled={busy}
                onClick={() => choose(value)}
              >
                {t(key)}
              </button>
            ))}
          </div>
          <p className="small">{docType === "passport" ? t("idv_doc_hint_pp") : t("idv_doc_hint_2")}</p>
          {photoError ? (
            <div className="alert bad" data-testid="idv-photo-error">
              {photoError}
            </div>
          ) : null}
          <ul className="small">
            <li>{t("idv_tip_corners")}</li>
            <li>{t("idv_tip_glare")}</li>
            <li>{t("idv_tip_blur")}</li>
            <li>{t("idv_tip_fingers")}</li>
          </ul>
          <p className="small" data-testid="idv-file-hint">
            {t("idv_file_hint")}
          </p>
          {missingText(docSlots)}
          {docSlots.map((slot) => (
            <SlotCapture
              key={slot}
              slot={slot}
              label={slot === "back" ? t("idv_back") : docType === "passport" ? t("idv_photo") : t("idv_front")}
              shot={shots[slot]}
              capture="environment"
              frame="doc"
              busy={busy}
              onFile={(file) => take(slot, file)}
              onRetake={() => setShots((current) => ({ ...current, [slot]: undefined }))}
            />
          ))}
          {demo ? (
            <button className="btn block" type="button" data-testid="idv-sample" disabled={busy} onClick={useSample}>
              {t("i_id_sample")}
            </button>
          ) : null}
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn" type="button" disabled={busy} onClick={() => setStep(1)}>
              {t("s_5bf6faa")}
            </button>
            <button
              className="btn pri"
              type="button"
              data-testid="idv-doc-next"
              disabled={busy || !docSlots.every((slot) => shots[slot]?.url)}
              onClick={() => setStep(3)}
            >
              {t("idv_s_selfie")}
            </button>
          </div>
        </section>
      ) : null}

      {step === 3 ? (
        <section id="idvSelfie">
          {photoError ? (
            <div className="alert bad" data-testid="idv-photo-error">
              {photoError}
            </div>
          ) : null}
          <ul className="small">
            <li>{t("idv_tip_face")}</li>
            <li>{t("idv_tip_hold")}</li>
            <li>{t("idv_tip_light")}</li>
          </ul>
          <p className="small" data-testid="idv-file-hint">
            {t("idv_file_hint")}
          </p>
          {missingText(["selfie"])}
          <SlotCapture
            slot="selfie"
            label={t("idv_selfie")}
            shot={shots.selfie}
            capture="user"
            frame="selfie"
            busy={busy}
            onFile={(file) => take("selfie", file)}
            onRetake={() => setShots((current) => ({ ...current, selfie: undefined }))}
          />
          {demo ? (
            <button className="btn block" type="button" disabled={busy} onClick={useSample}>
              {t("i_id_sample")}
            </button>
          ) : null}
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn" type="button" disabled={busy} onClick={() => setStep(2)}>
              {t("s_5bf6faa")}
            </button>
            <button className="btn pri" type="button" data-testid="idv-selfie-next" disabled={busy || !shots.selfie?.url} onClick={() => setStep(4)}>
              {t("idv_s_review")}
            </button>
          </div>
        </section>
      ) : null}

      {step === 4 ? (
        <section id="idvReview">
          <div className="idv-shots">
            {slots.map((slot) => (
              <button key={slot} className="idv-shot btn" type="button" disabled={busy} onClick={() => setStep(slot === "selfie" ? 3 : 2)}>
                {shots[slot]?.url ? <img src={shots[slot]?.url} alt="" /> : null}
                <span>{t("idv_retake")}</span>
              </button>
            ))}
          </div>
          <div className="fg">
            <label className="f" htmlFor="idv-number">
              {docType === "passport" ? t("idv_num_pp") : t("idv_num")}
            </label>
            <input
              id="idv-number"
              className="inp"
              name="number"
              data-testid="idv-number"
              value={number}
              autoComplete="off"
              disabled={busy}
              onChange={(event) => setNumber(event.target.value.toUpperCase())}
            />
            <p className="hint">{t("idv_num_hint")}</p>
            {masked ? (
              <p data-testid="idv-mask-preview">
                {t("idv_num_mask", { m: masked })}
              </p>
            ) : null}
          </div>
          {missingText(slots)}
          <p className="small">{t("idv_after_submit")}</p>
          <p className="small">{t("idv_viewonly")}</p>
          {submitError ? (
            <div className="alert bad" data-testid="idv-submit-error">
              {submitError}
            </div>
          ) : null}
          <div className="row">
            <button className="btn" type="button" disabled={busy} onClick={() => setStep(3)}>
              {t("s_5bf6faa")}
            </button>
            <button className="btn pri" type="submit" data-testid="idv-submit" disabled={busy || !photosReady || !numberOk || !agreed} aria-busy={submitting || undefined}>
              {submitting ? t("idv_processing") : t("idv_submit")}
            </button>
          </div>
        </section>
      ) : null}
      </div>
      {consent ? (
        <div className="idv-dock" data-testid="idv-consent-bar">
          <label className="radio">
            <input
              id="idvAgree"
              type="checkbox"
              checked={agreed}
              onChange={(event) => setAgreed(event.target.checked)}
            />
            <span>{agreeLabel}</span>
          </label>
          <button className="btn pri block" type="button" data-testid="idv-start" disabled={!agreed || busy} onClick={() => setStep(2)}>
            {t("idv_start")}
          </button>
        </div>
      ) : null}
    </form>
  );
}

function NoticeText({ text, url }: { text: string; url: string }) {
  const parts = splitNoticeLink(text, url);
  return (
    <>
      {parts.before}
      <Link href={url}>{NOTICE_LINK_LABEL}</Link>
      {parts.after}
    </>
  );
}

function SlotCapture({
  slot,
  label,
  shot,
  capture,
  frame,
  busy,
  onFile,
  onRetake,
}: {
  slot: IdSlot;
  label: string;
  shot?: Shot;
  capture: "environment" | "user";
  frame: "doc" | "selfie";
  busy: boolean;
  onFile: (file: File | undefined) => void;
  onRetake: () => void;
}) {
  const t = useT();
  return (
    <div className="fg">
      <div className="f">{label}</div>
      <div className={`idv-frame ${frame}`}>
        {shot?.url ? <img src={shot.url} alt="" data-testid={`idv-preview-${slot}`} /> : frame === "selfie" ? <div className="idv-oval" /> : <span>{t("idv_frame_doc")}</span>}
        {frame === "doc" ? (
          <span className="idv-guides" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
        ) : null}
        {frame === "selfie" && !shot?.url ? <span className="idv-frame-caption">{t("idv_frame_selfie")}</span> : null}
      </div>
      {shot?.glare ? (
        <p className="alert warn" data-testid={`idv-glare-${slot}`}>
          {t("idv_glare_warn")}
        </p>
      ) : null}
      {shot?.url ? (
        <button className="btn" type="button" data-testid={`idv-${slot}-retake`} disabled={busy} onClick={onRetake}>
          ↺ {t("idv_retake")}
        </button>
      ) : (
        <div className="idv-actions">
          <label className="btn">
            📷 {t("idv_camera")}
            <input
              className="idv-file"
              type="file"
              accept="image/jpeg,image/png"
              capture={capture}
              data-testid={`idv-${slot}-camera`}
              disabled={busy}
              onChange={(event) => onFile(event.target.files?.[0])}
            />
          </label>
          <label className="btn">
            ⬆ {t("idv_upload")}
            <input
              className="idv-file"
              type="file"
              accept="image/jpeg,image/png"
              data-testid={`idv-${slot}-upload`}
              disabled={busy}
              onChange={(event) => onFile(event.target.files?.[0])}
            />
          </label>
        </div>
      )}
    </div>
  );
}

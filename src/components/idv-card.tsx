"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { actionMarkIdChecked, actionReturnId, actionViewIdPhotos } from "@/server/actions";
import { IdKeepNotice } from "./id-keep";
import { errorText } from "@/i18n/errors";
import { type IdCheckView, type IdDocType, type IdSlot } from "@/lib/idv";
import { useT } from "./locale";

const DOC_KEY: Record<IdDocType, string> = {
  tw_national_id: "idv_doc_nid",
  arc_resident_cert: "idv_doc_arc",
  passport: "idv_doc_passport",
};

type ShotPhase = "loading" | "ready" | "error";

type ShotState = {
  slot: IdSlot;
  url: string;
  watermark: string;
  phase: ShotPhase;
};

function slotLabel(slot: IdSlot, docType: IdDocType | null) {
  if (slot === "front") return docType === "passport" ? "idv_photo" : "idv_front";
  if (slot === "back") return "idv_back";
  return "idv_selfie";
}

function IdPhoto({
  shot,
  onPhase,
}: {
  shot: ShotState;
  onPhase: (slot: IdSlot, url: string, phase: "ready" | "error") => void;
}) {
  const ref = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const img = ref.current;
    if (!img || shot.phase !== "loading" || !shot.url) return;
    if (img.complete && img.naturalWidth > 0) onPhase(shot.slot, shot.url, "ready");
    else if (img.complete && img.naturalWidth === 0) onPhase(shot.slot, shot.url, "error");
  }, [onPhase, shot.phase, shot.slot, shot.url]);
  if (!shot.url) return null;
  return (
    <img
      ref={ref}
      src={shot.url}
      alt=""
      data-testid={`idv-photo-${shot.slot}`}
      className={shot.phase === "ready" ? undefined : "is-pending"}
      onLoad={() => onPhase(shot.slot, shot.url, "ready")}
      onError={() => onPhase(shot.slot, shot.url, "error")}
    />
  );
}

export function IdvCard({ check, toast }: { check: IdCheckView; toast?: string }) {
  const t = useT();
  const router = useRouter();
  const statusKey =
    check.status === "pending_review"
      ? "idv_st_pending"
      : check.status === "checked"
        ? "idv_st_ok"
        : check.status === "returned"
          ? "idv_st_returned"
          : "idv_st_none";
  const chip = check.status === "checked" ? "ok" : check.status === "returned" ? "bad" : check.status === "pending_review" ? "warn" : "";
  const [open, setOpen] = useState(false);
  const [shots, setShots] = useState<ShotState[]>([]);
  const [logged, setLogged] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const reloadGen = useRef<Partial<Record<IdSlot, number>>>({});

  const onPhase = useCallback((slot: IdSlot, url: string, phase: "ready" | "error") => {
    setShots((current) => current.map((shot) => (shot.slot === slot && shot.url === url ? { ...shot, phase } : shot)));
  }, []);

  async function review(
    action: (formData: FormData) => Promise<{ error: string } | void>,
    formData: FormData,
    query: string,
  ) {
    const result = await action(formData);
    if (result?.error) {
      setError(errorText(t, result.error));
      return;
    }
    router.replace(`/m/leases/${check.leaseId}?${query}`);
    router.refresh();
  }

  async function view() {
    if (!check.documentId) return;
    setError("");
    const result = await actionViewIdPhotos(check.documentId);
    if ("error" in result) {
      setError(errorText(t, result.error));
      return;
    }
    setShots(result.shots.map((shot) => ({ ...shot, phase: "loading" as const })));
    setLogged(result.logged);
    setOpen(true);
  }

  async function reload(slot: IdSlot) {
    if (!check.documentId) return;
    const previous = shots.find((shot) => shot.slot === slot)?.url ?? "";
    const gen = (reloadGen.current[slot] ?? 0) + 1;
    reloadGen.current[slot] = gen;
    setShots((current) => current.map((shot) => (shot.slot === slot ? { ...shot, phase: "loading", url: "" } : shot)));
    const result = await actionViewIdPhotos(check.documentId);
    if (reloadGen.current[slot] !== gen) return;
    if ("error" in result) {
      setShots((current) => current.map((shot) => (shot.slot === slot ? { ...shot, phase: "error", url: "" } : shot)));
      return;
    }
    const fresh = result.shots.find((shot) => shot.slot === slot);
    if (!fresh || fresh.url === previous) {
      setShots((current) => current.map((shot) => (shot.slot === slot ? { ...shot, phase: "error", url: "" } : shot)));
      return;
    }
    setShots((current) =>
      current.map((shot) =>
        shot.slot === slot ? { slot, url: fresh.url, watermark: fresh.watermark, phase: "loading" } : shot,
      ),
    );
  }

  return (
    <div className="card pad" id="idvCard" data-testid="idv-card">
      <div className="row">
        <h3>{t("idv_mgr_h")}</h3>
        <span className="sp" />
        <span className={`chip ${chip}`} data-testid="idv-status">
          {t(statusKey)}
        </span>
      </div>
      {toast ? (
        <div className="alert ok" data-testid="idv-toast">
          {toast}
        </div>
      ) : null}
      {error ? <div className="alert bad">{error}</div> : null}
      {check.status === "missing" ? <p>{t("idv_none_mgr")}</p> : null}
      {check.docType ? <p>{t(DOC_KEY[check.docType])}</p> : null}
      {check.numberMasked ? <p data-testid="idv-masked">{check.numberMasked}</p> : null}
      {check.uploadedAt ? <p className="small">{t("idv_at", { t: check.uploadedAt })}</p> : null}
      {check.isSample ? <span className="chip">{t("idv_sample_chip")}</span> : null}
      {check.returnReason ? (
        <p data-testid="idv-return-reason">
          {t("idv_reason")}：{check.returnReason}
        </p>
      ) : null}
      <IdKeepNotice />
      {check.documentId && check.status !== "missing" ? (
        <div className="idv-actions" style={{ marginTop: 8 }}>
          <button className="btn" type="button" data-testid="idv-view" onClick={view}>
            🔒 {t("idv_view")}
          </button>
          {check.status === "pending_review" ? (
            <form action={(formData) => review(actionMarkIdChecked, formData, "idv=ok")}>
              <input type="hidden" name="leaseId" value={check.leaseId} />
              <input type="hidden" name="documentId" value={check.documentId} />
              <button className="btn pri" type="submit" data-testid="idv-mark-checked">
                {t("idv_btn_ok")}
              </button>
            </form>
          ) : null}
        </div>
      ) : null}
      {check.documentId && check.status === "pending_review" ? (
        <form action={(formData) => review(actionReturnId, formData, "idv=returned")} style={{ marginTop: 12 }}>
          <input type="hidden" name="leaseId" value={check.leaseId} />
          <input type="hidden" name="documentId" value={check.documentId} />
          <label className="f" htmlFor="idv-reason">
            {t("idv_reason")}
          </label>
          <textarea
            id="idv-reason"
            className="inp"
            name="reason"
            data-testid="idv-return-reason-input"
            placeholder={t("idv_reason_ph")}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <button className="btn danger" type="submit" data-testid="idv-return" disabled={!reason.trim()} style={{ marginTop: 8 }}>
            {t("idv_btn_return")}
          </button>
        </form>
      ) : null}
      {open ? (
        <div className="modal-bg" role="dialog" data-testid="idv-modal">
          <div className="modal">
            <div className="hd">
              <h3>
                {t("idv_mgr_h")} · {check.tenantName}
              </h3>
              <span className="sp" />
              <button className="btn ghost" type="button" onClick={() => setOpen(false)}>
                {t("i_close")}
              </button>
            </div>
            <div className="bd">
              <p className="small" data-testid="idv-logged">
                {t("idv_logged")}
              </p>
              {logged ? <p className="small muted" data-testid="idv-audit-reason">{logged}</p> : null}
              {shots.map((shot) => (
                <div key={shot.slot} className="idv-shot">
                  <div className="f" data-testid={`idv-slot-${shot.slot}`}>
                    {t(slotLabel(shot.slot, check.docType))}
                  </div>
                  <div className="idv-photo-frame">
                    <IdPhoto shot={shot} onPhase={onPhase} />
                    {shot.phase === "loading" ? (
                      <div className="idv-photo-status" data-testid={`idv-photo-loading-${shot.slot}`}>
                        {t("idv_photo_loading")}
                      </div>
                    ) : null}
                    {shot.phase === "error" ? (
                      <div className="idv-photo-status" data-testid={`idv-photo-error-${shot.slot}`}>
                        <p>{t("idv_photo_error")}</p>
                        <button className="btn" type="button" data-testid={`idv-photo-retry-${shot.slot}`} onClick={() => reload(shot.slot)}>
                          {t("idv_photo_retry")}
                        </button>
                      </div>
                    ) : null}
                    <div className="idv-watermark" data-testid="idv-watermark" hidden={shot.phase !== "ready"}>
                      {shot.watermark}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

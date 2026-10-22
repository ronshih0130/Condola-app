"use client";

import { useState } from "react";
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
  const [shots, setShots] = useState<{ slot: IdSlot; url: string; watermark: string }[]>([]);
  const [logged, setLogged] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");

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
    setShots(result.shots);
    setLogged(result.logged);
    setOpen(true);
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
                    {t(
                      shot.slot === "front"
                        ? check.docType === "passport"
                          ? "idv_photo"
                          : "idv_front"
                        : shot.slot === "back"
                          ? "idv_back"
                          : "idv_selfie",
                    )}
                  </div>
                  <img src={shot.url} alt="" data-testid={`idv-photo-${shot.slot}`} />
                  <div className="idv-watermark" data-testid="idv-watermark">
                    {shot.watermark}
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

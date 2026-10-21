"use client";

import { useRef, useState } from "react";
import { ImplicitSubmitSink, blockImplicitEnter } from "./form-enter";
import { PendingSubmit } from "./pending-submit";
import { useT } from "./locale";
import { actionCreateFirm } from "@/server/signup-actions";

export function FirmSteps({ partnerCode, error }: { partnerCode: string; error?: string }) {
  const t = useT();
  const [step, setStep] = useState<3 | 4>(3);
  const [kind, setKind] = useState<"firm" | "self" | "">("");
  const [nameError, setNameError] = useState(false);
  const [contactError, setContactError] = useState(false);
  const [submitReady, setSubmitReady] = useState(false);
  const armSubmit = useRef<number | null>(null);

  function goDetails() {
    setSubmitReady(false);
    if (armSubmit.current) window.clearTimeout(armSubmit.current);
    armSubmit.current = window.setTimeout(() => setSubmitReady(true), 600);
    setStep(4);
  }

  return (
    <form
      noValidate
      action={actionCreateFirm}
      className="col"
      data-testid="firm-form"
      onKeyDownCapture={blockImplicitEnter}
      onSubmit={(event) => {
        const submitter = (event.nativeEvent as SubmitEvent).submitter;
        if (step !== 4 || !submitReady || !(submitter instanceof HTMLButtonElement) || submitter.dataset.testid !== "firm-submit") {
          event.preventDefault();
          return;
        }
        const data = new FormData(event.currentTarget);
        const name = String(data.get("name") ?? "").trim();
        const contact = String(data.get("contactName") ?? "").trim();
        const needName = kind === "firm" && name === "";
        const needContact = contact === "";
        setNameError(needName);
        setContactError(needContact);
        if (needName || needContact) event.preventDefault();
      }}
    >
      <ImplicitSubmitSink />
      <ol className="steps" data-testid="signup-steps">
        <li className="on">1</li>
        <li className="on">2</li>
        <li className={step >= 3 ? "on" : ""}>3</li>
        <li className={step >= 4 ? "on" : ""}>4</li>
      </ol>
      <p className="small muted" data-testid="signup-step-label">{t("i_signup_step", { n: step })}</p>
      <h1>{step === 3 ? t("i_signup_kind_title") : t("i_signup_firm_details")}</h1>
      {error ? <div className="alert bad">{t("i_required")}</div> : null}
      <input type="hidden" name="kind" value={kind} />
      {step === 3 ? (
        <fieldset key="signup-kind" className="col" data-testid="signup-kind">
          <label className="radio">
            <input type="radio" name="kind-pick" checked={kind === "firm"} onChange={() => setKind("firm")} data-testid="kind-firm" />
            <span>{t("i_signup_kind_firm")}</span>
          </label>
          <label className="radio">
            <input type="radio" name="kind-pick" checked={kind === "self"} onChange={() => setKind("self")} data-testid="kind-self" />
            <span>
              {t("i_signup_kind_self")} <span className="small muted">({t("i_signup_kind_self_note")})</span>
            </span>
          </label>
          <button key="kind-next" className="btn pri" type="button" disabled={!kind} data-testid="kind-next" onClick={goDetails}>
            {t("i_continue")}
          </button>
        </fieldset>
      ) : (
        <div key="signup-details" className="col" data-testid="signup-details">
          <div className="fg">
            <label className="f">{kind === "self" ? t("i_signup_name_self") : t("i_signup_name_firm")}</label>
            <input className="inp" name="name" data-testid="firm-name" onChange={() => setNameError(false)} />
            {nameError ? <p className="hint" data-testid="firm-name-error">{t("i_field_incomplete", { field: t(kind === "self" ? "i_signup_name_self" : "i_signup_name_firm") })}</p> : null}
          </div>
          <div className="fg">
            <label className="f">{t("i_signup_contact")}</label>
            <input className="inp" name="contactName" data-testid="firm-contact" onChange={() => setContactError(false)} />
            {contactError ? <p className="hint" data-testid="firm-contact-error">{t("i_field_incomplete", { field: t("i_signup_contact") })}</p> : null}
          </div>
          <div className="fg">
            <label className="f">{t("i_signup_phone")}</label>
            <input className="inp" name="phone" data-testid="firm-phone" />
          </div>
          <div className="fg">
            <label className="f">{t("i_signup_code")}</label>
            <input className="inp" name="partnerCode" defaultValue={partnerCode} data-testid="firm-code" />
          </div>
          <p className="small" data-testid="signup-admin-note">{t("i_signup_admin_note")}</p>
          <PendingSubmit className="btn pri" idle={t("i_signup_create")} pending={t("i_signup_submitting")} testId="firm-submit" disabled={!submitReady} />
        </div>
      )}
    </form>
  );
}

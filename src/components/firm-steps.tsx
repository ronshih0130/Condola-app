"use client";

import { useState } from "react";
import { PendingSubmit } from "./pending-submit";
import { useT } from "./locale";
import { actionCreateFirm } from "@/server/signup-actions";

export function FirmSteps({ partnerCode, error }: { partnerCode: string; error?: string }) {
  const t = useT();
  const [step, setStep] = useState<3 | 4>(3);
  const [kind, setKind] = useState<"firm" | "self" | "">("");
  return (
    <form action={actionCreateFirm} className="col" data-testid="firm-form">
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
        <fieldset className="col" data-testid="signup-kind">
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
          <button className="btn pri" type="button" disabled={!kind} data-testid="kind-next" onClick={() => setStep(4)}>
            {t("i_continue")}
          </button>
        </fieldset>
      ) : (
        <div className="col" data-testid="signup-details">
          <div className="fg">
            <label className="f">{kind === "self" ? t("i_signup_name_self") : t("i_signup_name_firm")}</label>
            <input className="inp" name="name" data-testid="firm-name" required={kind === "firm"} />
          </div>
          <div className="fg">
            <label className="f">{t("i_signup_contact")}</label>
            <input className="inp" name="contactName" required data-testid="firm-contact" />
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
          <PendingSubmit className="btn pri" idle={t("i_signup_create")} pending={t("i_signup_submitting")} testId="firm-submit" />
        </div>
      )}
    </form>
  );
}

"use client";

import { useState } from "react";
import Link from "next/link";
import { PendingSubmit } from "./pending-submit";
import { useT } from "./locale";
import { actionPreviewCode, actionStartSignup } from "@/server/signup-actions";

export function SignupForm({ error }: { error?: string }) {
  const t = useT();
  const [code, setCode] = useState("");
  const [note, setNote] = useState("");
  const [bad, setBad] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [consentError, setConsentError] = useState(error === "consent");
  return (
    <form
      action={actionStartSignup}
      className="col"
      onSubmit={(event) => {
        if (agreed) return;
        event.preventDefault();
        setConsentError(true);
      }}
    >
      {error === "duplicate" ? (
        <div className="alert bad" data-testid="signup-duplicate">
          <p>{t("i_signup_dup")}</p>
          <p>
            <a href="/login">{t("i_sign_in")}</a>
            {" · "}
            <a href="/forgot">{t("i_forgot")}</a>
          </p>
        </div>
      ) : error === "weak" ? (
        <div className="alert bad">{t("i_pw_weak")}</div>
      ) : error === "mismatch" ? (
        <div className="alert bad">{t("i_pw_mismatch")}</div>
      ) : error === "email" ? (
        <div className="alert bad">{t("i_email")}</div>
      ) : error === "consent" ? (
        <div className="alert bad" data-testid="signup-consent-error">{t("i_signup_consent_error")}</div>
      ) : error ? (
        <div className="alert bad">{t("i_required")}</div>
      ) : null}
      <div className="fg">
        <label className="f">{t("i_email_label")}</label>
        <input className="inp" name="email" type="email" autoComplete="email" required data-testid="signup-email" />
      </div>
      <div className="fg">
        <label className="f">{t("i_password")}</label>
        <input className="inp" name="password" type="password" autoComplete="new-password" required data-testid="signup-password" />
      </div>
      <div className="fg">
        <label className="f">{t("i_password_confirm")}</label>
        <input className="inp" name="confirm" type="password" autoComplete="new-password" required data-testid="signup-confirm" />
      </div>
      <div className="fg">
        <label className="f">{t("i_signup_code")}</label>
        <input
          className="inp"
          name="partnerCode"
          value={code}
          autoComplete="off"
          data-testid="signup-code"
          onChange={(event) => {
            setCode(event.target.value);
            setNote("");
            setBad(false);
          }}
        />
        <div className="hint">{t("i_signup_code_hint")}</div>
        <button
          className="btn sm"
          type="button"
          data-testid="signup-code-check"
          onClick={async () => {
            const preview = await actionPreviewCode(code);
            if (preview.state === "valid") {
              const years = preview.lockMonths % 12 === 0 ? preview.lockMonths / 12 : null;
              setBad(false);
              setNote(
                years == null
                  ? t("i_code_months", { n: preview.lockMonths, name: preview.partnerName, price: preview.standardPrice })
                  : t("i_signup_code_ok", { name: preview.partnerName, price: preview.standardPrice, years }),
              );
              return;
            }
            if (preview.state === "empty") {
              setBad(false);
              setNote("");
              return;
            }
            setBad(true);
            setNote(t("i_signup_code_bad"));
          }}
        >
          {t("i_signup_code_apply")}
        </button>
        {note ? (
          <p className={bad ? "small" : "small"} data-testid="signup-code-note" data-valid={bad ? "false" : "true"}>
            {note}
          </p>
        ) : null}
      </div>
      <label className="radio" data-testid="signup-consent-label">
        <input
          type="checkbox"
          name="consent"
          value="on"
          checked={agreed}
          required
          data-testid="signup-consent"
          onChange={(event) => {
            setAgreed(event.target.checked);
            if (event.target.checked) setConsentError(false);
          }}
        />
        <span>{t("i_signup_consent_lead")}<Link href="/terms" target="_blank" rel="noopener noreferrer" data-testid="signup-terms">{t("i_signup_consent_terms")}</Link>{t("i_signup_consent_and")}<Link href="/privacy" target="_blank" rel="noopener noreferrer" data-testid="signup-privacy">{t("i_signup_consent_privacy")}</Link></span>
      </label>
      {consentError && error !== "consent" ? (
        <p className="hint" data-testid="signup-consent-error">{t("i_signup_consent_error")}</p>
      ) : null}
      <PendingSubmit className="btn pri block" idle={t("i_signup_submit")} pending={t("i_signup_submitting")} testId="signup-submit" disabled={!agreed} />
      <p className="small">
        <a href="/forgot">{t("i_forgot")}</a>
        {" · "}
        <a href="/login">{t("i_signup_have")}</a>
      </p>
    </form>
  );
}

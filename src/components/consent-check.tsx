"use client";

import { createContext, useContext, useState } from "react";
import Link from "next/link";
import { PendingSubmit } from "./pending-submit";
import { useT } from "./locale";

export type ConsentFieldControl = {
  required: boolean;
  agreed: boolean;
  setAgreed: (value: boolean) => void;
  showError: boolean;
};

export const ConsentFieldContext = createContext<ConsentFieldControl | null>(null);

export function LegalConsentCheckbox({
  variant,
  checked,
  onChange,
  showError,
  labelTestId,
  inputTestId,
  termsTestId,
  privacyTestId,
  errorTestId,
  errorKey,
}: {
  variant: "service" | "portal";
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  showError?: boolean;
  labelTestId: string;
  inputTestId: string;
  termsTestId: string;
  privacyTestId: string;
  errorTestId: string;
  errorKey?: string;
}) {
  const t = useT();
  const control = useContext(ConsentFieldContext);
  const agreed = checked ?? control?.agreed ?? false;
  const setAgreed = onChange ?? control?.setAgreed;
  const error = showError ?? control?.showError ?? false;
  const lead = variant === "portal" ? "i_portal_consent_lead" : "i_signup_consent_lead";
  const terms = variant === "portal" ? "i_portal_consent_terms" : "i_signup_consent_terms";
  const and = variant === "portal" ? "i_portal_consent_and" : "i_signup_consent_and";
  const privacy = variant === "portal" ? "i_portal_consent_privacy" : "i_signup_consent_privacy";
  const message = errorKey || (variant === "portal" ? "i_portal_consent_error" : "i_signup_consent_error");
  return (
    <>
      <label className="radio" data-testid={labelTestId}>
        <input
          type="checkbox"
          name="consent"
          value="on"
          checked={agreed}
          required
          data-testid={inputTestId}
          onChange={(event) => setAgreed?.(event.target.checked)}
        />
        <span>
          {t(lead)}
          <Link href="/terms" target="_blank" rel="noopener noreferrer" data-testid={termsTestId}>
            {t(terms)}
          </Link>
          {t(and)}
          <Link href="/privacy" target="_blank" rel="noopener noreferrer" data-testid={privacyTestId}>
            {t(privacy)}
          </Link>
        </span>
      </label>
      {error ? (
        <p className="hint" data-testid={errorTestId}>
          {t(message)}
        </p>
      ) : null}
    </>
  );
}

export function ConsentGateForm({
  action,
  variant,
  next,
  error,
  titleKey,
}: {
  action: (formData: FormData) => void | Promise<void>;
  variant: "service" | "portal";
  next: string;
  error?: string;
  titleKey: string;
}) {
  const t = useT();
  const [agreed, setAgreed] = useState(false);
  const [consentError, setConsentError] = useState(error === "consent");
  const errorKey = variant === "portal" ? "i_portal_consent_error" : "i_reconsent_error";
  return (
    <form
      className="card pad"
      action={action}
      data-testid="consent-gate"
      onSubmit={(event) => {
        if (agreed) return;
        event.preventDefault();
        setConsentError(true);
      }}
    >
      <h1>{t(titleKey)}</h1>
      {error === "consent" ? (
        <div className="alert bad" data-testid="consent-error">
          {t(errorKey)}
        </div>
      ) : null}
      <input type="hidden" name="next" value={next} />
      <LegalConsentCheckbox
        variant={variant}
        checked={agreed}
        onChange={(value) => {
          setAgreed(value);
          if (value) setConsentError(false);
        }}
        showError={consentError && error !== "consent"}
        labelTestId="consent-label"
        inputTestId="consent-check"
        termsTestId="consent-terms"
        privacyTestId="consent-privacy"
        errorTestId="consent-error"
        errorKey={errorKey}
      />
      <PendingSubmit className="btn pri block" idle={t("i_continue")} pending={t("i_portal_working")} testId="consent-submit" disabled={!agreed} />
    </form>
  );
}

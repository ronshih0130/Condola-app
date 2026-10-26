"use client";

import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { ConsentFieldContext, type ConsentFieldControl } from "./consent-check";
import { claimFormSubmit } from "./submit-once";

const Claimed = createContext(false);

export function AcceptForm({
  action,
  children,
  requireConsent = false,
}: {
  action: (formData: FormData) => void | Promise<void>;
  children: ReactNode;
  requireConsent?: boolean;
}) {
  const guard = useRef(false);
  const [claimed, setClaimed] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [consentError, setConsentError] = useState(false);
  const control: ConsentFieldControl | null = requireConsent
    ? {
        required: true,
        agreed,
        setAgreed: (value) => {
          setAgreed(value);
          if (value) setConsentError(false);
        },
        showError: consentError,
      }
    : null;
  return (
    <form
      className="card pad"
      action={action}
      onSubmit={(event) => {
        if (requireConsent && !agreed) {
          event.preventDefault();
          setConsentError(true);
          return;
        }
        if (!claimFormSubmit(guard)) {
          event.preventDefault();
          return;
        }
        setClaimed(true);
      }}
    >
      <ConsentFieldContext.Provider value={control}>
        <Claimed.Provider value={claimed}>{children}</Claimed.Provider>
      </ConsentFieldContext.Provider>
    </form>
  );
}

export function AcceptSubmit({ idle, pending, testId }: { idle: string; pending: string; testId: string }) {
  const claimed = useContext(Claimed);
  const consent = useContext(ConsentFieldContext);
  const { pending: busy } = useFormStatus();
  const show = claimed || busy;
  const needsConsent = Boolean(consent?.required && !consent.agreed);
  return (
    <button className="btn pri block" type="submit" disabled={show || needsConsent} data-testid={testId} aria-busy={show ? true : undefined}>
      {show ? pending : idle}
    </button>
  );
}

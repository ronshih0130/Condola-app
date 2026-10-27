"use client";

import React, { useState } from "react";
import type { Locale } from "@/i18n";
import { partnerConsentCopy } from "@/i18n/lanes/partner-consent";
import type { SelectedPartnerDocument } from "@/server/partner-consent-rules";
import { PendingSubmit } from "./pending-submit";

type FieldsProps = {
  locale: Locale;
  documents: readonly SelectedPartnerDocument[];
  checked: boolean;
  onChange(value: boolean): void;
};

export function PartnerConsentFields({ locale, documents, checked, onChange }: FieldsProps) {
  const copy = partnerConsentCopy(locale);
  return (
    <div className="col" data-testid="partner-consent-fields">
      <p>{copy.summary}</p>
      {documents.map((doc) => (
        <section key={doc.doc_type} data-testid={`partner-document-${doc.doc_type}`}>
          <h2>{copy[doc.doc_type]}</h2>
          <p>{copy.version}: {doc.version} · {copy.effective}: {doc.effective_date}</p>
          {doc.fallback ? <p>{copy.fallback} · {doc.locale}</p> : null}
          <a href={doc.full_text_url} target="_blank" rel="noopener">{copy.read}</a>
        </section>
      ))}
      <label className="row">
        <input
          type="checkbox"
          name="partnerConsent"
          required
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          data-testid="partner-consent-checkbox"
        />
        <span>{copy.checkbox}</span>
      </label>
    </div>
  );
}

export function PartnerConsentScreen({
  locale, documents, admin, action, logout, error,
}: {
  locale: Locale;
  documents: readonly SelectedPartnerDocument[];
  admin: boolean;
  action(form: FormData): Promise<void>;
  logout(): Promise<void>;
  error?: string;
}) {
  const copy = partnerConsentCopy(locale);
  const [checked, setChecked] = useState(false);
  return (
    <main className="auth-wrap">
      <section className="card pad" data-testid={admin ? "partner-consent" : "partner-consent-waiting"}>
        <h1>{admin ? copy.title : copy.waiting}</h1>
        {admin ? (
          <form
            action={action}
            className="col"
            onSubmit={(event) => { if (!checked) event.preventDefault(); }}
          >
            <input type="hidden" name="partnerConsentPage" value="1" />
            <PartnerConsentFields locale={locale} documents={documents} checked={checked} onChange={setChecked} />
            {error ? <p className="alert bad" role="alert">{copy.required}</p> : null}
            <PendingSubmit
              className="btn pri"
              idle={copy.accept}
              pending={copy.accept}
              disabled={!checked}
              testId="partner-consent-submit"
            />
          </form>
        ) : null}
        <form action={logout}>
          <button className="btn" type="submit" data-testid="partner-consent-logout">{copy.logout}</button>
        </form>
      </section>
    </main>
  );
}

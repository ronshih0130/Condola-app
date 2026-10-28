"use client";

import React, { useState } from "react";
import type { Locale } from "@/i18n";
import { partnerConsentCopy } from "@/i18n/lanes/partner-consent";
import type { SelectedPartnerDocument } from "@/server/partner-consent-rules";
import { PendingSubmit } from "./pending-submit";
import { partnerConsentReady } from "@/lib/partner-consent-ready";

type FieldsProps = {
  locale: Locale;
  documents: readonly SelectedPartnerDocument[];
  checked: boolean;
  authority: boolean;
  onChange(value: boolean): void;
  onAuthorityChange(value: boolean): void;
};

export function PartnerConsentFields({ locale, documents, checked, authority, onChange, onAuthorityChange }: FieldsProps) {
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
      <label className="row">
        <input
          type="checkbox"
          name="partnerAuthority"
          required
          checked={authority}
          onChange={(event) => onAuthorityChange(event.target.checked)}
          data-testid="partner-authority-checkbox"
        />
        <span>{copy.authority}</span>
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
  const [authority, setAuthority] = useState(false);
  const ready = partnerConsentReady(checked, authority);
  return (
    <main className="auth-wrap">
      <section className="card pad" data-testid={admin ? "partner-consent" : "partner-consent-waiting"}>
        <h1>{admin ? copy.title : copy.waiting}</h1>
        {admin && documents.length !== 2 ? <p className="alert bad" role="alert">{copy.unavailable}</p> : null}
        {admin && documents.length === 2 ? (
          <form
            action={action}
            className="col"
            onSubmit={(event) => { if (!ready) event.preventDefault(); }}
          >
            <input type="hidden" name="partnerConsentPage" value="1" />
            <PartnerConsentFields locale={locale} documents={documents} checked={checked} authority={authority} onChange={setChecked} onAuthorityChange={setAuthority} />
            {error ? <p className="alert bad" role="alert">{copy.required}</p> : null}
            <PendingSubmit
              className="btn pri"
              idle={copy.accept}
              pending={copy.accept}
              disabled={!ready}
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

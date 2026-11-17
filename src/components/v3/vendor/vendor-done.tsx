"use client";

import React, { useId, useState } from "react";
import type { Locale } from "../../../i18n";
import { vendorCaseCopy } from "../../../i18n/lanes/brand-v3-vendor-case";
import { vendorCloseCopy } from "../../../i18n/lanes/brand-v3-vendor-close";
import type { DonePhoto } from "../../../server/b097-vendor-close";
import { CaseStyles } from "./vendor-case";
import { VendorCasePhotoUpload } from "./vendor-case-photo-upload";

type Fetch = (input: string, init: RequestInit) => Promise<Response>;
export type CompleteOutcome = "saved" | "failed" | "no_photo" | "closed" | "busy";

/**
 * One request id per note text: a retry of the same report is a replay (never a second close); an edited note is a
 * new request; a conflict starts a new one. done() runs once the repair is closed (recorded, or already closed).
 */
export function createCompleteSaver(deps: { fetch: Fetch; done: () => void; newId?: () => string }) {
  const newId = deps.newId ?? (() => globalThis.crypto.randomUUID());
  let busy = false, last: string | null = null, requestId = newId();
  return {
    get busy() { return busy; },
    async submit(token: string, note: string): Promise<CompleteOutcome> {
      if (busy) return "busy";
      const text = note.replace(/\r\n?/g, "\n").trim();
      if (last !== null && last !== text) requestId = newId();
      last = text; busy = true;
      try {
        const response = await deps.fetch("/api/vendor-jobs/case-complete", {
          method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin",
          body: JSON.stringify({ token, requestId, note: text || null }),
        });
        const body = (await response.json().catch(() => null)) as { status?: string } | null;
        if (response.ok && body?.status === "recorded") { deps.done(); return "saved"; }
        if (body?.status === "rejected_closed") { deps.done(); return "closed"; }
        if (body?.status === "rejected_no_photo") return "no_photo";
        if (body?.status === "rejected_conflict") requestId = newId();
        return "failed";
      } catch { return "failed"; } finally { busy = false; }
    },
  };
}

/**
 * RV-DONE 這一案 › 回報完工 (VEN-29-AC1…AC4; GS-27: earlier 處理後 uploads count). 處理後照片 with 「至少一張」, the
 * outline upload, 說明（選填）, the close sentence, one solid 「送出完工」 (disabled until a photo exists) and text
 * 「取消」 back to the job. A failed send keeps the photos and the note, with 「再試一次」 (GS-02).
 */
export function VendorDoneForm({ locale, token, company, photos, messages }: {
  locale: Locale; token: string; company: string; photos: DonePhoto[];
  messages: { size: string; type: string; heic: string; limit: string };
}) {
  const copy = vendorCloseCopy(locale), caseCopy = vendorCaseCopy(locale);
  const id = useId();
  const path = `/v/${encodeURIComponent(token)}`;
  const [note, setNote] = useState("");
  const [state, setState] = useState<"idle" | "pending" | "failed">("idle");
  const [saver] = useState(() => createCompleteSaver({ fetch: (input, init) => fetch(input, init), done: () => window.location.assign(path) }));
  const ready = photos.length > 0;
  async function submit() {
    if (!ready || state === "pending") return;
    setState("pending");
    const outcome = await saver.submit(token, note);
    setState(outcome === "saved" || outcome === "closed" || outcome === "busy" ? "idle" : "failed");
  }
  return <>
    <CaseStyles />
    {/* eslint-disable-next-line @next/next/no-css-tags -- bearer-org ON-only stylesheet, scoped like vendor-case.css */}
    <link rel="stylesheet" href="/brand/v3/vendor-close.css" />
    <div className="v-token-lead"><h1>{copy.doneTitle}</h1></div>
    <form className="v-token-card v-case-card v-case-form v-done" aria-labelledby={`${id}-photos`} data-testid="vendor-done"
      onSubmit={event => { event.preventDefault(); void submit(); }}>
      <p className="v-case-field" id={`${id}-photos`}>{copy.afterPhotos}　<span className="v-case-badge v-case-badge-warn">{copy.atLeastOne}</span></p>
      {photos.length ? <ul className="v-case-tiles">
        {photos.map(photo => <li key={photo.id} data-testid="vendor-done-tile">
          {/* Private ticket photo; the byte route re-checks this bearer, job and case state on every request. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/api/vendor-jobs/${encodeURIComponent(token)}/photos/${photo.id}`} alt={photo.name} />
          <span>{photo.name}</span>
        </li>)}
      </ul> : null}
      <VendorCasePhotoUpload token={token} phase="after" tone="secondary" label={caseCopy.uploadAfter}
        messages={{ ...messages, saveError: caseCopy.saveError, retry: caseCopy.retry }} />
      <label className="v-case-field" htmlFor={`${id}-note`}>{copy.note}</label>
      <textarea id={`${id}-note`} className="v-case-input v-done-note" name="note" maxLength={500} rows={3} value={note}
        onChange={event => { setNote(event.target.value); if (state === "failed") setState("idle"); }} />
      <p className="v-case-help">{copy.closeLine.replace("{company}", company)}</p>
      {state === "failed" ? <div className="v-case-error" role="alert">
        <p>{caseCopy.saveError}</p>
        <button type="submit" className="v-token-secondary">{caseCopy.retry}</button>
      </div> : null}
      <button type="submit" className="v-token-primary v-case-block" disabled={!ready || state === "pending"} aria-busy={state === "pending"}>{copy.submit}</button>
      <a className="v-case-text v-case-block v-done-cancel" href={path}>{copy.cancel}</a>
    </form>
  </>;
}

/** B-098 RV-TIME 「打電話給租客」 (outline). Rendered only when the tenant phone reader admitted this bearer. */
export function CallTenant({ locale, phone }: { locale: Locale; phone: string }) {
  return <a className="v-token-secondary v-case-block" href={`tel:${phone}`} data-testid="vendor-call-tenant">{vendorCloseCopy(locale).callTenant}</a>;
}

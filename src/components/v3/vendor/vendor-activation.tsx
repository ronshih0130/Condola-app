"use client";

import React, { useId, useState } from "react";
import type { Locale } from "../../../i18n";
import { vendorActivationCopy } from "../../../i18n/lanes/brand-v3-vendor-activation";
import { VENDOR_ACCOUNT_PAGES, VENDOR_WORKBENCH } from "../../../lib/vendor-workbench-paths";
import type { IssuerType } from "../../../server/b065-vendor-activation";

const TYPES: readonly IssuerType[] = ["individual", "exempt_business", "invoice_business"];

/**
 * ven-account (GS-31): the 開立類型 row (value + chevron) opens the type page; only 免用統一發票之營業人 (type 2)
 * gets 「管理印章」. Rendered inside the 固定資料 card. Name, phone and tax-id editing are not part of this slice.
 */
export function IssuerTypeRow({ locale, issuerType }: { locale: Locale; issuerType: IssuerType | null }) {
  const copy = vendorActivationCopy(locale);
  return <div className="v-act-row" data-testid="issuer-type-row">
    {/* eslint-disable-next-line @next/next/no-css-tags -- workbench-only stylesheet */}
    <link rel="stylesheet" href="/brand/v3/vendor-activation.css" />
    <a className="v-act-link" href={VENDOR_ACCOUNT_PAGES.issuerType}>
      <span><b>{copy.row}</b>{issuerType ? <small>{copy.types[issuerType].title}</small> : null}</span>
      <span aria-hidden="true">›</span>
    </a>
    <p className="v-act-help">{copy.rowNote}</p>
    {issuerType === "exempt_business" ? <a className="v-act-secondary" href={VENDOR_ACCOUNT_PAGES.stamp}>{copy.manageStamp}</a> : null}
  </div>;
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;
/** One request id per chosen type: a retry of the same choice replays; another choice is a new request. */
export function createIssuerSaver(deps: { fetch: Fetch; done: () => void; newId?: () => string }) {
  const newId = deps.newId ?? (() => globalThis.crypto.randomUUID());
  let busy = false, last: IssuerType | null = null, requestId = newId();
  return {
    get busy() { return busy; },
    async save(issuerType: IssuerType): Promise<"saved" | "failed" | "busy"> {
      if (busy) return "busy";
      if (last !== null && last !== issuerType) requestId = newId();
      last = issuerType; busy = true;
      try {
        const response = await deps.fetch("/api/vendor-account/issuer-type", {
          method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin",
          body: JSON.stringify({ requestId, issuerType }),
        });
        const body = (await response.json().catch(() => null)) as { status?: string } | null;
        if (response.ok && (body?.status === "recorded" || body?.status === "unchanged")) { deps.done(); return "saved"; }
        if (body?.status === "rejected_conflict") requestId = newId();
        return "failed";
      } catch { return "failed"; } finally { busy = false; }
    },
  };
}

/** 我的帳號 › 開立類型: tapping a card only changes the choice; only 儲存 writes; 取消 leaves without writing (VEN-17-AC6). */
export function IssuerTypeForm({ locale, current }: { locale: Locale; current: IssuerType | null }) {
  const copy = vendorActivationCopy(locale);
  const id = useId();
  const [choice, setChoice] = useState<IssuerType | null>(current);
  const [state, setState] = useState<"idle" | "pending" | "failed">("idle");
  const [saver] = useState(() => createIssuerSaver({ fetch: (input, init) => fetch(input, init), done: () => window.location.assign(VENDOR_WORKBENCH.account) }));
  async function save() {
    if (!choice || state === "pending") return;
    setState("pending");
    const outcome = await saver.save(choice);
    setState(outcome === "failed" ? "failed" : "idle");
  }
  return <section className="v-act-card" aria-labelledby={`${id}-q`}>
    <h2 id={`${id}-q`}>{copy.question}</h2>
    <div className="v-act-options" role="radiogroup" aria-labelledby={`${id}-q`}>
      {TYPES.map(type => <label key={type} className={`v-act-option${choice === type ? " v-act-on" : ""}`}>
        <input type="radio" name="issuerType" value={type} checked={choice === type} onChange={() => setChoice(type)} />
        <span><b>{copy.types[type].title}</b><span>{copy.types[type].desc}</span></span>
      </label>)}
    </div>
    <p className="v-act-info">{copy.selfDeclared}</p>
    <p className="v-act-help">{copy.rowNote}</p>
    {state === "failed" ? <div className="v-act-error" role="alert"><p>{copy.saveError}</p>
      <button type="button" className="v-act-secondary" onClick={() => void save()}>{copy.retry}</button></div> : null}
    <button type="button" className="v-act-primary" disabled={!choice || state === "pending"} aria-busy={state === "pending"} onClick={() => void save()}>{copy.save}</button>
    <a className="v-act-text" href={VENDOR_WORKBENCH.account}>{copy.cancel}</a>
  </section>;
}

/** ven-stamp (a): no stamp yet. 「產生印章」 is not shown until the direction-1 generator exists (phase B). */
export function StampNotYet({ locale }: { locale: Locale }) {
  const copy = vendorActivationCopy(locale);
  return <section className="v-act-card" aria-labelledby="v-act-stamp">
    <h2 id="v-act-stamp">{copy.stampCard}</h2>
    <p className="v-act-blank">{copy.noStamp}</p>
  </section>;
}

"use client";

import React, { useId, useState } from "react";
import type { Locale } from "../../../i18n";
import { vendorDocsCopy } from "../../../i18n/lanes/brand-v3-vendor-docs";
import { taipeiToday } from "../../../server/money";
import type { VendorDocsBrand, VendorDocsV3Stage } from "../../../server/gs32-vendor-docs";

/**
 * GS-32 b–g, the frames whose data exists (Round 7 batch 4), inside the V-TOKEN shell on the B-025
 * document-grant page. Every write goes to the existing /api/vendor-documents actions (issue, attach_scan).
 * Not drawn here and therefore not shown (GS-44): 作廢重開 (the 3.0 void flow is VF-4), the paper file name
 * (paper scans keep no file name), and anything for type 3.
 */
export type VendorDocsV3Props = {
  locale: Locale; token: string; brand: VendorDocsBrand; stage: VendorDocsV3Stage;
  totalMinor: string; remainingMinor: string; mode: "view" | "paper"; uploaded: boolean;
};
type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export function money(currency: string, minor: string) {
  const grouped = minor.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return currency === "TWD" ? `NT$${grouped}` : `${currency} ${grouped}`;
}

export function DocsStyles() {
  // eslint-disable-next-line @next/next/no-css-tags -- bearer-org ON-only stylesheet, scoped like vendor-token.css
  return <link rel="stylesheet" href="/brand/v3/vendor-docs.css" />;
}

/** The issue body is built once, so a retry replays the same idempotency key and payment mark. */
export function type1IssueBody(token: string, remainingMinor: string, newId: () => string, today: string) {
  return {
    token, action: "issue", kind: "completion_statement", documentDate: today, idempotencyKey: newId(),
    ...(BigInt(remainingMinor) > BigInt(0) ? { received: { requestId: newId(), amountMinor: remainingMinor } } : {}),
  };
}

export async function sendOnce(fetchImpl: Fetch, body: Record<string, unknown>) {
  const response = await fetchImpl("/api/vendor-documents", {
    method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify(body),
  });
  return response.ok;
}

/** Controls while a write is in flight: disabled, announced busy, and a second press is ignored. */
export function pendingControl(state: "idle" | "pending" | "failed", ready = true) {
  return { disabled: !ready || state === "pending", "aria-busy": state === "pending" };
}

export function VendorDocsV3(props: VendorDocsV3Props) {
  const copy = vendorDocsCopy(props.locale);
  const job = [props.brand.property, props.brand.ticketTitle].filter(Boolean).join("・");
  if (props.stage.stage === "type1_preview") return <Type1Preview {...props} />;
  const { receipt, scans } = props.stage;
  if (props.mode === "paper") return <PaperUpload {...props} docNo={receipt.docNo} documentId={receipt.id} job={job} />;
  const path = `/v/documents/${encodeURIComponent(props.token)}`;
  return <>
    <DocsStyles />
    <div className="v-token-lead"><h1>{copy.receiptTitle}</h1></div>
    <p className="v-docs-crumb">{copy.receiptCrumb.replace("{job}", job)}</p>
    {props.uploaded ? <p className="v-docs-toast" role="status">{copy.paperDone}</p> : null}
    <h2 className="v-docs-h">{copy.evidence}</h2>
    <section className="v-token-card v-docs-card" aria-label={copy.receiptTitle}>
      <div className="v-docs-row"><h3>{copy.receiptTitle}</h3><span className="v-docs-mark">{copy.markReceipt}</span></div>
      <dl>
        <div><dt>{copy.number}</dt><dd>{receipt.docNo}</dd></div>
        {props.brand.buyerName ? <div><dt>{copy.billedTo}</dt><dd>{props.brand.buyerName}</dd></div> : null}
        <div><dt>{copy.amount}</dt><dd className="v-docs-num">{money(props.brand.currency, props.totalMinor)}</dd></div>
      </dl>
    </section>
    {scans.map(scan => <section key={scan.id} className="v-token-card v-docs-card" aria-label={copy.paperCard} data-testid="paper-receipt">
      <div className="v-docs-row"><h3>{copy.paperCard}</h3><span className="v-docs-mark">{copy.markReceipt}</span></div>
    </section>)}
    <a className="v-token-secondary v-docs-block" href={`${path}?paper=1`}>{copy.paperEntry}</a>
  </>;
}

function Type1Preview(props: VendorDocsV3Props) {
  const copy = vendorDocsCopy(props.locale);
  const [state, setState] = useState<"idle" | "pending" | "failed">("idle");
  // The server checks the document date against Asia/Taipei (vendor-receipt.ts checkDate), so the date is taken
  // there too, never in UTC. (The B-025 panel still uses a UTC date; left unchanged.)
  const [body] = useState(() => type1IssueBody(props.token, props.remainingMinor, () => globalThis.crypto.randomUUID(), taipeiToday()));
  async function issue() {
    if (state === "pending") return;
    setState("pending");
    try {
      if (await sendOnce((input, init) => fetch(input, init), body)) { window.location.reload(); return; }
    } catch { /* GS-02 below; the preview stays. */ }
    setState("failed");
  }
  return <>
    <DocsStyles />
    <div className="v-token-lead"><h1>{copy.previewTitle}</h1></div>
    <p className="v-docs-banner">{copy.notTax}</p>
    <section className="v-token-card v-docs-card" aria-label={copy.previewHeading}>
      <div className="v-docs-row"><h2>{copy.previewHeading}</h2><span className="v-docs-mark v-docs-mark-warn">{copy.markStatement}</span></div>
      <p>{copy.previewNote}</p>
      <dl>
        <div><dt>{copy.issuer}</dt><dd>{props.brand.name}</dd></div>
        {props.brand.buyerName ? <div><dt>{copy.buyer}</dt><dd>{props.brand.buyerName}</dd></div> : null}
        <div><dt>{copy.amount}</dt><dd className="v-docs-num">{money(props.brand.currency, props.totalMinor)}</dd></div>
        <div><dt>{copy.number}</dt><dd>{copy.noNumber}</dd></div>
      </dl>
      <p className="v-docs-small">{copy.signLine.replace("{name}", props.brand.name)}</p>
      {/* FRAME QUESTION (for the Design Session): the frame shows this approved line unconditionally, while the
          sentence itself is about a company payer (issuer-types.md: 「類型 1 且開給管理公司」). Shown for a company
          buyer only until the frame says otherwise. */}
      {props.brand.buyerKind === "company" ? <p className="v-docs-small">{copy.withholding}</p> : null}
      {state === "failed" ? <div className="v-docs-error" role="alert"><p>{copy.saveError}</p>
        <button type="button" className="v-token-secondary" onClick={() => void issue()}>{copy.retry}</button></div> : null}
      <button type="button" className="v-token-primary v-docs-block" {...pendingControl(state)} onClick={() => void issue()}>{copy.issue}</button>
      <button type="button" className="v-docs-text v-docs-block" onClick={() => window.history.back()}>{copy.close}</button>
    </section>
  </>;
}

type Attachment = { base64: string; mimeType: string };
export async function encodeScan(file: File): Promise<Attachment> {
  if (file.size < 1 || file.size > 5242880 || !["image/png", "image/jpeg", "application/pdf"].includes(file.type)) throw new Error("invalid_attachment");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { base64: btoa(binary), mimeType: file.type };
}

function PaperUpload(props: VendorDocsV3Props & { docNo: string; documentId: string; job: string }) {
  const copy = vendorDocsCopy(props.locale);
  const id = useId();
  const path = `/v/documents/${encodeURIComponent(props.token)}`;
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<"idle" | "pending" | "failed">("idle");
  // One request id per chosen file, so a retry of the same file is a replay (UNIQUE org_id, request_id).
  const [request, setRequest] = useState<string | null>(null);
  async function upload() {
    if (!file || state === "pending") return;
    setState("pending");
    try {
      const requestId = request ?? globalThis.crypto.randomUUID();
      setRequest(requestId);
      const ok = await sendOnce((input, init) => fetch(input, init),
        { token: props.token, action: "attach_scan", documentId: props.documentId, requestId, ...await encodeScan(file) });
      if (ok) { window.location.assign(`${path}?uploaded=1`); return; }
    } catch { /* GS-02 below; the file stays chosen. */ }
    setState("failed");
  }
  return <>
    <DocsStyles />
    <div className="v-token-lead"><h1>{copy.paperEntry}</h1></div>
    <p className="v-docs-crumb">{copy.paperCrumb.replace("{job}", props.job)}</p>
    <section className="v-token-card v-docs-card" aria-label={copy.paperEntry}>
      <p>{copy.paperSibling.replace("{number}", props.docNo)}</p>
      <input id={`${id}-file`} className="v-docs-file" type="file" accept="image/jpeg,image/png,application/pdf" disabled={state === "pending"}
        data-testid="paper-file" onChange={event => { setFile(event.target.files?.[0] ?? null); setRequest(null); setState("idle"); }} />
      {/* GS-44: the frame draws only the zone text; a chosen file shows as 「上傳」 turning solid, not its name. */}
      <label className="v-docs-zone" htmlFor={`${id}-file`} data-chosen={file ? "true" : undefined}>{copy.paperZone}</label>
      {state === "failed" ? <div className="v-docs-error" role="alert"><p>{copy.saveError}</p>
        <button type="button" className="v-token-secondary" onClick={() => void upload()}>{copy.retry}</button></div> : null}
      <button type="button" className="v-token-primary v-docs-block" {...pendingControl(state, file !== null)} onClick={() => void upload()}>{copy.upload}</button>
      <a className="v-docs-text v-docs-block" href={path}>{copy.cancel}</a>
    </section>
  </>;
}

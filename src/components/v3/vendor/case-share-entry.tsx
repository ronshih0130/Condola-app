"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import type { Locale } from "../../../i18n";
import { caseShareCopy } from "../../../i18n/lanes/brand-v3-case-share";

/**
 * B-110 ven-copy-link on a closed case (VEN-25): 其他 › 「複製唯讀連結」 opens the sheet in place. It appears only
 * when the gateway says this case is eligible (closed, with an issued or voided document, B-110 on). Opening shows
 * the case's link; 「複製連結」 records a copy (restarting its 90 days, GS-54) and puts it on the clipboard, then
 * 「已複製連結」 and the sheet stays. The system never sends the link. Vendors cannot revoke it (MGT-124-AC3).
 */
type Fetch = (input: string, init: RequestInit) => Promise<Response>;
export type ShareOutcome = { ok: true; url: string } | { ok: false };

export function createShareClient(deps: { fetch: Fetch; token: string }) {
  let busy = false;
  async function call(mode: "check" | "open" | "copy") {
    const response = await deps.fetch("/api/vendor-jobs/case-share", {
      method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin",
      body: JSON.stringify({ token: deps.token, mode }),
    });
    return { ok: response.ok, body: (await response.json().catch(() => null)) as { eligible?: boolean; url?: string } | null };
  }
  return {
    get busy() { return busy; },
    async eligible() {
      try { const r = await call("check"); return r.ok && r.body?.eligible === true; } catch { return false; }
    },
    async link(mode: "open" | "copy"): Promise<ShareOutcome | "busy"> {
      if (busy) return "busy";
      busy = true;
      try {
        const r = await call(mode);
        return r.ok && typeof r.body?.url === "string" ? { ok: true, url: r.body.url } : { ok: false };
      } catch { return { ok: false }; } finally { busy = false; }
    },
  };
}

export function CaseShareEntry({ locale, token }: { locale: Locale; token: string }) {
  const copy = caseShareCopy(locale);
  const id = useId();
  const sheet = useRef<HTMLDialogElement>(null);
  const [client] = useState(() => createShareClient({ fetch: (input, init) => fetch(input, init), token }));
  const [eligible, setEligible] = useState(false);
  const [url, setUrl] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "pending" | "copied" | "readError" | "copyError">("idle");

  useEffect(() => { let live = true; void client.eligible().then(ok => { if (live) setEligible(ok); }); return () => { live = false; }; }, [client]);

  async function open() {
    sheet.current?.showModal();
    setState("loading");
    const result = await client.link("open");
    if (result === "busy") return;
    if (result.ok) { setUrl(result.url); setState("idle"); } else setState("readError");
  }
  async function copyLink() {
    if (state === "pending") return;
    setState("pending");
    const result = await client.link("copy");
    if (result === "busy") return;
    if (!result.ok) { setState("copyError"); return; }
    setUrl(result.url);
    try { await navigator.clipboard.writeText(result.url); setState("copied"); } catch { setState("copyError"); }
  }
  if (!eligible) return null;
  return <>
    <button type="button" className="v-case-share-entry" aria-haspopup="dialog" onClick={() => void open()}>{copy.entry}</button>
    <dialog ref={sheet} className="v-token-sheet v-case-sheet" aria-labelledby={`${id}-title`}>
      <div className="v-case-share">
        <h2 id={`${id}-title`}>{copy.title}</h2>
        {state === "readError" ? <div className="v-case-error" role="alert"><p>{copy.readError}</p>
          <button type="button" className="v-token-secondary" onClick={() => void open()}>{copy.retry}</button></div> : <>
          <p>{copy.noSend}</p>
          <label className="v-case-field" htmlFor={`${id}-url`}>{copy.link}</label>
          <input id={`${id}-url`} className="v-case-input" value={url} readOnly aria-describedby={`${id}-scope`} />
          <p className="v-case-help" id={`${id}-scope`}>{copy.scope}</p>
          {state === "copied" ? <p className="v-case-toast" role="status">{copy.copied}</p> : null}
          {state === "copyError" ? <div className="v-case-error" role="alert"><p>{copy.saveError}</p>
            <button type="button" className="v-token-secondary" onClick={() => void copyLink()}>{copy.retry}</button></div> : null}
          <button type="button" className="v-token-primary v-case-block" disabled={state === "pending" || state === "loading" || !url}
            aria-busy={state === "pending"} onClick={() => void copyLink()}>{copy.copy}</button>
        </>}
        <button type="button" className="v-case-text v-case-block" onClick={() => sheet.current?.close()}>{copy.close}</button>
      </div>
    </dialog>
  </>;
}

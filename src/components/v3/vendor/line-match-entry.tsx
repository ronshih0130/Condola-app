"use client";
import React, { useRef, useState } from "react";
import { continueInLine } from "../../../app/v/[token]/continue-in-line";
import { vendorLineMatchCopy as copy } from "../../../i18n/lanes/vendor-line-match";

export function VendorLineMatchEntry({ token }: { token: string }) {
 const running = useRef(false);
 const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
 async function start() {
  if (running.current) return;
  running.current = true; setBusy(true); setFailed(false);
  const ok = await continueInLine(token, { fetch: (url, init) => fetch(url, init), navigate: path => {
   const a = document.createElement("a"); a.href = path; a.rel = "noreferrer"; a.hidden = true;
   document.body.appendChild(a); a.click(); a.remove();
  } }, true);
  running.current = false; setBusy(false); setFailed(!ok);
 }
 return <div data-testid="vendor-line-match-entry">
  <button className="v-token-secondary" type="button" onClick={start} disabled={busy} aria-busy={busy}>{failed ? copy.retry : copy.entry}</button>
  {failed ? <><p role="alert">{copy.error}</p><a href={`/v/${encodeURIComponent(token)}`} referrerPolicy="no-referrer">{copy.back}</a></> : null}
 </div>;
}

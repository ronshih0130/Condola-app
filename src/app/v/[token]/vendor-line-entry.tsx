"use client";

import { useRef, useState } from "react";
import { continueInLine } from "./continue-in-line";

/** Opens the same-origin LIFF bootstrap without sending this page URL as a Referer. */
function navigateWithoutReferrer(path: string) {
  const link = document.createElement("a");
  link.href = path;
  link.rel = "noreferrer";
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export function VendorLineEntry({ token, copy }: { token: string; copy: { label: string; hint: string; failed: string } }) {
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  async function start() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFailed(false);
    const opened = await continueInLine(token, { fetch: (path, init) => window.fetch(path, init), navigate: navigateWithoutReferrer });
    inFlight.current = false;
    setBusy(false);
    if (!opened) setFailed(true);
  }
  return (
    <div data-testid="vendor-line-entry">
      <p className="small">{copy.hint}</p>
      <button className="btn" type="button" onClick={start} disabled={busy} aria-busy={busy}
        style={{ minHeight: 44, minWidth: 44 }} data-testid="vendor-line-continue">
        {copy.label}
      </button>
      {failed ? <p role="alert" data-testid="vendor-line-failed">{copy.failed}</p> : null}
    </div>
  );
}

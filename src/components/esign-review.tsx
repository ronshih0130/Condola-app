"use client";

import { useEffect, useRef, useState } from "react";
import { actionEsignStep } from "@/server/esign/actions";
import { esignCopy } from "@/server/esign/copy";
import { esignUi } from "@/i18n/lanes/esign";

/** Each iframe contains exactly one PDF page. Scrolling the outer region reaches
 * every page, rather than treating a PDF plugin's load event as a scroll proof.
 */
export function EsignReview({ caseId, versionId, pages, locale }: {
  caseId: string; versionId: string; pages: number; locale: "zh-TW" | "en";
}) {
  const [urls, setUrls] = useState<string[]>([]);
  const [error, setError] = useState(false);
  const [loaded, setLoaded] = useState<Set<number>>(new Set());
  const [end, setEnd] = useState(false);
  const [retry, setRetry] = useState(0);
  const region = useRef<HTMLDivElement>(null);
  const c = esignUi[locale], copy = esignCopy[locale]["ES-04"];
  useEffect(() => {
    let active = true;
    const created: string[] = [];
    setError(false); setEnd(false); setLoaded(new Set()); setUrls([]);
    (async () => {
      // Bound concurrent requests and retain all failures; no partial review.
      for (let page = 1; page <= pages; page++) {
        const response = await fetch("/api/esign/" + caseId + "/" + versionId + "?page=" + page, { cache: "no-store" });
        if (!response.ok || !response.headers.get("content-type")?.includes("application/pdf")) throw new Error("PDF");
        const url = URL.createObjectURL(await response.blob());
        created.push(url);
        if (!active) { URL.revokeObjectURL(url); return; }
        setUrls([...created]);
      }
    })().catch(() => { if (active) setError(true); });
    return () => { active = false; created.forEach((url) => URL.revokeObjectURL(url)); };
  }, [caseId, versionId, pages, retry]);

  function scroll() {
    const el = region.current;
    if (el && urls.length === pages && loaded.size === pages &&
        el.scrollHeight - el.scrollTop - el.clientHeight <= 4) setEnd(true);
  }
  return <div>
    <h4>{copy.label}</h4><p>{c.read}</p>
    {error ? <p role="alert">{copy.loadError} <button type="button" onClick={() => setRetry((n) => n + 1)}>{c.retry}</button></p> : null}
    <div ref={region} onScroll={scroll} tabIndex={0} aria-label={copy.label}
      style={{ height: 480, overflowY: "auto", overflowX: "hidden", width: "100%", border: "1px solid #aaa" }}>
      {urls.map((url, i) => <div key={url} style={{ width: "100%" }}>
        <p>{c.page} {i + 1} / {pages}</p>
        <iframe title={c.page + " " + (i + 1)} src={url + "#toolbar=0&navpanes=0&view=Fit"}
          onLoad={() => setLoaded((old) => new Set([...old, i]))}
          onError={() => setError(true)}
          style={{ display: "block", width: "100%", height: 440, border: 0 }} />
      </div>)}
      <p aria-hidden="true">—</p>
    </div>
    <form action={actionEsignStep}>
      <input type="hidden" name="caseId" value={caseId} />
      <input type="hidden" name="versionId" value={versionId} />
      <input type="hidden" name="step" value="review" />
      <button type="submit" disabled={!end || error}>{copy.next}</button>
    </form>
  </div>;
}

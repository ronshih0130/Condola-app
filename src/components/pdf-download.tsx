"use client";

import { useEffect, useState } from "react";
import type { PdfDocument } from "@/lib/pdf-document";

export function PdfDownloadButton({
  href,
  label,
  failed,
  testId,
}: {
  href: string;
  label: string;
  failed: string;
  testId: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    void import("@/lib/pdf-client").then((mod) => mod.preloadPdfFont().catch(() => undefined));
  }, []);

  async function onClick() {
    setBusy(true);
    setError(false);
    try {
      const { downloadPdf, preloadPdfFont } = await import("@/lib/pdf-client");
      const [response] = await Promise.all([
        fetch(href, { headers: { accept: "application/json" } }),
        preloadPdfFont(),
      ]);
      if (!response.ok) throw new Error(String(response.status));
      const doc = (await response.json()) as PdfDocument;
      await downloadPdf(doc);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="pdf-download">
      <button className="btn" type="button" data-testid={testId} onClick={onClick} disabled={busy} aria-busy={busy || undefined}>
        {label}
      </button>
      {error ? (
        <span className="small" data-testid="pdf-error" role="alert" style={{ marginLeft: 8 }}>
          {failed}
        </span>
      ) : null}
    </span>
  );
}

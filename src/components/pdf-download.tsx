"use client";

import { useState } from "react";
import type { PdfDocument } from "@/lib/pdf-document";

export function PdfDownloadButton({
  href,
  label,
  failed,
  fontFailed,
  testId,
}: {
  href: string;
  label: string;
  failed: string;
  fontFailed?: string;
  testId: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"failed" | "font" | null>(null);

  async function onClick() {
    setBusy(true);
    setError(null);
    try {
      const { downloadPdf, preloadPdfFont } = await import("@/lib/pdf-client");
      const [response] = await Promise.all([
        fetch(href, { headers: { accept: "application/json" } }),
        preloadPdfFont(),
      ]);
      if (!response.ok) throw new Error(String(response.status));
      const doc = (await response.json()) as PdfDocument;
      await downloadPdf(doc);
    } catch (err) {
      setError(err instanceof Error && err.name === "PdfFontError" ? "font" : "failed");
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
          {error === "font" ? (fontFailed ?? failed) : failed}
        </span>
      ) : null}
    </span>
  );
}

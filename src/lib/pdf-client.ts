"use client";

import type { PdfDocument } from "@/lib/pdf-document";

export const PDF_FONT_URL = "/fonts/DroidSansFallback-subset.ttf";

let fontTask: Promise<Uint8Array> | null = null;

/** Fetch the Traditional Chinese subset only when a PDF is requested. */
export function preloadPdfFont() {
  if (typeof window === "undefined") return Promise.reject(new Error("font"));
  if (!fontTask) {
    fontTask = fetch(PDF_FONT_URL).then(async (response) => {
      if (!response.ok) throw new Error("font");
      return new Uint8Array(await response.arrayBuffer());
    });
    fontTask.catch(() => {
      fontTask = null;
    });
  }
  return fontTask;
}

function safeFilename(name: string) {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "") || "document.pdf";
  return cleaned.toLowerCase().endsWith(".pdf") ? cleaned : `${cleaned}.pdf`;
}

export async function downloadPdf(doc: PdfDocument) {
  const [{ renderPdf }, font] = await Promise.all([import("@/lib/pdf-render"), preloadPdfFont()]);
  const bytes = await renderPdf(doc, font);
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const blob = new Blob([copy], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = safeFilename(doc.filename);
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

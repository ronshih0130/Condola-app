"use client";

import dynamic from "next/dynamic";

/**
 * Load the PDF button only in the browser. The server page keeps a placeholder so
 * pdf-lib stays out of the Worker bundle.
 */
export const PdfDownloadButton = dynamic(
  () => import("@/components/pdf-download").then((mod) => mod.PdfDownloadButton),
  { ssr: false },
);

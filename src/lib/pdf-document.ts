export type PdfRow = { label: string; value: string };

export type PdfBlock =
  | { kind: "rows"; heading: string; rows: PdfRow[] }
  | { kind: "text"; heading: string; lines: string[] };

/** Data for a PDF built in the browser. The server never renders the bytes. */
export type PdfDocument = {
  filename: string;
  title: string;
  subtitle: string;
  blocks: PdfBlock[];
  /** Traditional Chinese (or English) label drawn with the embedded font. */
  footerLabel: string;
  /** ASCII trailer drawn with Helvetica so it matches the stored value exactly. */
  footerHash: string;
};

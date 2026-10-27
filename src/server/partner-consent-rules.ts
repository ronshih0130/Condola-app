import { createHash } from "node:crypto";
import rawConfig from "../../config/partner-consent-documents.json";

export const PARTNER_DOC_TYPES = ["privacy", "partner_agreement"] as const;
export type PartnerDocType = (typeof PARTNER_DOC_TYPES)[number];
export type PartnerFlag = "off" | "org" | "on";
export type PartnerDocument = {
  locale: string;
  version: string;
  effective_date: string;
  full_text_url: string;
  source: string;
  sha256: string;
};
export type PartnerDocumentConfig = {
  default_locale: string;
  documents: Record<PartnerDocType, PartnerDocument[]>;
};
export type SelectedPartnerDocument = PartnerDocument & {
  doc_type: PartnerDocType;
  fallback: boolean;
};
export type PartnerEvidence = { doc_type: string; version: string };

export const partnerDocumentConfig = rawConfig as PartnerDocumentConfig;

export function partnerFlag(value: unknown): PartnerFlag {
  return value === "on" || value === "org" ? value : "off";
}

export function partnerGateEnabled(global: unknown, override: unknown): boolean {
  const flag = partnerFlag(global);
  return flag === "on" ? override !== false : flag === "org" && override === true;
}

export function parsePartnerDocumentConfig(value: unknown): PartnerDocumentConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("partner config");
  const config = value as PartnerDocumentConfig;
  if (typeof config.default_locale !== "string" || !config.default_locale.trim()
      || !config.documents || typeof config.documents !== "object") throw new Error("partner config");
  for (const type of PARTNER_DOC_TYPES) {
    const entries = config.documents[type];
    if (!Array.isArray(entries) || !entries.length) throw new Error("partner config entries");
    const locales = new Set<string>();
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") throw new Error("partner config entry");
      for (const key of ["locale", "version", "effective_date", "full_text_url", "source", "sha256"] as const) {
        if (typeof entry[key] !== "string" || !entry[key].trim()) throw new Error("partner config field");
      }
      if (locales.has(entry.locale)) throw new Error("partner config duplicate locale");
      locales.add(entry.locale);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.effective_date)
          || !Number.isFinite(Date.parse(entry.effective_date))
          || new Date(entry.effective_date).toISOString().slice(0, 10) !== entry.effective_date
          || !/^[0-9a-f]{64}$/.test(entry.sha256)
          || !entry.full_text_url.startsWith("/") || entry.full_text_url.startsWith("//")
          || !entry.source.startsWith("content/") || entry.source.split("/").includes("..")
          || !entry.source.endsWith(".md")) throw new Error("partner config field");
    }
    if (!locales.has(config.default_locale)) throw new Error("partner config fallback");
  }
  return config;
}

export function selectPartnerDocuments(
  locale: string,
  config: PartnerDocumentConfig = partnerDocumentConfig,
): SelectedPartnerDocument[] {
  parsePartnerDocumentConfig(config);
  return PARTNER_DOC_TYPES.map((doc_type) => {
    const entries = config.documents[doc_type];
    const own = entries.find((entry) => entry.locale === locale);
    const entry = own ?? entries.find((entry) => entry.locale === config.default_locale)!;
    return { ...entry, doc_type, fallback: !own };
  });
}

export function partnerDocumentIntegrity(entry: PartnerDocument, text: string): boolean {
  if (createHash("sha256").update(text, "utf8").digest("hex") !== entry.sha256) return false;
  for (const [name, expected] of [["版本", entry.version], ["生效日期", entry.effective_date]]) {
    const pattern = new RegExp("^[ \\t]*(?:-[ \\t]*)?" + name + "：[ \\t]*(.*?)[ \\t]*$", "gm");
    for (const match of text.matchAll(pattern)) {
      if (match[1] !== expected) return false;
    }
  }
  return true;
}

export function partnerConsentCovered(
  docs: readonly SelectedPartnerDocument[],
  rows: readonly PartnerEvidence[],
): boolean {
  return docs.length === PARTNER_DOC_TYPES.length
    && docs.every((doc) => rows.some((row) => row.doc_type === doc.doc_type && row.version === doc.version));
}

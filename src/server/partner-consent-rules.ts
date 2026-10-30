import { createHash } from "node:crypto";
import rawConfig from "../../config/partner-consent-documents.json";
import { PRIVACY_VERSION } from "./legal-versions";

export const PARTNER_DOC_TYPES = ["privacy", "partner_agreement"] as const;
export type PartnerDocType = (typeof PARTNER_DOC_TYPES)[number];
export type PartnerFlag = "off" | "org" | "on";
export type PartnerDocument = {
  locale: string;
  version: string;
  effective_date: string;
  full_text_url: string;
  source: string;
  sha256?: string;
  min_privacy_version?: string;
};
export type PartnerDocumentConfig = {
  default_locale: string;
  documents: Record<PartnerDocType, PartnerDocument[]>;
};
export type SelectedPartnerDocument = PartnerDocument & {
  doc_type: PartnerDocType;
  fallback: boolean;
  sha256: string;
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

export function partnerISODate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
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
      for (const key of ["locale", "version", "effective_date", "full_text_url", "source"] as const) {
        if (typeof entry[key] !== "string" || !entry[key].trim()) throw new Error("partner config field");
      }
      if (locales.has(entry.locale)) throw new Error("partner config duplicate locale");
      locales.add(entry.locale);
      if (!partnerISODate(entry.effective_date)
          || !entry.full_text_url.startsWith("/") || entry.full_text_url.startsWith("//")
          || !entry.source.startsWith("content/") || entry.source.split("/").includes("..")
          || !entry.source.endsWith(".md")) throw new Error("partner config field");
      if (type === "privacy") {
        if (!partnerISODate(entry.min_privacy_version)) throw new Error("privacy: invalid minimum");
      } else if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
        throw new Error("partner_agreement: invalid sha256");
      }
    }
    if (!locales.has(config.default_locale)) throw new Error("partner config fallback");
  }
  return config;
}

export function selectPartnerDocuments(
  locale: string,
  config: PartnerDocumentConfig = partnerDocumentConfig,
  privacyVersion: string = PRIVACY_VERSION,
): SelectedPartnerDocument[] {
  parsePartnerDocumentConfig(config);
  return PARTNER_DOC_TYPES.map((doc_type) => {
    const entries = config.documents[doc_type];
    const own = entries.find((entry) => entry.locale === locale);
    const entry = own ?? entries.find((entry) => entry.locale === config.default_locale)!;
    return {
      ...entry, doc_type, fallback: !own, sha256: entry.sha256 ?? "",
      version: doc_type === "privacy" ? `${entry.version}@${privacyVersion}` : entry.version,
    };
  });
}

/** A single header avoids ambiguous evidence when a document contains duplicates. */
export function partnerDocumentHeader(text: string, name: string): string | null {
  const pattern = new RegExp("^[ \\t]*(?:-[ \\t]*)?" + name + "：[ \\t]*(.*?)[ \\t]*$", "gm");
  const matches = [...text.matchAll(pattern)];
  if (matches.length > 1) throw new Error("duplicate document header");
  return matches[0]?.[1] ?? null;
}

/** This also computes the exact served UTF-8 byte hash used at signing. */
export function resolvePartnerDocument(
  entry: SelectedPartnerDocument,
  text: string,
  privacyVersion: string = PRIVACY_VERSION,
): SelectedPartnerDocument {
  const actual = createHash("sha256").update(text, "utf8").digest("hex");
  if (entry.doc_type === "privacy") {
    if (!partnerISODate(privacyVersion)) throw new Error("privacy: invalid PRIVACY_VERSION");
    if (!partnerISODate(entry.min_privacy_version)) throw new Error("privacy: invalid minimum");
    if (privacyVersion < entry.min_privacy_version) {
      throw new Error(`privacy: PRIVACY_VERSION ${privacyVersion} < min ${entry.min_privacy_version} — merge privacy v4.1+ before enabling design_partner_consent_gate`);
    }
    const version = partnerDocumentHeader(text, "版本");
    if (!version?.trim()) throw new Error("privacy: missing 版本 header");
    if (partnerDocumentHeader(text, "生效日期") !== privacyVersion) {
      throw new Error(`privacy: 生效日期 header must equal PRIVACY_VERSION ${privacyVersion}`);
    }
    return { ...entry, version: `${version}@${privacyVersion}`, effective_date: privacyVersion, sha256: actual };
  }
  if (actual !== entry.sha256) {
    throw new Error(`partner_agreement: sha256 expected=${entry.sha256} actual=${actual}`);
  }
  for (const [name, expected] of [["版本", entry.version], ["生效日期", entry.effective_date]]) {
    const header = partnerDocumentHeader(text, name);
    if (header !== null && header !== expected) throw new Error(`partner_agreement: header ${name} mismatch`);
  }
  return { ...entry, sha256: actual };
}

export function partnerConsentCovered(
  docs: readonly SelectedPartnerDocument[],
  rows: readonly PartnerEvidence[],
): boolean {
  return docs.length === PARTNER_DOC_TYPES.length
    && docs.every((doc) => rows.some((row) => row.doc_type === doc.doc_type && row.version === doc.version));
}

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function iso(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}

function header(text, name) {
  const matches = [...text.matchAll(new RegExp("^[ \\t]*(?:-[ \\t]*)?" + name + "：[ \\t]*(.*?)[ \\t]*$", "gm"))];
  if (matches.length > 1) throw new Error(`duplicate ${name} header`);
  return matches[0]?.[1] ?? null;
}

export function checkPartnerDocuments(root = process.cwd()) {
  const errors = [];
  try {
    const config = JSON.parse(readFileSync(resolve(root, "config/partner-consent-documents.json"), "utf8"));
    const legal = readFileSync(resolve(root, "src/server/legal-versions.ts"), "utf8");
    const versions = [...legal.matchAll(/export\s+const\s+PRIVACY_VERSION\s*=\s*["']([^"']+)["']/g)];
    if (versions.length !== 1) throw new Error("privacy: cannot read one PRIVACY_VERSION constant");
    const privacyVersion = versions[0][1];
    if (typeof config.default_locale !== "string" || !config.default_locale.trim()) throw new Error("default_locale");
    for (const type of ["privacy", "partner_agreement"]) {
      const entries = config.documents?.[type];
      if (!Array.isArray(entries) || !entries.length
          || !entries.some((entry) => entry.locale === config.default_locale)) throw new Error(type + ": entries/fallback");
      const locales = new Set();
      for (const entry of entries) {
        try {
          if (locales.has(entry.locale)) throw new Error("duplicate locale");
          locales.add(entry.locale);
          for (const key of ["locale", "version", "effective_date", "full_text_url", "source"]) {
            if (typeof entry[key] !== "string" || !entry[key].trim()) throw new Error("invalid " + key);
          }
          if (!iso(entry.effective_date)
              || !entry.full_text_url.startsWith("/") || entry.full_text_url.startsWith("//")
              || !entry.source.startsWith("content/") || entry.source.split("/").includes("..")
              || !entry.source.endsWith(".md")) throw new Error("invalid fields");
          const bytes = readFileSync(resolve(root, entry.source));
          const actual = createHash("sha256").update(bytes).digest("hex");
          const text = bytes.toString("utf8");
          if (type === "privacy") {
            if (!iso(entry.min_privacy_version)) throw new Error("invalid min_privacy_version");
            if (!iso(privacyVersion)) throw new Error("invalid PRIVACY_VERSION");
            if (privacyVersion < entry.min_privacy_version) {
              throw new Error(`PRIVACY_VERSION ${privacyVersion} < min ${entry.min_privacy_version} — merge privacy v4.1+ before enabling design_partner_consent_gate`);
            }
            if (!header(text, "版本")?.trim()) throw new Error("missing 版本 header");
            if (header(text, "生效日期") !== privacyVersion) {
              throw new Error(`生效日期 header must equal PRIVACY_VERSION ${privacyVersion}`);
            }
          } else {
            if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) throw new Error("invalid sha256");
            if (actual !== entry.sha256) throw new Error(`sha256 expected=${entry.sha256} actual=${actual}`);
            for (const [name, expected] of [["版本", entry.version], ["生效日期", entry.effective_date]]) {
              const value = header(text, name);
              if (value !== null && value !== expected) throw new Error(`header ${name} mismatch`);
            }
          }
        } catch (error) {
          errors.push(`${type}/${entry?.locale}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  } catch (error) {
    errors.push(`partner consent config: ${error instanceof Error ? error.message : String(error)}`);
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const errors = checkPartnerDocuments();
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else {
    console.log("partner consent documents: OK");
  }
}

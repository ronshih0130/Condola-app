import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
let failures = 0;
try {
  const config = JSON.parse(readFileSync(resolve(root, "config/partner-consent-documents.json"), "utf8"));
  if (typeof config.default_locale !== "string" || !config.default_locale) throw new Error("default_locale");
  for (const type of ["privacy", "partner_agreement"]) {
    const entries = config.documents?.[type];
    if (!Array.isArray(entries) || !entries.length
        || !entries.some((entry) => entry.locale === config.default_locale)) throw new Error(type + ": entries/fallback");
    const locales = new Set();
    for (const entry of entries) {
      try {
        if (locales.has(entry.locale)) throw new Error("duplicate locale");
        locales.add(entry.locale);
        for (const key of ["locale", "version", "effective_date", "full_text_url", "source", "sha256"]) {
          if (typeof entry[key] !== "string" || !entry[key].trim()) throw new Error("invalid " + key);
        }
        if (!/^[0-9a-f]{64}$/.test(entry.sha256)
            || !/^\d{4}-\d{2}-\d{2}$/.test(entry.effective_date)
            || !Number.isFinite(Date.parse(entry.effective_date))
            || new Date(entry.effective_date).toISOString().slice(0, 10) !== entry.effective_date
            || !entry.full_text_url.startsWith("/") || entry.full_text_url.startsWith("//")
            || !entry.source.startsWith("content/") || entry.source.split("/").includes("..")
            || !entry.source.endsWith(".md")) throw new Error("invalid fields");
        const bytes = readFileSync(resolve(root, entry.source));
        const actual = createHash("sha256").update(bytes).digest("hex");
        if (actual !== entry.sha256) throw new Error(`sha256 expected=${entry.sha256} actual=${actual}`);
        const text = bytes.toString("utf8");
        for (const [name, expected] of [["版本", entry.version], ["生效日期", entry.effective_date]]) {
          const pattern = new RegExp("^[ \\t]*(?:-[ \\t]*)?" + name + "：[ \\t]*(.*?)[ \\t]*$", "gm");
          for (const match of text.matchAll(pattern)) {
            if (match[1] !== expected) throw new Error("header " + name);
          }
        }
      } catch (error) {
        failures++;
        console.error(`${type}/${entry.locale}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
} catch (error) {
  failures++;
  console.error(`partner consent config: ${error instanceof Error ? error.message : String(error)}`);
}
if (failures) process.exitCode = 1;
else console.log("partner consent documents: OK");

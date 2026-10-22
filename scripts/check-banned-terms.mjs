#!/usr/bin/env node
/**
 * Banned-word check. Product Marketing owns config/banned_terms.md.
 *
 * Strip every allowlisted phrase (longest first), then fail if a banned term remains.
 * CI, scripts/qa/smoke.sh, and Playwright must call this script rather than
 * keeping their own copies of the list.
 *
 *   node scripts/check-banned-terms.mjs
 *   node scripts/check-banned-terms.mjs --html page.html --label /
 *   node scripts/check-banned-terms.mjs --html-stdin --label /login
 *
 * Hits print as file:line: term. Exit 0 when clean, 1 on a hit, 2 on a bad list or invocation.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const TERMS_PATH = join(repoRoot, "config", "banned_terms.md");

const TEMPLATE_FILES = ["src/server/mail-copy.ts", "src/line-copy.ts"];

export function loadTerms(markdown) {
  const banned = [];
  const allow = [];
  let section = "";
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const name = heading[1].toLowerCase();
      if (name === "banned" || name.startsWith("禁用")) section = "banned";
      else if (name === "allow" || name.startsWith("白名單")) section = "allow";
      else section = "";
      continue;
    }
    if (!section || !line) continue;
    const item = /^[-*]\s+(.+)$/.exec(line);
    const term = (item ? item[1] : line).trim().replace(/^`+|`+$/g, "").trim();
    if (!term) continue;
    (section === "banned" ? banned : allow).push(term);
  }
  const unique = (list) => [...new Set(list)];
  const terms = { banned: unique(banned), allow: unique(allow) };
  if (terms.banned.length === 0 || terms.allow.length === 0) {
    throw new Error("config/banned_terms.md needs a 禁用 list and a 白名單 list");
  }
  const overlap = terms.banned.filter((term) => terms.allow.includes(term));
  if (overlap.length > 0) {
    throw new Error(`terms listed as both banned and allowed: ${overlap.join(", ")}`);
  }
  return terms;
}

export function readTerms(path = TERMS_PATH) {
  return loadTerms(readFileSync(path, "utf8"));
}

function codePoint(value) {
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return "";
  try {
    return String.fromCodePoint(value);
  } catch {
    return "";
  }
}

export function decodeEscapes(text) {
  return text
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, hex) => codePoint(Number.parseInt(hex, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => codePoint(Number.parseInt(hex, 16)))
    .replace(/&#x([0-9a-fA-F]+);/gi, (_, hex) => codePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => codePoint(Number.parseInt(dec, 10)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

/** Drop script and style bodies without shifting line numbers. */
export function blankNonContent(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (block) => block.replace(/[^\n]/g, " "))
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, (block) => block.replace(/[^\n]/g, " "));
}

/** Drop comments. String and template contents stay, and line numbers stay. */
export function stripComments(source) {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      i += 2;
      while (i < n && source[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") out += "\n";
        i += 1;
      }
      i = Math.min(n, i + 2);
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i += 1;
      while (i < n) {
        const ch = source[i];
        out += ch;
        i += 1;
        if (ch === "\\") {
          if (i < n) {
            out += source[i];
            i += 1;
          }
          continue;
        }
        if (ch === quote) break;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

export function applyAllowlist(text, allow) {
  const phrases = [...allow].filter(Boolean).sort((a, b) => b.length - a.length);
  let out = text;
  for (const phrase of phrases) out = out.split(phrase).join("\u0000");
  return out;
}

export function findHits(text, terms, label, options = {}) {
  let prepared = options.html ? blankNonContent(text) : text;
  if (!options.html && options.code) prepared = stripComments(prepared);
  prepared = applyAllowlist(decodeEscapes(prepared), terms.allow);
  const hits = [];
  prepared.split("\n").forEach((line, index) => {
    for (const term of terms.banned) {
      if (term && line.includes(term)) hits.push({ file: label, line: index + 1, term });
    }
  });
  return hits;
}

export function formatHit(hit) {
  return `${hit.file}:${hit.line}: ${hit.term}`;
}

function walk(dir, acc) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, acc);
    else acc.push(path);
  }
}

export function sourceFiles(root = repoRoot) {
  const files = [];
  const i18n = join(root, "src", "i18n");
  if (existsSync(i18n)) {
    for (const name of readdirSync(i18n)) {
      if (name.endsWith(".json")) files.push(join(i18n, name));
    }
  }
  for (const dir of ["app", "components"]) {
    const abs = join(root, "src", dir);
    if (!existsSync(abs)) continue;
    const acc = [];
    walk(abs, acc);
    for (const path of acc) {
      if (!path.endsWith(".tsx") || path.endsWith(".test.tsx")) continue;
      files.push(path);
    }
  }
  for (const rel of TEMPLATE_FILES) {
    const abs = join(root, rel);
    if (existsSync(abs)) files.push(abs);
  }
  return files;
}

export function scanSources(root, terms) {
  const hits = [];
  for (const file of sourceFiles(root)) {
    const label = relative(root, file).split(sep).join("/");
    const code = !file.endsWith(".json");
    hits.push(...findHits(readFileSync(file, "utf8"), terms, label, { code }));
  }
  return hits;
}

function printHits(hits) {
  for (const hit of hits) process.stdout.write(`${formatHit(hit)}\n`);
}

export function main(argv = process.argv.slice(2)) {
  const htmlFiles = [];
  let htmlStdin = false;
  let label = "";
  let pendingLabel = "";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--html") {
      const file = argv[++i];
      if (!file) {
        process.stderr.write("missing path after --html\n");
        return 2;
      }
      htmlFiles.push({ file, label: pendingLabel || file });
      pendingLabel = "";
      continue;
    }
    if (arg === "--html-stdin") {
      htmlStdin = true;
      label = pendingLabel || "stdin";
      pendingLabel = "";
      continue;
    }
    if (arg === "--label") {
      pendingLabel = argv[++i] ?? "";
      if (!pendingLabel) {
        process.stderr.write("missing name after --label\n");
        return 2;
      }
      continue;
    }
    process.stderr.write(`unknown argument: ${arg}\n`);
    return 2;
  }
  if (pendingLabel && htmlStdin) label = pendingLabel;
  if (htmlStdin && htmlFiles.length > 0) {
    process.stderr.write("use either --html or --html-stdin\n");
    return 2;
  }

  let terms;
  try {
    terms = readTerms();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  try {
    if (htmlStdin) {
      const text = readFileSync(0, "utf8");
      const hits = findHits(text, terms, label, { html: true });
      printHits(hits);
      return hits.length === 0 ? 0 : 1;
    }
    if (htmlFiles.length > 0) {
      const hits = [];
      for (const item of htmlFiles) {
        hits.push(...findHits(readFileSync(item.file, "utf8"), terms, item.label, { html: true }));
      }
      printHits(hits);
      return hits.length === 0 ? 0 : 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const hits = scanSources(repoRoot, terms);
  printHits(hits);
  if (hits.length === 0) process.stderr.write("banned terms: clean\n");
  else process.stderr.write(`banned terms: ${hits.length} hit(s)\n`);
  return hits.length === 0 ? 0 : 1;
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) process.exit(main());

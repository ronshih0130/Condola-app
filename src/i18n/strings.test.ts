import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

const locales = ["zh-TW", "en"] as const;

function read(path: string) {
  return readFileSync(path, "utf8");
}

function catalog(kind: "app" | "prototype", locale: (typeof locales)[number]) {
  const path =
    kind === "app" ? join(root, "src/i18n", `${locale}.json`) : join(root, "design/strings", `${locale}.json`);
  return JSON.parse(read(path)) as Record<string, string>;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".open-next",
  ".git",
  "coverage",
  "playwright-report",
  "test-results",
  ".wrangler",
  "out",
  "dist",
]);

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

/** Import-column aliases. Bare 房東 is allowed only as its own quoted header, not inside a sentence. */
const OWNER_IMPORT_ALIASES = ["房東姓名", "房東email", "房東 email", "房東信箱", "房東"];

function residualOwnerTerm(source: string) {
  let text = decodeUnicodeEscapes(source);
  for (const alias of OWNER_IMPORT_ALIASES) {
    for (const quote of ['"', "'", "`"]) text = text.split(`${quote}${alias}${quote}`).join(`${quote}${quote}`);
  }
  const at = text.indexOf("房東");
  if (at < 0) return "";
  return text.slice(Math.max(0, at - 24), at + 24).replaceAll("\n", " ");
}

function ownerTermScanFiles() {
  const files = new Set<string>();
  for (const dir of ["src/app", "src/components", "src/server", "e2e"]) {
    for (const file of filesUnder(join(root, dir))) {
      if (/\.(ts|tsx|js|jsx|mjs|cjs|json|sql)$/.test(file)) files.add(file);
    }
  }
  for (const file of filesUnder(root)) {
    if (file.endsWith(".json")) files.add(file);
  }
  return [...files];
}

function placeholders(value: string) {
  return [...value.matchAll(/\{[A-Za-z0-9_]+\}/g)].map((match) => match[0]).sort();
}

function decodeUnicodeEscapes(source: string) {
  return source.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/** Non-comment lines in the import fixture. The bare 房東 alias is listed on its own line. */
function legacyImportAliases() {
  return read(join(root, "design/strings/import-column-headers.txt"))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

test("shared catalog keys match the vendored prototype", () => {
  for (const locale of locales) {
    const app = catalog("app", locale);
    const proto = catalog("prototype", locale);
    const mismatches = Object.keys(app).filter((key) => Object.prototype.hasOwnProperty.call(proto, key) && app[key] !== proto[key]);
    assert.deepEqual(mismatches, [], `${locale} shared keys differ: ${mismatches.join(", ")}`);
  }
});

test("shared keys use the prototype placeholders", () => {
  for (const locale of locales) {
    const app = catalog("app", locale);
    const proto = catalog("prototype", locale);
    const mismatches: string[] = [];
    for (const key of Object.keys(app)) {
      if (!Object.prototype.hasOwnProperty.call(proto, key)) continue;
      const appPlaceholders = placeholders(String(app[key]));
      const protoPlaceholders = placeholders(String(proto[key]));
      if (appPlaceholders.join(" ") !== protoPlaceholders.join(" ")) {
        mismatches.push(`${key} app [${appPlaceholders.join(" ")}] prototype [${protoPlaceholders.join(" ")}]`);
      }
    }
    assert.deepEqual(mismatches, [], `${locale} placeholder mismatch`);
  }
});

test("房東 is absent outside import-header aliases", () => {
  assert.equal(residualOwnerTerm('請選擇房東'), "請選擇房東");
  assert.equal(residualOwnerTerm('"房東姓名"'), "");
  assert.equal(residualOwnerTerm("'房東'"), "");
  assert.equal(residualOwnerTerm('"房東email"'), "");
  assert.equal(residualOwnerTerm('"房東信箱"'), "");
  assert.equal(residualOwnerTerm('"\\u623f\\u6771"'), "");

  const hits = ownerTermScanFiles()
    .map((file) => {
      const snippet = residualOwnerTerm(read(file));
      return snippet ? `${relative(root, file)}: ${snippet}` : "";
    })
    .filter(Boolean);
  assert.deepEqual(hits, []);
});

test("legacy 房東 import headers stay aliases when the owner importer exists", async () => {
  const aliases = legacyImportAliases();
  for (const required of ["房東姓名", "房東", "房東email", "房東信箱"]) {
    assert.ok(aliases.includes(required), `fixture note is missing ${required}`);
  }

  const ownerImport = join(root, "src/server/owner-import.ts");
  if (!existsSync(ownerImport)) {
    // TODO: property/owner spreadsheet import is not implemented.
    // design/strings/import-column-headers.txt records the aliases to keep.
    const domain = read(join(root, "src/server/domain.ts"));
    assert.match(domain, /TODO\(owner-import\)/);
    assert.equal(domain.includes("房東"), false);
    return;
  }

  const source = decodeUnicodeEscapes(read(ownerImport));
  assert.equal(source.includes("房東"), false, "owner-import.ts must not spell the legacy word");
  const { LEGACY_OWNER_ALIASES, matchColumns } = await import("../server/owner-import");
  assert.deepEqual([...LEGACY_OWNER_ALIASES], aliases);
  const mapped = matchColumns(["房東姓名", "房東email", "房東信箱", "房東 email", "房東"]);
  assert.equal(mapped.ownerName, 0);
  assert.equal(mapped.ownerEmail, 1);
});

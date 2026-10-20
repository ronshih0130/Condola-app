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

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
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

function hasAlias(source: string, alias: string, aliases: string[]) {
  const decoded = decodeUnicodeEscapes(source);
  if (alias !== "房東") return decoded.includes(alias);
  let stripped = decoded;
  for (const other of aliases) {
    if (other !== "房東" && other.includes("房東")) stripped = stripped.split(other).join("");
  }
  return stripped.includes("房東");
}

test("shared catalog keys match the vendored prototype", () => {
  for (const locale of locales) {
    const app = catalog("app", locale);
    const proto = catalog("prototype", locale);
    const mismatches = Object.keys(app).filter((key) => Object.prototype.hasOwnProperty.call(proto, key) && app[key] !== proto[key]);
    assert.deepEqual(mismatches, [], `${locale} shared keys differ: ${mismatches.join(", ")}`);
  }
});

test("zh-TW UI strings do not use 房東", () => {
  const catalogPath = join(root, "src/i18n/zh-TW.json");
  assert.equal(read(catalogPath).includes("房東"), false, "src/i18n/zh-TW.json");

  const roots = [join(root, "src/app"), join(root, "src/components")];
  const hits: string[] = [];
  for (const dir of roots) {
    for (const file of filesUnder(dir)) {
      if (!/\.(tsx|ts)$/.test(file)) continue;
      if (read(file).includes("房東")) hits.push(relative(root, file));
    }
  }
  assert.deepEqual(hits, []);
});

test("legacy 房東 import headers stay aliases when the owner importer exists", () => {
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

  const source = read(ownerImport);
  for (const alias of aliases) {
    assert.equal(hasAlias(source, alias, aliases), true, `owner-import.ts must accept ${alias}`);
  }
  const decoded = decodeUnicodeEscapes(source);
  let leftover = decoded;
  for (const alias of [...aliases].sort((a, b) => b.length - a.length)) leftover = leftover.split(alias).join("");
  assert.equal(leftover.includes("房東"), false, "owner-import.ts has 房東 outside the legacy aliases");
});

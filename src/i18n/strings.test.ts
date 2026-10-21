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

const OWNER_STATEMENT_REASON =
  "本月代墊費用與代管費（{cost}）高於已繳租金（{rent}），差額請屋主補繳，或依委託約定從下期租金扣抵。";

const STATEMENT_COPY_KEYS = [
  "owner_owes",
  "owner_owes_reason",
  "i_opening",
  "i_rent_received",
  "i_other_income",
  "i_fee",
  "i_expenses",
  "i_payouts",
  "i_closing",
  "i_net_owner",
  "i_actor",
  "i_einvoice",
  "i_rent_this_month",
  "i_statement_list",
  "i_statement_empty",
  "i_generated",
  "i_not_generated",
  "i_preview",
  "i_preview_pending",
  "i_owner_nav_stmt",
  "i_nav_stmt",
  "i_back_list",
  "s_423eca6",
  "s_9baf5e0",
  "s_1bd133f",
  "s_705a524",
];

/** Page, owner portal, and print all render statement-document. There is no separate statement PDF. */
function statementSurfaceFiles() {
  const files = [
    join(root, "src/components/statement-document.tsx"),
    ...filesUnder(join(root, "src/app/m/statements")),
    ...filesUnder(join(root, "src/app/o/statements")),
  ];
  for (const dir of ["src", "design", "supabase"]) {
    for (const file of filesUnder(join(root, dir))) {
      if (/statement/i.test(file) && /\.(html|pdf|tsx|ts|txt)$/.test(file)) files.push(file);
    }
  }
  return [...new Set(files)].filter((file) => !/\.test\.[cm]?[jt]sx?$/.test(file));
}

test("owner statements say 已繳租金 and not 已收租金", () => {
  const zh = catalog("app", "zh-TW");
  const proto = catalog("prototype", "zh-TW");
  assert.equal(zh.owner_owes_reason, OWNER_STATEMENT_REASON);
  assert.equal(proto.owner_owes_reason, OWNER_STATEMENT_REASON);
  assert.equal(zh.i_rent_received, "已繳租金");

  const oldPhrase = "已收" + "租金";
  const files = statementSurfaceFiles();
  assert.ok(files.some((file) => file.endsWith(`${join("components", "statement-document.tsx")}`)));
  const hits: string[] = [];
  for (const file of files) {
    const source = decodeUnicodeEscapes(read(file));
    if (source.includes(oldPhrase)) hits.push(relative(root, file));
  }
  for (const key of STATEMENT_COPY_KEYS) {
    assert.equal(typeof zh[key], "string", key);
    if (zh[key].includes(oldPhrase)) hits.push(key);
    if (proto[key]?.includes(oldPhrase)) hits.push(`design ${key}`);
  }
  assert.deepEqual(hits, []);
  assert.match(read(join(root, "src/components/statement-document.tsx")), /owner_owes_reason/);
  assert.match(read(join(root, "src/app/m/statements/page.tsx")), /owner_owes/);
  assert.match(read(join(root, "src/app/o/statements/[id]/page.tsx")), /StatementDocument/);
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

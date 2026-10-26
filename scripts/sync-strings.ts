import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const locales = ["zh-TW", "en"] as const;

const sourceDir = process.argv[2];
if (!sourceDir) {
  console.error("Usage: npm run strings:sync -- <prototype-strings-dir>");
  console.error("The directory must contain zh-TW.json and en.json.");
  console.error("Copies them to design/strings and updates shared keys in src/i18n.");
  process.exit(1);
}

const source = resolve(sourceDir);

function readCatalog(path: string) {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
}

function samePath(a: string, b: string) {
  return resolve(a) === resolve(b);
}

/** Rewrite shared keys in the app catalog. Leaves app-only keys and key order alone. */
function syncSharedKeys(appPath: string, proto: Record<string, string>) {
  const lines = readFileSync(appPath, "utf8").split("\n");
  let changed = 0;
  const out = lines.map((line) => {
    const match = line.match(/^ ("([^"]+)"): (.*)$/);
    if (!match) return line;
    const key = match[2];
    if (!Object.prototype.hasOwnProperty.call(proto, key)) return line;
    const comma = match[3].endsWith(",");
    const literal = comma ? match[3].slice(0, -1) : match[3];
    const next = JSON.stringify(proto[key]);
    if (next === literal) return line;
    changed += 1;
    return ` ${match[1]}: ${next}${comma ? "," : ""}`;
  });
  if (changed > 0) writeFileSync(appPath, out.join("\n"));
  return changed;
}

for (const locale of locales) {
  const from = resolve(source, `${locale}.json`);
  const vendored = resolve(root, "design/strings", `${locale}.json`);
  const appPath = resolve(root, "src/i18n", `${locale}.json`);
  if (!existsSync(from)) {
    console.error(`Missing ${from}`);
    process.exit(1);
  }
  const proto = readCatalog(from);
  if (!samePath(from, vendored)) copyFileSync(from, vendored);
  const app = readCatalog(appPath);
  const changed = syncSharedKeys(appPath, proto);
  const prototypeOnly = Object.keys(proto).filter((key) => !Object.prototype.hasOwnProperty.call(app, key));
  console.log(
    `${locale}: vendored ${Object.keys(proto).length} keys, updated ${changed} shared app keys, ${prototypeOnly.length} prototype-only keys left out of src/i18n`,
  );
}

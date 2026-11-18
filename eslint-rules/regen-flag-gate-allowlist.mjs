// Regenerate eslint-rules/flag-gate-allowlist.json and eslint-rules/flag-gate-baseline.json from the
// CURRENT tree, using the exact AST counter the lint rule uses (countFlagChecks). Run ONCE to set the
// baseline after changing the rule:
//
//   node eslint-rules/regen-flag-gate-allowlist.mjs
//
// It writes both files and prints the JSON. The test does NOT auto-regenerate; it reads the files.
// History-based "only decreases vs merge-base" enforcement is NOT done here — it belongs to the
// check-pr-rules job (slice item 1/3), which compares per-file allowances against the base revision.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { countFlagChecks } from "./flag-gate.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const appDir = path.join(repoRoot, "src", "app");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = walk(appDir).sort();
const counts = {};
for (const file of files) {
  const count = await countFlagChecks(readFileSync(file, "utf8"), file);
  if (count > 0) {
    const rel = path.relative(repoRoot, file).split(path.sep).join("/");
    counts[rel] = count;
  }
}

const allowlist = Object.fromEntries(Object.keys(counts).sort().map((k) => [k, counts[k]]));
const total = Object.values(allowlist).reduce((a, b) => a + b, 0);

writeFileSync(path.join(here, "flag-gate-allowlist.json"), `${JSON.stringify(allowlist, null, 2)}\n`);
writeFileSync(path.join(here, "flag-gate-baseline.json"), `${JSON.stringify({ total }, null, 2)}\n`);

process.stdout.write(`${JSON.stringify({ baseline: { total }, allowlist }, null, 2)}\n`);

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = new URL("../", import.meta.url);

function testFiles(directory: string): string[] {
  return readdirSync(new URL(`${directory}/`, root), { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return entry.isFile() && /\.test\.(?:tsx?|mjs)$/.test(entry.name) ? [path] : [];
  });
}

test("every source and script test is explicitly referenced by a package.json script", () => {
  const { scripts } = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
    scripts: Record<string, string>;
  };
  // Match complete literal paths, not substrings such as foo.test.ts within foo.test.tsx.
  const references = new Set(Object.values(scripts).flatMap(command =>
    [...command.matchAll(/(?:^|[\s"'])(?:\.\/)?((?:src|scripts)\/[^\s"']+\.test\.(?:tsx?|mjs))(?=$|[\s"';&|])/g)]
      .map(match => match[1]),
  ));
  const missing = [...testFiles("src"), ...testFiles("scripts")].filter(path => !references.has(path)).sort();
  assert.deepEqual(missing, [], `Unregistered tests: add each to the appropriate package.json script:\n${missing.join("\n")}`);
});

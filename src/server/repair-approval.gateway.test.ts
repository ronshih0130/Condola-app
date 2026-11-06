import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import test from "node:test";

const src = resolve(process.cwd(), "src");
const servicePath = join(src, "server", "repair-approval.ts");

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : entry.isFile() ? [path] : [];
  });
}

test("B-013 has no production caller", () => {
  const callers: string[] = [];
  for (const path of files(src)) {
    const name = basename(path);
    const local = relative(src, path).replaceAll("\\", "/");
    if (/^repair-approval.*\.ts$/.test(name)
      || /\.(?:test|spec)\.[^.]+$/.test(name)
      || /(?:^|\/)(?:__tests__|tests?|e2e)\//.test(local)) continue;
    const source = readFileSync(path, "utf8");
    // Covers static imports/re-exports, side-effect imports, import(), and require().
    const imports = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']([^"']+)["']/g;
    for (const match of source.matchAll(imports)) {
      if (/(?:^|\/)repair-approval(?:\.[cm]?[jt]sx?)?$/.test(match[1])) callers.push(local);
    }
  }
  assert.deepEqual(callers, [], "Build-only service must not have production callers");
});

test("B-013 service references only the six contracted gateways", () => {
  const source = readFileSync(servicePath, "utf8");
  const allowed = [
    "b013_submit_estimate",
    "b013_decide_estimate",
    "b013_authorize_emergency",
    "b013_record_appointment",
    "b013_emit_reminder",
    "b013_dispatch_allowed",
  ];
  const seen = new Set<string>();
  for (const match of source.matchAll(/\b(app|public)\.([a-z_][a-z0-9_]*)\b/gi)) {
    assert.equal(match[1], "app", "No direct public schema access");
    assert.ok(allowed.includes(match[2]), "Non-gateway reference: " + match[0]);
    assert.match(source.slice((match.index ?? 0) + match[0].length), /^\s*\(/);
    seen.add(match[2]);
  }
  assert.deepEqual([...seen].sort(), [...allowed].sort());
  assert.match(source, /svc\(session\.userId,/);
  assert.match(source, /Build-only \(B-013\)\. No production caller;/);
});

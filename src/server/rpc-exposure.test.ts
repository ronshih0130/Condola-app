import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

function read(file: string) {
  return readFileSync(file, "utf8");
}

function walkSources(dir: string): string {
  const chunks: string[] = [];
  function walk(current: string) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) chunks.push(read(full));
    }
  }
  walk(dir);
  return chunks.join("\n");
}

function resolveImport(fromFile: string, spec: string): string | null {
  const base = spec.startsWith("@/")
    ? path.join("src", spec.slice(2))
    : spec.startsWith(".")
      ? path.resolve(path.dirname(fromFile), spec)
      : null;
  if (!base) return null;
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, path.join(base, "index.ts"), path.join(base, "index.tsx")];
  return candidates.find((candidate) => {
    try {
      return readFileSync(candidate, "utf8") !== undefined;
    } catch {
      return false;
    }
  }) ?? null;
}

function clientGraph(): string[] {
  const files: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
    }
  }
  walk("src");
  const seen = new Set<string>();
  const queue = files.filter((file) => read(file).startsWith('"use client"') || read(file).startsWith("'use client'"));
  const bundled: string[] = [];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = read(file);
    if (source.startsWith('"use server"') || source.startsWith("'use server'")) continue;
    bundled.push(file);
    for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
      const next = resolveImport(file, match[1]);
      if (next) queue.push(next);
    }
  }
  return bundled;
}

test("the browser bundle has no Supabase client or RPC URL", () => {
  assert.doesNotMatch(read("package.json"), /@supabase\//);
  const bundled = clientGraph();
  assert.ok(bundled.some((file) => file.endsWith("auth-hash.tsx")));
  const joined = bundled.map((file) => read(file)).join("\n");
  assert.doesNotMatch(joined, /NEXT_PUBLIC_SUPABASE/);
  assert.doesNotMatch(joined, /SUPABASE_ANON_KEY/);
  assert.doesNotMatch(joined, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(joined, /createClient\s*\(/);
  assert.doesNotMatch(joined, /\/rest\/v1\/rpc/);
  assert.doesNotMatch(joined, /@supabase\//);
  assert.doesNotMatch(walkSources("src/app"), /rest\/v1\/rpc/);
});

test("the session cookie is an app token and tx pins app.active_org_id before SET ROLE", () => {
  const auth = read("src/server/auth.ts");
  assert.match(auth, /SESSION_COOKIE = "condola_session"/);
  assert.match(auth, /randomBytes\(32\)/);
  const db = read("src/server/db.ts");
  const pin = db.indexOf("set_config('app.active_org_id'");
  const role = db.indexOf("SET LOCAL ROLE authenticated");
  assert.ok(pin > 0 && pin < role);
  assert.match(db, /SET LOCAL ROLE service_role/);
});

test("the lock migration checks caller org and revokes the country trigger", () => {
  const sql = read("supabase/migrations/20261029150000_lock_public_function_execute.sql");
  assert.match(sql, /app\.active_org_id/);
  assert.match(sql, /current_user = 'authenticated'/);
  assert.match(sql, /transaction org mismatch/);
  assert.match(sql, /invoice org mismatch/);
  assert.match(sql, /public\.fn_org_country_setting\(\)/);
  assert.match(sql, /REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated/);
  assert.doesNotMatch(sql, /REVOKE EXECUTE ON FUNCTION public\.post_reversal/);
  assert.doesNotMatch(sql, /REVOKE EXECUTE ON FUNCTION public\.fn_invoice_recalc/);
  assert.doesNotMatch(sql, /REVOKE EXECUTE ON FUNCTION public\.line_lease_picker/);
  assert.doesNotMatch(sql, /REVOKE EXECUTE ON FUNCTION public\.condola_property_address_key/);
});

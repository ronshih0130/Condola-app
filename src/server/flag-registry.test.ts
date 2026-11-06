import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { isFlagSeed, literalFlagValue, platformSettingsSeeds, statements, tokenize, type Seed } from "./flag-registry-sql";

// PROP-05 (L1-FLAG): every flag seeded into platform_settings by a migration must be a
// disabled JSON literal with an empty allowlist, inserted with ON CONFLICT ... DO NOTHING,
// and registered in ops/flags.yaml (global_kill names platform_settings.<key>) with default: false.
const root = new URL("../..", import.meta.url).pathname;
const migrations = readdirSync(join(root, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
const yaml = readFileSync(join(root, "ops/flags.yaml"), "utf8");

function seedsOf(sql: string): Seed[] {
  return statements(tokenize(sql)).flatMap((stmt) => platformSettingsSeeds(stmt) ?? []);
}
function flagSeeds(): Array<Seed & { file: string }> {
  return migrations.flatMap((file) => seedsOf(readFileSync(join(root, "supabase/migrations", file), "utf8")).filter(isFlagSeed).map((s) => ({ ...s, file })));
}
function registry(): Map<string, string> {
  const out = new Map<string, string>();
  for (const block of yaml.split(/\n(?=  [A-Za-z0-9_]+:\n)/)) {
    const key = block.match(/global_kill:.*?platform_settings\.([A-Za-z0-9_]+)/)?.[1];
    if (key) out.set(key, block);
  }
  return out;
}
/** Violations for one set of flag seeds (exported shape used by the regression cases below). */
function violations(seeds: Array<Seed & { file?: string }>, reg: Map<string, string>): string[] {
  const out: string[] = [];
  for (const s of seeds) {
    const where = `${s.file ?? "sql"}: ${s.key ?? "<non-literal key>"}`;
    if (s.key === null) { out.push(`${where}: key must be a string literal`); continue; }
    const value = literalFlagValue(s);
    if (!value) out.push(`${where}: flag value must be a JSON literal`);
    else {
      if (value.enabled !== false) out.push(`${where}: seeded enabled`);
      if (!Array.isArray(value.allowed_org_ids) || value.allowed_org_ids.length) out.push(`${where}: seeded with an allowlist`);
    }
    if (s.conflict !== "nothing") out.push(`${where}: must use ON CONFLICT ... DO NOTHING`);
    const block = reg.get(s.key);
    if (!block) out.push(`${where}: not registered in ops/flags.yaml`);
    else if (!/\n    default: false\b/.test(block)) out.push(`${where}: registry default is not false`);
  }
  return out;
}

test("all migration flag seeds are disabled literals, ON CONFLICT DO NOTHING, and registered default false", () => {
  const seeds = flagSeeds();
  assert.ok(seeds.length > 10, "expected the existing flag seeds to be found");
  assert.deepEqual(violations(seeds, registry()), []);
  for (const [key, block] of registry()) assert.match(block, /\n    default: false\b/, `${key} not default false`);
});

test("regression: evasions are detected (reordered columns, jsonb_build_object, quoted names, commented ON CONFLICT, DO UPDATE)", () => {
  const reg = new Map([["probe", "  probe:\n    default: false\n"]]);
  const bad = [
    `INSERT INTO platform_settings (value, key) VALUES ('{"enabled":true,"allowed_org_ids":[]}'::jsonb, 'probe') ON CONFLICT (key) DO NOTHING;`,
    `INSERT INTO public.platform_settings(key,value) VALUES ('probe', jsonb_build_object('enabled', true, 'allowed_org_ids', '[]'::jsonb)) ON CONFLICT DO NOTHING;`,
    `INSERT INTO "public"."platform_settings" ("key","value") VALUES ('unregistered','{"enabled":false,"allowed_org_ids":[]}') ON CONFLICT DO NOTHING;`,
    `INSERT INTO platform_settings(key,value) VALUES ('probe','{"enabled":false,"allowed_org_ids":[]}') -- ON CONFLICT DO NOTHING\n;`,
    `INSERT INTO platform_settings(key,value) VALUES ('probe','{"enabled":false,"allowed_org_ids":[]}') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value;`,
  ];
  bad.push(
    `INSERT INTO platform_settings(description,key,value) VALUES (',','unregistered','{"enabled":true,"allowed_org_ids":[]}') ON CONFLICT DO NOTHING;`,
    `INSERT INTO platform_settings(key,value) VALUES ('probe','{"\\u0065nabled":true,"allowed_org_ids":[]}') ON CONFLICT DO NOTHING;`,
    `INSERT INTO platform_settings(key,value) VALUES ('probe',$j${"$"}{"enabled":true,"allowed_org_ids":[]}$j$) ON CONFLICT DO NOTHING;`,
    `/* outer /* inner */ INSERT INTO irrelevant */ INSERT INTO platform_settings(key,value) VALUES ('probe','{"enabled":true,"allowed_org_ids":[]}') ON CONFLICT DO NOTHING;`,
  );
  for (const sql of bad) assert.notDeepEqual(violations(seedsOf(sql).filter(isFlagSeed), reg), [], sql);
  const good = `INSERT INTO platform_settings(key,value,description) VALUES('probe','{"enabled":false,"allowed_org_ids":[]}'::jsonb,'first; second\nthird') ON CONFLICT(key) DO NOTHING;`;
  assert.deepEqual(violations(seedsOf(good).filter(isFlagSeed), reg), []);
});

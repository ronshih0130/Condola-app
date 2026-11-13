import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { isFlagSeed, platformSettingsSeeds, statements, tokenize } from "./flag-registry-sql";
import { stripSqlComments } from "./phase0-sql-text";

// Phase 0 guard (ADR-113 option A, static key check only). Two directions:
//   1. a flag key read from organizations.feature_flags or platform_settings in non-test src or in
//      a migration must be a key of ops/flags.yaml;
//   2. a key of ops/flags.yaml must be referenced by non-test src or by a migration.
// Today's known drift is listed below, one reason each; anything new fails. A listed exception
// that stops being true also fails, so the lists can only shrink.
// This file never reads expires_at and does not judge flag values or evaluation rules
// (flag-registry.test.ts covers migration seeds; scripts/flag-expiry-policy.cjs covers expiry).

/** Keys read at runtime that have no ops/flags.yaml entry of their own. owner: Ron/CEO (ADR-113). */
const UNREGISTERED_OK: Record<string, string> = {
  // owner: Ron/CEO (ADR-113 Q3) — real switches with no registry entry
  brand_v2: "org opt-in read by src/server/brand-v2.ts (env BRAND_V2 OR this key); never registered",
  vendor_dispatch: "org key read by repair-approval.ts and migration 20261030150200 (false = off, absent = on); never registered",
  go_live_lock: "platform_settings row read by org-scope.ts and platform.ts; never registered",
  design_partner_consent_gate: "three-state platform value + org override read by partner-consent.ts and staff-profile.ts; never registered",
  esign_disposal_enabled: "platform_settings row read by migration 20261030151600 (e-sign retention); never registered",
  ID_PURGE_ENABLED: "platform_settings row read by migration 20261031100203 (ID retention purge); never registered",
  // owner: Ron/CEO (ADR-113 Q8) — a platform_settings row that holds data, not an on/off switch
  partner_consent_approved_agreements: "not a flag: approved-agreement hashes read by migration 20261106200000; needs a registry record type or a permanent exclusion",
};

/**
 * Name drift: the registry entry is the env-style name, the database key is different.
 * org key -> registry key. owner: Ron/CEO (ADR-113 Q5). The test also checks that the registry
 * entry's own text names the org key, so a wrong pairing cannot be parked here.
 */
const NAME_DRIFT_OK: Record<string, { registry: string; reason: string }> = {
  esign: { registry: "ESIGN_ENABLED", reason: "registry lists the Worker var; code reads feature_flags.esign (src/server/esign/access.ts)" },
  tenant_signed_pdf: { registry: "TENANT_SIGNED_PDF_ENABLED", reason: "registry lists the Worker var; code and migrations read tenant_signed_pdf" },
  import_error_details: { registry: "IMPORT_ERROR_DETAILS_ENABLED", reason: "registry lists the Worker var; src/server/import-feature.ts reads flags.import_error_details" },
  paper_lease_versions: { registry: "PAPER_LEASE_VERSIONS_ENABLED", reason: "registry lists the Worker var; paper-lease-versions-rules.ts reads featureFlags.paper_lease_versions" },
};

/** Registry keys with no reference in non-test src or migrations. owner: Ron/CEO (ADR-113 Q4). Empty today. */
const UNREFERENCED_OK: Record<string, string> = {};

const KEY = "[A-Za-z_][A-Za-z0-9_]*";

/** Good enough for this scan: drops block comments and `//` comments that start a line or follow whitespace. */
export function stripTsComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\s)\/\/[^\n]*/g, "$1");
}

/**
 * Flag keys read through a literal key. `kind` "sql" = a migration; "ts" = TypeScript, where the
 * SQL patterns still apply because queries are written inline.
 *
 * Extracted:
 *   feature_flags -> 'k' | ->> 'k' | (feature_flags->'k')            (SQL, either file kind)
 *   platform_settings [alias] ... [alias.]key = 'k' | key IN ('a','b') (same statement, either kind)
 *   feature_flags.k | feature_flags?.k | feature_flags["k"]           (TS)
 *   flags.k === true | (featureFlags as Record<string, unknown>).k === true   (TS; receiver named
 *     flags / featureFlags / orgFlags, compared with a boolean)
 * NOT extracted (known limits): keys passed as a parameter (key=$2, flags[key]), keys built by
 * concatenation ('line_'||persona||'_portal'), CASE expressions, and one-letter receivers such as
 * `f.usage_events === true`. Those reads go through keys that direction 2 still ties to the registry.
 */
export function extractFlagKeys(source: string, kind: "sql" | "ts"): Set<string> {
  const text = kind === "sql" ? stripSqlComments(source) : stripTsComments(source);
  const keys = new Set<string>();

  for (const m of text.matchAll(new RegExp(String.raw`\bfeature_flags\s*\)?\s*->>?\s*'(${KEY})'(?!\s*\|\|)`, "g"))) keys.add(m[1]);

  for (const m of text.matchAll(/\bplatform_settings\b(?:\s+(?:AS\s+)?([A-Za-z_]\w*))?/gi)) {
    const alias = m[1]?.toLowerCase();
    const rest = text.slice(m.index + m[0].length);
    const window = rest.slice(0, Math.min(600, ...[rest.indexOf(";"), rest.indexOf("`")].filter((n) => n >= 0)));
    const owns = (qualifier: string | undefined) => !qualifier || qualifier.toLowerCase() === alias || qualifier.toLowerCase() === "platform_settings";
    // `feature_flags->f.key='true'::jsonb` compares the JSON value, not the key column: skip a key that is a `->` operand.
    for (const k of window.matchAll(new RegExp(String.raw`(?<![\w.$])(?<!->>?\s*)(?:(\w+)\s*\.\s*)?key\s*=\s*'(${KEY})'(?!\s*\|\|)`, "gi"))) if (owns(k[1])) keys.add(k[2]);
    for (const k of window.matchAll(/(?<![\w.$])(?:(\w+)\s*\.\s*)?key\s+IN\s*\(([^)]*)\)/gi)) {
      if (owns(k[1])) for (const lit of k[2].matchAll(new RegExp(String.raw`'(${KEY})'(?!\s*\|\|)`, "g"))) keys.add(lit[1]);
    }
  }

  if (kind === "ts") {
    for (const m of text.matchAll(new RegExp(String.raw`\bfeature_flags\s*(?:\?\.|\.)\s*(${KEY})\b(?!\s*\()`, "g"))) keys.add(m[1]);
    for (const m of text.matchAll(new RegExp(String.raw`\bfeature_flags\s*(?:\?\.)?\[\s*["'](${KEY})["']\s*\]`, "g"))) keys.add(m[1]);
    for (const m of text.matchAll(new RegExp(
      String.raw`\b(?:flags|featureFlags|orgFlags)\b(?:\s+as\s+Record<string,\s*unknown>\s*\))?\s*(?:\?\.|\.)\s*(${KEY})\s*[!=]==?\s*(?:true|false)\b`, "g",
    ))) keys.add(m[1]);
  }
  return keys;
}

/** Looser test used for direction 2 only: the key appears as a whole quoted literal or as an env read. */
export function mentionsKey(source: string, kind: "sql" | "ts", key: string): boolean {
  const text = kind === "sql" ? stripSqlComments(source) : stripTsComments(source);
  return new RegExp(String.raw`(['"\x60])${key}\1|\benv\s*(?:\?\.|\.)\s*${key}\b`).test(text);
}

/** Keys seeded into platform_settings as flags by a migration (existing PROP-05 scanner). */
function seededFlagKeys(sql: string): string[] {
  return statements(tokenize(sql)).flatMap((s) => platformSettingsSeeds(s) ?? []).filter(isFlagSeed).flatMap((s) => (s.key ? [s.key] : []));
}

/** Top-level keys under `flags:` with the text of each entry. */
export function registryEntries(yaml: string): Map<string, string> {
  const out = new Map<string, string>();
  const body = yaml.slice(yaml.search(/^flags:\s*$/m));
  const heads = [...body.matchAll(/^ {2}([A-Za-z0-9_]+):\s*$/gm)];
  heads.forEach((h, n) => {
    assert.ok(!out.has(h[1]), `ops/flags.yaml: duplicate key ${h[1]}`);
    out.set(h[1], body.slice(h.index, heads[n + 1]?.index ?? body.length));
  });
  return out;
}

type Source = { file: string; kind: "sql" | "ts"; text: string };
type Exceptions = { unregistered: Record<string, string>; drift: Record<string, { registry: string; reason: string }>; unreferenced: Record<string, string> };

/** All findings for one tree; pure, so the self-tests below can drive it with fixtures. */
export function flagKeyViolations(registry: Map<string, string>, sources: Source[], ex: Exceptions): string[] {
  const out: string[] = [];
  const usedIn = new Map<string, string[]>();
  for (const s of sources) for (const k of extractFlagKeys(s.text, s.kind)) usedIn.set(k, [...(usedIn.get(k) ?? []), s.file]);
  const seeded = new Set(sources.filter((s) => s.kind === "sql").flatMap((s) => seededFlagKeys(s.text)));

  // Direction 1: used but not registered.
  for (const [key, files] of [...usedIn].sort(([a], [b]) => a.localeCompare(b))) {
    if (registry.has(key) || key in ex.unregistered || key in ex.drift) continue;
    out.push(`flag key "${key}" is read in ${files.slice(0, 3).join(", ")}${files.length > 3 ? ` (+${files.length - 3} more)` : ""} but is not in ops/flags.yaml — register it (owner and expiry are set by Ron/CEO)`);
  }
  // Direction 2: registered but referenced nowhere.
  for (const key of registry.keys()) {
    if (usedIn.has(key) || seeded.has(key) || sources.some((s) => mentionsKey(s.text, s.kind, key))) {
      if (key in ex.unreferenced) out.push(`stale exception: registry key "${key}" is referenced again — remove it from UNREFERENCED_OK`);
      continue;
    }
    if (!(key in ex.unreferenced)) out.push(`ops/flags.yaml key "${key}" is not referenced by any non-test src file or migration — remove it or record why it is reserved`);
  }
  // Exceptions must stay true.
  for (const key of Object.keys(ex.unregistered)) {
    if (registry.has(key)) out.push(`stale exception: "${key}" is now in ops/flags.yaml — remove it from UNREGISTERED_OK`);
    else if (!usedIn.has(key)) out.push(`stale exception: "${key}" is no longer read anywhere — remove it from UNREGISTERED_OK`);
  }
  for (const [key, d] of Object.entries(ex.drift)) {
    const entry = registry.get(d.registry);
    if (registry.has(key)) out.push(`stale exception: "${key}" is now in ops/flags.yaml — remove it from NAME_DRIFT_OK`);
    else if (!usedIn.has(key)) out.push(`stale exception: "${key}" is no longer read anywhere — remove it from NAME_DRIFT_OK`);
    if (!entry) out.push(`name drift "${key}" points at registry key "${d.registry}", which is not in ops/flags.yaml`);
    else if (!new RegExp(String.raw`organizations\.feature_flags\.${key}\b`).test(entry)) out.push(`name drift "${key}": registry entry "${d.registry}" does not name organizations.feature_flags.${key}`);
  }
  for (const key of Object.keys(ex.unreferenced)) if (!registry.has(key)) out.push(`stale exception: "${key}" is not in ops/flags.yaml — remove it from UNREFERENCED_OK`);
  return out;
}

const root = new URL("../..", import.meta.url).pathname;
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}
function treeSources(): Source[] {
  const ts = walk(join(root, "src")).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !/\.d\.ts$/.test(f));
  const sql = readdirSync(join(root, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort().map((f) => join(root, "supabase/migrations", f));
  return [
    ...ts.map((f) => ({ file: relative(root, f), kind: "ts" as const, text: readFileSync(f, "utf8") })),
    ...sql.map((f) => ({ file: relative(root, f), kind: "sql" as const, text: readFileSync(f, "utf8") })),
  ];
}

test("flag keys read in src and migrations match ops/flags.yaml, apart from the listed exceptions", () => {
  const registry = registryEntries(readFileSync(join(root, "ops/flags.yaml"), "utf8"));
  const sources = treeSources();
  assert.ok(registry.size >= 50, `expected the registry to parse (got ${registry.size} keys)`);
  assert.ok(sources.length > 200, "expected src and migrations to be found");
  const used = new Set(sources.flatMap((s) => [...extractFlagKeys(s.text, s.kind)]));
  assert.ok(used.size >= 40, `expected the extractor to find the existing flag reads (got ${used.size})`);
  for (const reason of [...Object.values(UNREGISTERED_OK), ...Object.values(UNREFERENCED_OK), ...Object.values(NAME_DRIFT_OK).map((d) => d.reason)]) {
    assert.ok(reason.trim().length > 10, "every exception needs a reason");
  }
  const violations = flagKeyViolations(registry, sources, { unregistered: UNREGISTERED_OK, drift: NAME_DRIFT_OK, unreferenced: UNREFERENCED_OK });
  assert.deepEqual(violations, [], `flag registry drift (ADR-113):\n${violations.join("\n")}`);
});

const keysOf = (src: string, kind: "sql" | "ts") => [...extractFlagKeys(src, kind)].sort();

test("self-test: extractor reads the SQL forms used in this repo", () => {
  assert.deepEqual(keysOf(`SELECT 1 FROM organizations o JOIN platform_settings p ON p.key='bank_matching'
    WHERE o.feature_flags->'bank_matching'='true'::jsonb AND coalesce(o.feature_flags ->> 'vendor_dispatch','') IS DISTINCT FROM 'false'`, "sql"),
    ["bank_matching", "vendor_dispatch"]);
  assert.deepEqual(keysOf(`SELECT (feature_flags->'line_dispatch_push')='true'::jsonb, (o.feature_flags)->'esign' FROM public.organizations`, "sql"), ["esign", "line_dispatch_push"]);
  assert.deepEqual(keysOf(`SELECT (SELECT value FROM public.platform_settings WHERE key = 'go_live_lock'), 1`, "sql"), ["go_live_lock"]);
  assert.deepEqual(keysOf(`PERFORM 1 FROM public.platform_settings s WHERE s.key = 'esign_disposal_enabled' AND s.value = 'true'::jsonb;`, "sql"), ["esign_disposal_enabled"]);
  assert.deepEqual(keysOf(`SELECT key FROM platform_settings WHERE key IN ('company_profile_edit','design_partner_consent_gate') ORDER BY key`, "sql"),
    ["company_profile_edit", "design_partner_consent_gate"]);
  assert.deepEqual(keysOf(`UPDATE public.platform_settings SET value='{}' WHERE platform_settings.key='INVITE_RESEND_RESULTS';`, "sql"), ["INVITE_RESEND_RESULTS"]);
});

test("self-test: extractor ignores comments, other tables' key columns, values and built keys", () => {
  assert.deepEqual(keysOf(`-- feature_flags->'ghost_a'\n/* platform_settings WHERE key='ghost_b' */ SELECT 1;`, "sql"), []);
  // prefix literals of concatenated keys are not keys
  assert.deepEqual(keysOf(`SELECT o.feature_flags->('line_'||p||'_portal') FROM platform_settings f WHERE f.key='partner_' || p_kind;`, "sql"), []);
  assert.deepEqual(keysOf(`SELECT 1 FROM platform_settings WHERE key IN ('real_one','partner_' || p_kind);`, "sql"), ["real_one"]);
  // a different alias, the next statement, and string values are not platform_settings keys
  assert.deepEqual(keysOf(`SELECT 1 FROM platform_settings f JOIN other_table t ON t.key='not_a_flag' WHERE f.value->'enabled'='true'::jsonb;`, "sql"), []);
  assert.deepEqual(keysOf(`LOCK TABLE public.platform_settings IN SHARE MODE; SELECT 1 FROM idempotency WHERE key='not_a_flag';`, "sql"), []);
  assert.deepEqual(keysOf(`SELECT 1 FROM platform_settings f WHERE f.key=k.key AND f.value->'enabled'='true'::jsonb;`, "sql"), []);
  assert.deepEqual(keysOf(`SELECT 1 FROM platform_settings f JOIN organizations o ON true WHERE (o.feature_flags->f.key='true'::jsonb) IS TRUE;`, "sql"), []);
  assert.deepEqual(keysOf("// feature_flags.ghost_c and platform_settings.ghost_d\n/** feature_flags->'ghost_e' */\nexport const x = 1;", "ts"), []);
  // type annotations, method calls and unrelated objects named flags
  assert.deepEqual(keysOf("const r = await q<{ feature_flags: unknown }>(sql); if (flags.rows.length) nav(flags.property); row.feature_flags.toString();", "ts"), []);
});

test("self-test: extractor reads the TypeScript forms used in this repo", () => {
  assert.deepEqual(keysOf('const { rows } = await query("SELECT feature_flags -> \'brand_v2\' AS flag FROM public.organizations WHERE id = $1", [orgId]);', "ts"), ["brand_v2"]);
  assert.deepEqual(keysOf("await client.query(`SELECT (SELECT value FROM platform_settings WHERE key='pricing_interim') AS value,\n feature_flags FROM organizations WHERE id=$1`, [orgId]);\nconst other = `SELECT 1 FROM t WHERE key='not_a_flag'`;", "ts"), ["pricing_interim"]);
  assert.deepEqual(keysOf("return ok && row.feature_flags?.vendor_documents === true;", "ts"), ["vendor_documents"]);
  assert.deepEqual(keysOf('if (org.feature_flags["esign"] !== true || org.feature_flags.custom_roles) return;', "ts"), ["custom_roles", "esign"]);
  assert.deepEqual(keysOf("return (featureFlags as Record<string, unknown>).paper_lease_versions === true;", "ts"), ["paper_lease_versions"]);
  assert.deepEqual(keysOf("return flags.pricing_interim === true && orgFlags?.custom_roles !== false;", "ts"), ["custom_roles", "pricing_interim"]);
  assert.deepEqual(keysOf("const url = 'https://example.test/a'; // trailing note\nreturn flags.kept === true;", "ts"), ["kept"]);
});

test("self-test: registry parser and the looser reference test", () => {
  const reg = registryEntries(`# note\nflags:\n  alpha:\n    owner: Ron\n    org_override: "organizations.feature_flags.alpha"\n\n  BETA_ENABLED:\n    owner: Ron\n`);
  assert.deepEqual([...reg.keys()], ["alpha", "BETA_ENABLED"]);
  assert.match(reg.get("alpha") ?? "", /feature_flags\.alpha/);
  assert.throws(() => registryEntries("flags:\n  dup:\n    owner: Ron\n  dup:\n    owner: Ron\n"), /duplicate key dup/);
  assert.ok(mentionsKey('enabled(client, orgId, "owner_receipt_title")', "ts", "owner_receipt_title"));
  assert.ok(mentionsKey("process.env.ESIGN_ENABLED === 'true'", "ts", "ESIGN_ENABLED"));
  assert.ok(mentionsKey("IF NOT app.b014_flag_on(p_org,'owner_net_ledger') THEN", "sql", "owner_net_ledger"));
  assert.ok(!mentionsKey("// owner_receipt_title is mentioned only here", "ts", "owner_receipt_title"));
  assert.ok(!mentionsKey("-- 'owner_net_ledger'\nSELECT 'owner_net_ledger_v2';", "sql", "owner_net_ledger"));
});

test("self-test: drift is reported in both directions and exceptions cannot go stale", () => {
  const reg = registryEntries(`flags:\n  alpha:\n    org_override: "organizations.feature_flags.alpha"\n  BETA_ENABLED:\n    org_override: "organizations.feature_flags.beta must be true"\n  seeded_only:\n    owner: Ron\n`);
  const none: Exceptions = { unregistered: {}, drift: {}, unreferenced: {} };
  const src = (text: string, kind: "sql" | "ts" = "ts", file = "src/x.ts"): Source => ({ file, kind, text });
  const base = [
    src("const on = flags.alpha === true && process.env.BETA_ENABLED === 'true';"),
    src(`INSERT INTO platform_settings(key,value) VALUES ('seeded_only','{"enabled":false,"allowed_org_ids":[]}') ON CONFLICT DO NOTHING;`, "sql", "supabase/migrations/1_seed.sql"),
  ];
  assert.deepEqual(flagKeyViolations(reg, base, none), []);

  // used, not registered
  const v1 = flagKeyViolations(reg, [...base, src("SELECT 1 FROM organizations o WHERE o.feature_flags->'new_thing'='true'::jsonb;", "sql", "supabase/migrations/2_new.sql")], none);
  assert.equal(v1.length, 1);
  assert.match(v1[0], /"new_thing" is read in supabase\/migrations\/2_new\.sql but is not in ops\/flags\.yaml/);
  // same read, allowed by an explicit exception
  assert.deepEqual(flagKeyViolations(reg, [...base, src("x = row.feature_flags?.new_thing === true;")], { ...none, unregistered: { new_thing: "listed for the self-test" } }), []);

  // registered, referenced nowhere (a test-only or comment-only mention does not count)
  const v2 = flagKeyViolations(reg, [base[1], src("// flags.alpha, BETA_ENABLED")], none);
  assert.deepEqual(v2.map((m) => m.match(/key "(\w+)" is not referenced/)?.[1]), ["alpha", "BETA_ENABLED"]);
  assert.deepEqual(flagKeyViolations(reg, [base[1], src("const on = process.env.BETA_ENABLED;")], { ...none, unreferenced: { alpha: "reserved for the self-test" } }), []);

  // name drift: allowed only while the registry entry names the org key
  const drifted = [...base, src("return (featureFlags as Record<string, unknown>).beta === true;")];
  assert.match(flagKeyViolations(reg, drifted, none)[0], /"beta" is read in src\/x\.ts but is not in ops\/flags\.yaml/);
  assert.deepEqual(flagKeyViolations(reg, drifted, { ...none, drift: { beta: { registry: "BETA_ENABLED", reason: "self-test" } } }), []);
  assert.match(flagKeyViolations(reg, drifted, { ...none, drift: { beta: { registry: "alpha", reason: "wrong pairing" } } })[0], /registry entry "alpha" does not name organizations\.feature_flags\.beta/);
  assert.match(flagKeyViolations(reg, drifted, { ...none, drift: { beta: { registry: "GONE", reason: "missing" } } })[0], /"GONE", which is not in ops\/flags\.yaml/);

  // stale exceptions
  assert.match(flagKeyViolations(reg, base, { ...none, unregistered: { alpha: "now registered" } })[0], /"alpha" is now in ops\/flags\.yaml — remove it from UNREGISTERED_OK/);
  assert.match(flagKeyViolations(reg, base, { ...none, unregistered: { vanished: "no reader left" } })[0], /"vanished" is no longer read anywhere/);
  assert.match(flagKeyViolations(reg, base, { ...none, drift: { beta: { registry: "BETA_ENABLED", reason: "no reader left" } } })[0], /"beta" is no longer read anywhere — remove it from NAME_DRIFT_OK/);
  assert.match(flagKeyViolations(reg, base, { ...none, unreferenced: { alpha: "is referenced" } })[0], /"alpha" is referenced again/);
  assert.match(flagKeyViolations(reg, base, { ...none, unreferenced: { never_there: "typo" } })[0], /"never_there" is not in ops\/flags\.yaml/);
});

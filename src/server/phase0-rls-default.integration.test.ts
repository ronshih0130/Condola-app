import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "pg";
import { disposableDbUrl } from "./test-disposable-db";

// Phase 0 guard (ADR-112): the post-INC-RLS-1112 default for NEW tables, read from the catalog of
// a disposable database after every migration has run — not from migration text.
//
// Every table-like relation in schemas public and app that is not on the checked-in baseline
// (the tables that existed at main 1e0a8ab) must have row level security enabled and must give
// roles anon and authenticated no table privilege and no column privilege, whether granted
// directly, through PUBLIC, or through role membership. Partitions and inheritance children are
// relations of their own and are checked like any other table.
//
// The baseline may only shrink. Two fixtures:
//   - phase0-rls-baseline-original.json — the 229 tables at main 1e0a8ab. Frozen: its count and
//     sha256 below never change, so nothing can be added to the set of names that may be exempt.
//   - phase0-rls-baseline-tables.json — the tables that are still exempt. It must be a subset of
//     the original and is pinned by count and sha256, so it can only lose entries (removing an
//     entry means lowering BASELINE_COUNT and updating BASELINE_SHA256 in the same change).
// Baseline tables are not judged by this test (20261112100000 and box PE's catalog check own
// them). Not checked here: policies, FORCE, views.
const ORIGINAL_FILE = fileURLToPath(new URL("./fixtures/phase0-rls-baseline-original.json", import.meta.url));
const BASELINE_FILE = fileURLToPath(new URL("./fixtures/phase0-rls-baseline-tables.json", import.meta.url));
const ORIGINAL_COUNT = 229; // frozen — never change
const ORIGINAL_SHA256 = "e92dfdd5e8863e79eb400b2736c557570d07bfbdc347fab4a8c37c44b97acc0f"; // frozen — never change
const BASELINE_COUNT = 229; // lower together with BASELINE_SHA256 when an entry is removed
const BASELINE_SHA256 = "e92dfdd5e8863e79eb400b2736c557570d07bfbdc347fab4a8c37c44b97acc0f";
const ROLES = ["anon", "authenticated"] as const;

type Pin = { count: number; sha: string };
export function baselineSha(names: string[]): string {
  return createHash("sha256").update(names.join("\n")).digest("hex");
}
function shapeProblems(names: unknown, label: string): string[] {
  if (!Array.isArray(names) || !names.every((n): n is string => typeof n === "string" && /^(public|app)\.[^.]+$/.test(n))) return [`${label} must be a JSON array of public.<table> / app.<table> names`];
  const sorted = [...new Set(names)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted.length !== names.length || sorted.some((n, i) => n !== names[i]) ? [`${label} must be sorted and free of duplicates`] : [];
}
/** The frozen original must match its pin exactly. */
export function originalProblems(original: unknown, pin: Pin): string[] {
  const shape = shapeProblems(original, "original baseline");
  if (shape.length) return shape;
  const names = original as string[];
  return names.length === pin.count && baselineSha(names) === pin.sha ? [] : ["original baseline does not match its frozen count and sha256: it may never change"];
}
/** The working baseline must be a subset of the frozen original and match its own pin. */
export function baselineProblems(names: unknown, pin: Pin, original: readonly string[]): string[] {
  const shape = shapeProblems(names, "baseline");
  if (shape.length) return shape;
  const list = names as string[];
  const allowed = new Set(original);
  const foreign = list.filter((n) => !allowed.has(n));
  if (foreign.length) return [`baseline lists tables that were not in the original baseline: ${foreign.join(", ")} — adding or swapping in a table is not allowed; make the new table compliant instead`];
  if (pin.count > original.length) return [`pinned count ${pin.count} is above the original ${original.length}: the baseline may only shrink`];
  if (list.length > pin.count) return [`baseline has ${list.length} entries, pinned ${pin.count}: re-adding a table to the baseline is not allowed`];
  if (list.length < pin.count) return [`baseline has ${list.length} entries, pinned ${pin.count}: after removing entries lower BASELINE_COUNT and update BASELINE_SHA256 in the same change`];
  if (baselineSha(list) !== pin.sha) return ["baseline content does not match the pinned sha256: entries may be removed (update count and sha), never added or swapped"];
  return [];
}

/** anon and authenticated, plus every role either can SET ROLE to (directly or through a chain,
 *  including SET-only memberships). Inherited privileges need no extra entry: has_table_privilege
 *  on the base role already includes them. A membership with INHERIT FALSE and SET FALSE gives no
 *  usable privilege and is not followed. */
export async function reachableRoles(db: Client): Promise<{ roles: string[]; labels: string[] }> {
  const { rows } = await db.query<{ role: string; label: string }>(
    `SELECT m.rolname AS role, CASE WHEN m.rolname = b.r THEN b.r ELSE b.r || ' via ' || m.rolname END AS label
       FROM unnest($1::text[]) b(r) JOIN pg_roles m ON m.rolname = b.r OR pg_has_role(b.r, m.oid, 'SET')
      ORDER BY 2`,
    [[...ROLES]],
  );
  return { roles: rows.map((r) => r.role), labels: rows.map((r) => r.label) };
}

type Finding = { table: string; problem: string };

/** Catalog check. `baseline` holds "schema.table" names that are exempt. Returns findings sorted by table. */
export async function rlsDefaultFindings(db: Client, baseline: ReadonlySet<string>): Promise<{ findings: Finding[]; present: Set<string> }> {
  const version = Number((await db.query<{ v: string }>("SELECT current_setting('server_version_num') AS v")).rows[0].v);
  const tablePrivs = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", ...(version >= 170000 ? ["MAINTAIN"] : [])];
  const columnPrivs = ["SELECT", "INSERT", "UPDATE", "REFERENCES"];
  // r = table, p = partitioned table, f = foreign table, m = materialized view. Views, sequences,
  // indexes, composite types and TOAST are not tables and are left to other checks.
  const { roles, labels } = await reachableRoles(db);
  // r = table, p = partitioned table, f = foreign table, m = materialized view. Views, sequences,
  // indexes, composite types and TOAST are not tables and are left to other checks.
  const { rows } = await db.query<{ name: string; relkind: string; rls: boolean; parent: string | null; table_privs: string[]; column_privs: string[] }>(
    `SELECT n.nspname || '.' || c.relname AS name, c.relkind::text AS relkind, c.relrowsecurity AS rls,
            (SELECT pn.nspname || '.' || pc.relname FROM pg_inherits i JOIN pg_class pc ON pc.oid = i.inhparent
               JOIN pg_namespace pn ON pn.oid = pc.relnamespace WHERE i.inhrelid = c.oid ORDER BY i.inhseqno LIMIT 1) AS parent,
            ARRAY(SELECT x.label || ' ' || p FROM unnest($1::text[], $4::text[]) x(role, label), unnest($2::text[]) p
                   WHERE has_table_privilege(x.role, c.oid, p) ORDER BY 1) AS table_privs,
            ARRAY(SELECT x.label || ' ' || p FROM unnest($1::text[], $4::text[]) x(role, label), unnest($3::text[]) p
                   WHERE NOT has_table_privilege(x.role, c.oid, p) AND has_any_column_privilege(x.role, c.oid, p) ORDER BY 1) AS column_privs
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public', 'app') AND c.relkind IN ('r', 'p', 'f', 'm')
      ORDER BY 1`,
    [roles, tablePrivs, columnPrivs, labels],
  );
  const findings: Finding[] = [];
  const present = new Set<string>();
  for (const t of rows) {
    present.add(t.name);
    if (baseline.has(t.name)) continue;
    const what = t.parent ? `${t.name} (child of ${t.parent})` : t.name;
    if (t.relkind === "f" || t.relkind === "m") findings.push({ table: t.name, problem: `${what}: ${t.relkind === "f" ? "foreign table" : "materialized view"} cannot be judged by this guard — it needs an explicit decision (ADR-112)` });
    else if (!t.rls) findings.push({ table: t.name, problem: `${what}: row level security is not enabled` });
    if (t.table_privs.length) findings.push({ table: t.name, problem: `${what}: table privileges still held — ${t.table_privs.join(", ")}` });
    if (t.column_privs.length) findings.push({ table: t.name, problem: `${what}: column privileges still held — ${t.column_privs.join(", ")}` });
  }
  findings.sort((a, b) => (a.table < b.table ? -1 : a.table > b.table ? 1 : 0));
  return { findings, present };
}

function readJson(file: string): string[] {
  return JSON.parse(readFileSync(file, "utf8")) as string[];
}
const readBaseline = () => readJson(BASELINE_FILE);
const readOriginal = () => readJson(ORIGINAL_FILE);

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let db: Client;
test.before(async () => { db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect(); });
test.after(async () => { await db?.end(); });

test("baseline fixtures are pinned: the original is frozen, the baseline is a shrink-only subset of it", () => {
  const original = readOriginal();
  assert.deepEqual(originalProblems(original, { count: ORIGINAL_COUNT, sha: ORIGINAL_SHA256 }), []);
  assert.deepEqual(baselineProblems(readBaseline(), { count: BASELINE_COUNT, sha: BASELINE_SHA256 }, original), []);
});

test("self-test: the pins reject an added, swapped, re-added, unsorted or malformed baseline and accept a shrunk one", () => {
  const original = ["app.a", "public.b", "public.c"];
  const opin = { count: 3, sha: baselineSha(original) };
  assert.deepEqual(originalProblems(original, opin), []);
  assert.match(originalProblems([...original, "public.d"], opin)[0], /may never change/);
  assert.match(originalProblems(["app.a", "public.b", "public.x"], opin)[0], /may never change/);
  const pin = { count: 3, sha: baselineSha(original) };
  assert.deepEqual(baselineProblems(original, pin, original), []);
  assert.match(baselineProblems([...original, "public.d"], pin, original)[0], /not in the original baseline: public\.d/);
  // raising the pin to admit the new entry does not help — the name is not in the original
  assert.match(baselineProblems([...original, "public.d"], { count: 4, sha: baselineSha([...original, "public.d"]) }, original)[0], /not in the original baseline/);
  // swap: drop two originals, add a new table, lower the count and refresh the sha (Codex r3 P1)
  const swapped = ["app.a", "public.new_unprotected_table"];
  assert.match(baselineProblems(swapped, { count: 2, sha: baselineSha(swapped) }, original)[0], /not in the original baseline: public\.new_unprotected_table/);
  assert.match(baselineProblems(["app.a", "public.b", "public.x"], pin, original)[0], /not in the original baseline/);
  assert.match(baselineProblems(["app.a", "public.b"], pin, original)[0], /lower BASELINE_COUNT/);
  const shrunk = ["app.a", "public.b"];
  assert.deepEqual(baselineProblems(shrunk, { count: 2, sha: baselineSha(shrunk) }, original), []);
  // re-adding a removed original once the pin was lowered
  assert.match(baselineProblems(original, { count: 2, sha: baselineSha(shrunk) }, original)[0], /re-adding a table/);
  assert.match(baselineProblems(["app.a", "public.c"], { count: 2, sha: baselineSha(shrunk) }, original)[0], /never added or swapped/);
  assert.match(baselineProblems(original, { count: 4, sha: baselineSha(original) }, original)[0], /may only shrink/);
  assert.match(baselineProblems(["public.b", "app.a", "public.c"], pin, original)[0], /sorted/);
  assert.match(baselineProblems(["app.a", "app.a", "public.c"], pin, original)[0], /duplicates/);
  assert.match(baselineProblems(["app.a", "auth.users", "public.c"], pin, original)[0], /JSON array of public/);
  assert.match(baselineProblems({ "app.a": true }, pin, original)[0], /JSON array/);
});

test("every table in public and app that is not on the baseline has RLS on and nothing granted to anon or authenticated", async () => {
  const baseline = new Set(readBaseline());
  const { findings, present } = await rlsDefaultFindings(db, baseline);
  assert.ok(present.size >= 1, "expected the migrated schema in the disposable database");
  const gone = [...baseline].filter((n) => !present.has(n));
  assert.deepEqual(gone, [], `baseline lists tables that no longer exist — remove them from the fixture and lower the pin:\n${gone.join("\n")}`);
  assert.deepEqual(findings.map((f) => f.problem), [], `new-table default (ADR-112) violated:\n${findings.map((f) => f.problem).join("\n")}`);
});

test("self-test: non-compliant new tables are reported and compliant ones are not (rolled back)", async () => {
  const baseline = new Set(readBaseline());
  // Labels of roles already reachable in this database, so the PUBLIC-grant expectation does not
  // depend on memberships that exist outside the probe (Codex r4).
  const ambient = (await reachableRoles(db)).labels;
  const publicDelete = [...ambient, "authenticated via phase0_probe_reader"].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((l) => `${l} DELETE`).join(", ");
  await db.query("BEGIN");
  try {
    await db.query(`
      CREATE TABLE public.phase0_probe_ok (id int);
      ALTER TABLE public.phase0_probe_ok ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON public.phase0_probe_ok FROM PUBLIC, anon, authenticated;

      CREATE TABLE app.phase0_probe_no_rls (id int);
      REVOKE ALL ON app.phase0_probe_no_rls FROM PUBLIC, anon, authenticated;

      CREATE TABLE public.phase0_probe_anon (id int);
      ALTER TABLE public.phase0_probe_anon ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON public.phase0_probe_anon FROM PUBLIC, anon, authenticated;
      GRANT SELECT ON public.phase0_probe_anon TO anon;

      CREATE TABLE public.phase0_probe_column (id int, note text);
      ALTER TABLE public.phase0_probe_column ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON public.phase0_probe_column FROM PUBLIC, anon, authenticated;
      GRANT UPDATE (note) ON public.phase0_probe_column TO authenticated;

      CREATE TABLE app.phase0_probe_public_grant (id int);
      ALTER TABLE app.phase0_probe_public_grant ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON app.phase0_probe_public_grant FROM PUBLIC, anon, authenticated;
      GRANT DELETE ON app.phase0_probe_public_grant TO PUBLIC;

      CREATE TABLE public.phase0_probe_parent (id int) PARTITION BY RANGE (id);
      ALTER TABLE public.phase0_probe_parent ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON public.phase0_probe_parent FROM PUBLIC, anon, authenticated;
      CREATE TABLE public.phase0_probe_part PARTITION OF public.phase0_probe_parent FOR VALUES FROM (0) TO (10);
      REVOKE ALL ON public.phase0_probe_part FROM PUBLIC, anon, authenticated;

      CREATE TABLE public.phase0_probe_child () INHERITS (public.phase0_probe_ok);
      ALTER TABLE public.phase0_probe_child ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON public.phase0_probe_child FROM PUBLIC, anon, authenticated;
      GRANT TRUNCATE ON public.phase0_probe_child TO authenticated;

      CREATE ROLE phase0_probe_reader NOLOGIN;
      CREATE TABLE public.phase0_probe_via_role (id int);
      ALTER TABLE public.phase0_probe_via_role ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON public.phase0_probe_via_role FROM PUBLIC, anon, authenticated;
      GRANT SELECT ON public.phase0_probe_via_role TO phase0_probe_reader;
      GRANT phase0_probe_reader TO authenticated WITH INHERIT FALSE, SET TRUE;

      CREATE ROLE phase0_probe_blocked NOLOGIN;
      CREATE TABLE public.phase0_probe_blocked (id int);
      ALTER TABLE public.phase0_probe_blocked ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON public.phase0_probe_blocked FROM PUBLIC, anon, authenticated;
      GRANT SELECT ON public.phase0_probe_blocked TO phase0_probe_blocked;
      GRANT phase0_probe_blocked TO authenticated WITH ADMIN FALSE, INHERIT FALSE, SET FALSE;

      CREATE MATERIALIZED VIEW public.phase0_probe_matview AS SELECT 1 AS id;
      REVOKE ALL ON public.phase0_probe_matview FROM PUBLIC, anon, authenticated;

      CREATE TEMP TABLE phase0_probe_temp (id int) ON COMMIT DROP;
      CREATE VIEW public.phase0_probe_view AS SELECT 1 AS id;
    `);
    const { findings } = await rlsDefaultFindings(db, baseline);
    assert.deepEqual(findings.map((f) => f.problem), [
      "app.phase0_probe_no_rls: row level security is not enabled",
      `app.phase0_probe_public_grant: table privileges still held — ${publicDelete}`,
      "public.phase0_probe_anon: table privileges still held — anon SELECT",
      "public.phase0_probe_child (child of public.phase0_probe_ok): table privileges still held — authenticated TRUNCATE",
      "public.phase0_probe_column: column privileges still held — authenticated UPDATE",
      "public.phase0_probe_matview: materialized view cannot be judged by this guard — it needs an explicit decision (ADR-112)",
      "public.phase0_probe_part (child of public.phase0_probe_parent): row level security is not enabled",
      "public.phase0_probe_via_role: table privileges still held — authenticated via phase0_probe_reader SELECT",
    ]);
    // a baseline entry exempts exactly that table
    const exempt = await rlsDefaultFindings(db, new Set([...baseline, "public.phase0_probe_anon"]));
    assert.ok(!exempt.findings.some((f) => f.table === "public.phase0_probe_anon"));
    assert.equal(exempt.findings.length, findings.length - 1);
  } finally {
    await db.query("ROLLBACK");
  }
  const after = await rlsDefaultFindings(db, baseline);
  assert.ok(![...after.present].some((n) => n.includes("phase0_probe")), "probe tables must be rolled back");
});

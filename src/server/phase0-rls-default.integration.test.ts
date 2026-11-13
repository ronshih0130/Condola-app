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
// The baseline may only shrink. It is pinned below by count and sha256, so adding a table to
// the fixture fails here. Baseline tables are not judged by this test (20261112100000 and box
// PE's catalog check own them). Not checked here: policies, FORCE, views.
const BASELINE_FILE = fileURLToPath(new URL("./fixtures/phase0-rls-baseline-tables.json", import.meta.url));
const BASELINE_MAX_COUNT = 229; // tables in public + app at main 1e0a8ab; never raise this
const BASELINE_COUNT = 229; // lower together with BASELINE_SHA256 when an entry is removed
const BASELINE_SHA256 = "e92dfdd5e8863e79eb400b2736c557570d07bfbdc347fab4a8c37c44b97acc0f";
const ROLES = ["anon", "authenticated"] as const;

export function baselineSha(names: string[]): string {
  return createHash("sha256").update(names.join("\n")).digest("hex");
}
export function baselineProblems(names: unknown, pinned: { max: number; count: number; sha: string }): string[] {
  if (!Array.isArray(names) || !names.every((n): n is string => typeof n === "string" && /^(public|app)\.[^.]+$/.test(n))) return ["baseline must be a JSON array of public.<table> / app.<table> names"];
  const out: string[] = [];
  const sorted = [...new Set(names)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (sorted.length !== names.length || sorted.some((n, i) => n !== names[i])) out.push("baseline must be sorted and free of duplicates");
  if (pinned.count > pinned.max) out.push(`pinned count ${pinned.count} is above the original ${pinned.max}: the baseline may only shrink`);
  if (names.length > pinned.count) out.push(`baseline has ${names.length} entries, pinned ${pinned.count}: adding a table to the baseline is not allowed — make the new table compliant instead`);
  else if (names.length < pinned.count) out.push(`baseline has ${names.length} entries, pinned ${pinned.count}: after removing entries lower BASELINE_COUNT and update BASELINE_SHA256 in the same change`);
  else if (baselineSha(names) !== pinned.sha) out.push("baseline content does not match the pinned sha256: entries may be removed (update count and sha), never added or swapped");
  return out;
}

type Finding = { table: string; problem: string };

/** Catalog check. `baseline` holds "schema.table" names that are exempt. Returns findings sorted by table. */
export async function rlsDefaultFindings(db: Client, baseline: ReadonlySet<string>): Promise<{ findings: Finding[]; present: Set<string> }> {
  const version = Number((await db.query<{ v: string }>("SELECT current_setting('server_version_num') AS v")).rows[0].v);
  const tablePrivs = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", ...(version >= 170000 ? ["MAINTAIN"] : [])];
  const columnPrivs = ["SELECT", "INSERT", "UPDATE", "REFERENCES"];
  // r = table, p = partitioned table, f = foreign table, m = materialized view. Views, sequences,
  // indexes, composite types and TOAST are not tables and are left to other checks.
  const { rows } = await db.query<{ name: string; relkind: string; rls: boolean; parent: string | null; table_privs: string[]; column_privs: string[] }>(
    `SELECT n.nspname || '.' || c.relname AS name, c.relkind::text AS relkind, c.relrowsecurity AS rls,
            (SELECT pn.nspname || '.' || pc.relname FROM pg_inherits i JOIN pg_class pc ON pc.oid = i.inhparent
               JOIN pg_namespace pn ON pn.oid = pc.relnamespace WHERE i.inhrelid = c.oid ORDER BY i.inhseqno LIMIT 1) AS parent,
            ARRAY(SELECT r || ' ' || p FROM unnest($1::text[]) r, unnest($2::text[]) p
                   WHERE has_table_privilege(r, c.oid, p) ORDER BY 1) AS table_privs,
            ARRAY(SELECT r || ' ' || p FROM unnest($1::text[]) r, unnest($3::text[]) p
                   WHERE NOT has_table_privilege(r, c.oid, p) AND has_any_column_privilege(r, c.oid, p) ORDER BY 1) AS column_privs
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public', 'app') AND c.relkind IN ('r', 'p', 'f', 'm')
      ORDER BY 1`,
    [[...ROLES], tablePrivs, columnPrivs],
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

function readBaseline(): string[] {
  return JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as string[];
}

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let db: Client;
test.before(async () => { db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect(); });
test.after(async () => { await db?.end(); });

test("baseline fixture is pinned: it may shrink, it may not grow", () => {
  assert.deepEqual(baselineProblems(readBaseline(), { max: BASELINE_MAX_COUNT, count: BASELINE_COUNT, sha: BASELINE_SHA256 }), []);
});

test("self-test: the pin rejects an added, swapped, unsorted or malformed baseline and accepts a shrunk one", () => {
  const base = ["app.a", "public.b", "public.c"];
  const pin = { max: 3, count: 3, sha: baselineSha(base) };
  assert.deepEqual(baselineProblems(base, pin), []);
  assert.match(baselineProblems([...base, "public.d"], pin)[0], /adding a table to the baseline is not allowed/);
  // raising the pin to admit the new entry is itself rejected by the fixed ceiling
  assert.match(baselineProblems([...base, "public.d"], { max: 3, count: 4, sha: baselineSha([...base, "public.d"]) })[0], /may only shrink/);
  assert.match(baselineProblems(["app.a", "public.b", "public.x"], pin)[0], /never added or swapped/);
  assert.match(baselineProblems(["app.a", "public.b"], pin)[0], /lower BASELINE_COUNT/);
  assert.deepEqual(baselineProblems(["app.a", "public.b"], { max: 3, count: 2, sha: baselineSha(["app.a", "public.b"]) }), []);
  assert.match(baselineProblems(["public.b", "app.a", "public.c"], pin)[0], /sorted/);
  assert.match(baselineProblems(["app.a", "app.a", "public.c"], pin)[0], /duplicates/);
  assert.match(baselineProblems(["app.a", "auth.users", "public.c"], pin)[0], /JSON array of public/);
  assert.match(baselineProblems({ "app.a": true }, pin)[0], /JSON array/);
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
      REVOKE ALL ON app.phase0_probe_public_grant FROM anon, authenticated;
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

      CREATE MATERIALIZED VIEW public.phase0_probe_matview AS SELECT 1 AS id;
      REVOKE ALL ON public.phase0_probe_matview FROM PUBLIC, anon, authenticated;

      CREATE TEMP TABLE phase0_probe_temp (id int) ON COMMIT DROP;
      CREATE VIEW public.phase0_probe_view AS SELECT 1 AS id;
    `);
    const { findings } = await rlsDefaultFindings(db, baseline);
    assert.deepEqual(findings.map((f) => f.problem), [
      "app.phase0_probe_no_rls: row level security is not enabled",
      "app.phase0_probe_public_grant: table privileges still held — anon DELETE, authenticated DELETE",
      "public.phase0_probe_anon: table privileges still held — anon SELECT",
      "public.phase0_probe_child (child of public.phase0_probe_ok): table privileges still held — authenticated TRUNCATE",
      "public.phase0_probe_column: column privileges still held — authenticated UPDATE",
      "public.phase0_probe_matview: materialized view cannot be judged by this guard — it needs an explicit decision (ADR-112)",
      "public.phase0_probe_part (child of public.phase0_probe_parent): row level security is not enabled",
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

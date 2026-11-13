import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { stripSqlComments } from "./phase0-sql-text";

// Phase 0 guard (ADR-112 option B, static part only): after INC-RLS-1112 every NEW migration
// that creates a table must, in the same file and after the CREATE TABLE, enable row level
// security on it and revoke ALL from anon and authenticated. New migrations must also never
// disable row level security or grant anything to anon.
//
// Scope: migrations whose filename timestamp is AFTER the stop-bleed migration. The 160
// earlier files are grandfathered (their state is covered by 20261112100000 and by box PE's
// catalog check, FU-RLS-ADVISOR-CI). This is a text check: it does not read a database, and it
// does not check policies, FORCE, or the access-path comment that ADR-112 also proposes.
const CUTOFF = "20261112100000";
const CUTOFF_FILE = `${CUTOFF}_advisor_rls_stop_bleed.sql`;
const CHECKED_SCHEMAS = new Set(["public", "app"]);

const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const QNAME = String.raw`(?:${IDENT}\s*\.\s*)?${IDENT}`;
const NOT_TABLE_OBJECTS = /^(?:ALL\s+(?:FUNCTIONS|PROCEDURES|ROUTINES|SEQUENCES)\b|FUNCTION\b|PROCEDURE\b|ROUTINE\b|SEQUENCE\b|SCHEMA\b|DATABASE\b|DOMAIN\b|TYPE\b|LANGUAGE\b|LARGE\s+OBJECT\b|TABLESPACE\b|PARAMETER\b|FOREIGN\b)/i;

function parseName(raw: string): { schema: string; table: string } | null {
  const m = raw.trim().match(new RegExp(String.raw`^(?:(${IDENT})\s*\.\s*)?(${IDENT})$`));
  if (!m) return null;
  const un = (s: string) => (s.startsWith('"') ? s.slice(1, -1) : s.toLowerCase());
  return { schema: m[1] ? un(m[1]) : "public", table: un(m[2]) };
}
const full = (n: { schema: string; table: string }) => `${n.schema}.${n.table}`;

/** Violations for one migration's SQL text. Every message starts with the file name. */
export function rlsDefaultViolations(file: string, rawSql: string): string[] {
  const sql = stripSqlComments(rawSql);
  const out: string[] = [];

  // 1. Tables created (TEMP / pg_temp skipped; only schemas public and app are in scope).
  const created: Array<{ name: string; schema: string; at: number }> = [];
  const createRe = new RegExp(
    String.raw`\bCREATE\s+((?:(?:GLOBAL|LOCAL)\s+)?(?:TEMP|TEMPORARY)\s+|UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${QNAME})?`,
    "gi",
  );
  for (const m of sql.matchAll(createRe)) {
    if (/TEMP/i.test(m[1] ?? "")) continue;
    const name = m[2] ? parseName(m[2]) : null;
    if (!name) {
      out.push(`${file}: CREATE TABLE with a name this guard cannot read (dynamic SQL?) near "${sql.slice(m.index, m.index + 60).replace(/\s+/g, " ")}"`);
      continue;
    }
    if (name.schema === "pg_temp" || !CHECKED_SCHEMAS.has(name.schema)) continue;
    created.push({ name: full(name), schema: name.schema, at: m.index });
  }

  // 2. ALTER TABLE ... ENABLE ROW LEVEL SECURITY (position kept: it must follow the CREATE).
  const enabledAt = new Map<string, number>();
  const enableRe = new RegExp(
    String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${QNAME})(?=[\s;])[^;]*?\bENABLE\s+ROW\s+LEVEL\s+SECURITY\b`,
    "gi",
  );
  for (const m of sql.matchAll(enableRe)) {
    const name = parseName(m[1]);
    if (name) enabledAt.set(full(name), Math.max(enabledAt.get(full(name)) ?? -1, m.index));
  }

  // 3. REVOKE ALL [PRIVILEGES] ON [TABLE] a[, b] | ALL TABLES IN SCHEMA s FROM role[, role].
  //    A partial revoke (e.g. REVOKE INSERT) does not count.
  type Revoke = { at: number; roles: Set<string>; tables: Set<string>; schemas: Set<string> };
  const revokes: Revoke[] = [];
  for (const m of sql.matchAll(/\bREVOKE\s+([^;]*?)\s+ON\s+([^;]*?)\s+FROM\s+([^;]*)/gi)) {
    if (!/^ALL(?:\s+PRIVILEGES)?$/i.test(m[1].trim())) continue;
    const target = m[2].trim();
    if (NOT_TABLE_OBJECTS.test(target)) continue;
    const roles = new Set(
      m[3].replace(/\b(?:CASCADE|RESTRICT)\b/gi, "").split(",")
        .map((r) => r.trim().replace(/^GROUP\s+/i, "").replace(/^"|"$/g, "").toLowerCase()).filter(Boolean),
    );
    const rv: Revoke = { at: m.index, roles, tables: new Set(), schemas: new Set() };
    const allIn = target.match(/^ALL\s+TABLES\s+IN\s+SCHEMA\s+(.+)$/i);
    if (allIn) for (const s of allIn[1].split(",")) rv.schemas.add(s.trim().replace(/^"|"$/g, "").toLowerCase());
    else for (const t of target.replace(/^TABLE\s+/i, "").split(",")) { const n = parseName(t.replace(/^ONLY\s+/i, "")); if (n) rv.tables.add(full(n)); }
    revokes.push(rv);
  }

  for (const t of created) {
    const en = enabledAt.get(t.name);
    if (en === undefined || en < t.at) out.push(`${file}: table ${t.name} is created without ALTER TABLE ${t.name} ENABLE ROW LEVEL SECURITY after it in the same file`);
    for (const role of ["anon", "authenticated"]) {
      const covered = revokes.some((r) => r.at > t.at && r.roles.has(role) && (r.tables.has(t.name) || r.schemas.has(t.schema)));
      if (!covered) out.push(`${file}: table ${t.name} is created without REVOKE ALL ON TABLE ${t.name} FROM ${role} after it in the same file`);
    }
  }

  // 4. Never allowed in a new migration.
  for (const m of sql.matchAll(/\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/gi)) {
    const before = sql.slice(Math.max(0, sql.lastIndexOf(";", m.index) + 1), m.index);
    const table = before.match(new RegExp(String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${QNAME})`, "i"))?.[1];
    out.push(`${file}: DISABLE ROW LEVEL SECURITY${table ? ` on table ${table.replace(/\s+/g, "")}` : ""} is not allowed in a new migration`);
  }
  for (const m of sql.matchAll(/\bGRANT\s+([^;]*?)\s+TO\s+([^;]*)/gi)) {
    if (/(?<![\w"$.])"?anon"?(?![\w"$.])/i.test(m[2])) out.push(`${file}: GRANT to anon is not allowed in a new migration: "GRANT ${m[1].replace(/\s+/g, " ").slice(0, 80)} TO ${m[2].replace(/\s+/g, " ").trim().slice(0, 60)}"`);
  }
  return out;
}

/** Which migration file names are in scope; a name without a 14-digit timestamp is itself a violation. */
export function migrationsInScope(files: string[]): { checked: string[]; malformed: string[] } {
  const checked: string[] = [], malformed: string[] = [];
  for (const f of files.filter((x) => x.endsWith(".sql")).sort()) {
    const ts = f.match(/^(\d{14})_/)?.[1];
    if (!ts) malformed.push(f);
    else if (ts > CUTOFF) checked.push(f);
  }
  return { checked, malformed };
}

const root = new URL("../..", import.meta.url).pathname;
const dir = join(root, "supabase/migrations");

test("every migration after INC-RLS-1112 enables RLS and revokes anon/authenticated on each table it creates", () => {
  const files = readdirSync(dir);
  assert.ok(files.includes(CUTOFF_FILE), `cutoff migration ${CUTOFF_FILE} must exist`);
  const { checked, malformed } = migrationsInScope(files);
  const violations = [
    ...malformed.map((f) => `${f}: migration file name must start with a 14-digit timestamp and "_"`),
    ...checked.flatMap((f) => rlsDefaultViolations(f, readFileSync(join(dir, f), "utf8"))),
  ];
  assert.deepEqual(violations, [], `new-table RLS default (ADR-112) violated:\n${violations.join("\n")}`);
});

test("scope: only files with a timestamp after the cutoff are checked; malformed names are reported", () => {
  const r = migrationsInScope([
    "20261018120000_schema.sql", CUTOFF_FILE, "20261112100001_next.sql", "20270101000000_later.sql", "notes.md", "hotfix.sql", "2026111210_short.sql",
  ]);
  assert.deepEqual(r.checked, ["20261112100001_next.sql", "20270101000000_later.sql"]);
  assert.deepEqual(r.malformed, ["2026111210_short.sql", "hotfix.sql"]);
});

const F = "20261201000000_fixture.sql";
const ok = (sql: string) => assert.deepEqual(rlsDefaultViolations(F, sql), [], sql);
const bad = (sql: string, ...expected: RegExp[]) => {
  const v = rlsDefaultViolations(F, sql);
  assert.equal(v.length, expected.length, `${sql}\n-> ${JSON.stringify(v, null, 1)}`);
  expected.forEach((re, n) => { assert.match(v[n], re, sql); assert.ok(v[n].startsWith(`${F}: `), v[n]); });
};

test("self-test: compliant fixtures pass", () => {
  ok(`CREATE TABLE app.widgets (id uuid PRIMARY KEY);
      ALTER TABLE app.widgets ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON TABLE app.widgets FROM PUBLIC, anon, authenticated;`);
  // unqualified = public; separate REVOKE statements; IF NOT EXISTS; FORCE in the same ALTER; later grant to authenticated
  ok(`CREATE TABLE IF NOT EXISTS widgets (id uuid);
      ALTER TABLE public.widgets ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;
      REVOKE ALL PRIVILEGES ON public.widgets FROM anon;
      revoke all on table widgets from authenticated cascade;
      GRANT SELECT, INSERT ON public.widgets TO authenticated;`);
  // two tables in one REVOKE, quoted identifiers, no-space role list as used in this repo
  ok(`CREATE TABLE app.a (id int); CREATE UNLOGGED TABLE "app"."b" (id int);
      ALTER TABLE app.a ENABLE ROW LEVEL SECURITY; ALTER TABLE ONLY app.b ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON app.a,app.b FROM PUBLIC,anon,authenticated,service_role;`);
  // schema-wide revoke after the create
  ok(`CREATE TABLE app.c (id int); ALTER TABLE app.c ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON ALL TABLES IN SCHEMA app FROM anon, authenticated;`);
  // temp tables, other schemas and files without tables are out of scope
  ok(`CREATE TEMP TABLE scratch AS SELECT 1; CREATE TEMPORARY TABLE s2 (id int); CREATE TABLE pg_temp.s3 (id int);
      CREATE INDEX ON public.leases (org_id); ALTER TABLE public.leases ADD COLUMN note text;
      REVOKE ALL ON FUNCTION app.f(uuid) FROM PUBLIC, anon, authenticated; GRANT EXECUTE ON FUNCTION app.f(uuid) TO authenticated;`);
  // forbidden words inside comments are ignored
  ok(`-- ALTER TABLE x DISABLE ROW LEVEL SECURITY; GRANT SELECT ON x TO anon;
      /* CREATE TABLE public.ghost (id int); /* nested */ GRANT ALL ON public.ghost TO anon; */
      SELECT 1;`);
  // a role merely named like anon is not anon
  ok(`GRANT SELECT ON public.leases TO anon_reader, "authenticated";`);
});

test("self-test: non-compliant fixtures fail, naming file and table", () => {
  const T = "CREATE TABLE app.widgets (id uuid PRIMARY KEY);";
  const EN = "ALTER TABLE app.widgets ENABLE ROW LEVEL SECURITY;";
  const RV = "REVOKE ALL ON TABLE app.widgets FROM PUBLIC, anon, authenticated;";
  bad(T, /table app\.widgets .*ENABLE ROW LEVEL SECURITY/, /table app\.widgets .*FROM anon/, /table app\.widgets .*FROM authenticated/);
  bad(`${T} ${RV}`, /table app\.widgets .*ENABLE ROW LEVEL SECURITY/);
  bad(`${T} ${EN}`, /FROM anon/, /FROM authenticated/);
  bad(`${T} ${EN} REVOKE ALL ON TABLE app.widgets FROM PUBLIC, anon;`, /table app\.widgets .*FROM authenticated/);
  bad(`${T} ${EN} REVOKE ALL ON TABLE app.widgets FROM PUBLIC;`, /FROM anon/, /FROM authenticated/);
  // a partial revoke is not coverage
  bad(`${T} ${EN} REVOKE INSERT, UPDATE ON TABLE app.widgets FROM anon, authenticated;`, /FROM anon/, /FROM authenticated/);
  // ENABLE / REVOKE aimed at a different table (or the same name in another schema)
  bad(`${T} ALTER TABLE app.other ENABLE ROW LEVEL SECURITY; ${RV}`, /table app\.widgets .*ENABLE/);
  bad(`${T} ${EN} REVOKE ALL ON TABLE public.widgets FROM anon, authenticated;`, /FROM anon/, /FROM authenticated/);
  // a revoke on functions or sequences does not cover the table
  bad(`${T} ${EN} REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM anon, authenticated; REVOKE ALL ON SEQUENCE app.widgets FROM anon, authenticated;`, /FROM anon/, /FROM authenticated/);
  // ENABLE / REVOKE only inside a comment
  bad(`${T} -- ${EN}\n /* ${RV} */`, /ENABLE/, /FROM anon/, /FROM authenticated/);
  // statements placed before the CREATE (schema-wide revoke does not reach a later table)
  bad(`REVOKE ALL ON ALL TABLES IN SCHEMA app FROM anon, authenticated; ${T} ${EN}`, /FROM anon/, /FROM authenticated/);
  // only the second of two tables is covered
  bad(`${T} CREATE TABLE public.second (id int); ALTER TABLE public.second ENABLE ROW LEVEL SECURITY; REVOKE ALL ON public.second FROM anon, authenticated;`,
    /table app\.widgets .*ENABLE/, /table app\.widgets .*FROM anon/, /table app\.widgets .*FROM authenticated/);
  // DISABLE and GRANT ... TO anon are rejected even when the table itself is compliant
  bad(`${T} ${EN} ${RV} ALTER TABLE app.widgets DISABLE ROW LEVEL SECURITY;`, /DISABLE ROW LEVEL SECURITY on table app\.widgets/);
  bad(`ALTER TABLE public.leases\n  DISABLE  ROW LEVEL SECURITY;`, /DISABLE ROW LEVEL SECURITY on table public\.leases/);
  bad(`${T} ${EN} ${RV} GRANT SELECT ON app.widgets TO anon;`, /GRANT to anon/);
  bad(`GRANT EXECUTE ON FUNCTION public.f(uuid) TO authenticated, anon;`, /GRANT to anon/);
  bad(`grant usage on schema app to "anon" with grant option;`, /GRANT to anon/);
  bad(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon;`, /GRANT to anon/);
  // inside a DO / function body
  bad(`DO $$ BEGIN CREATE TABLE public.inside (id int); END $$;`, /table public\.inside .*ENABLE/, /FROM anon/, /FROM authenticated/);
  // dynamic table name: reported instead of skipped
  bad(`DO $$ BEGIN EXECUTE format('CREATE TABLE %I (id int)', n); END $$;`, /cannot read/);
});

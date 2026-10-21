import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const database = "condola_utility_mig";

function databaseUrl(name: string) {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is required");
  const url = new URL(raw);
  url.pathname = `/${name}`;
  return url.toString();
}

async function psql(name: string, args: string[]) {
  await exec("psql", [databaseUrl(name), "-v", "ON_ERROR_STOP=1", ...args], {
    cwd: root,
    maxBuffer: 20 * 1024 * 1024,
  });
}

test("the electricity migration applies twice, including inside one transaction", { timeout: 120_000 }, async () => {
  assert.equal(Boolean(process.env.DATABASE_URL), true);
  await psql("postgres", ["-c", `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`]);
  await psql("postgres", ["-c", `CREATE DATABASE ${database} OWNER condola`]);
  try {
    await psql(database, ["-f", "supabase/stub/supabase_stub.sql"]);
    const files = (await readdir(path.join(root, "supabase/migrations"))).filter((name) => name.endsWith(".sql")).sort();
    assert.equal(files.includes("20261023130000_utility_charge_posting.sql"), true);
    for (const file of files) {
      await psql(database, ["-f", path.join("supabase/migrations", file)]);
    }
    const utility = "supabase/migrations/20261023130000_utility_charge_posting.sql";
    await psql(database, ["-f", utility]);
    await psql(database, ["--single-transaction", "-f", utility]);
    const check = await exec(
      "psql",
      [
        databaseUrl(database),
        "-v",
        "ON_ERROR_STOP=1",
        "-tA",
        "-c",
        `SELECT count(*) FROM pg_constraint WHERE conname = 'utility_allocation_runs_unit_period_excl'`,
      ],
      { cwd: root },
    );
    assert.equal(check.stdout.trim(), "1");
    const reversals = await exec(
      "psql",
      [
        databaseUrl(database),
        "-v",
        "ON_ERROR_STOP=1",
        "-tA",
        "-c",
        `SELECT pronargs::text || ':' || pronargdefaults::text
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = 'post_reversal'
          ORDER BY 1`,
      ],
      { cwd: root },
    );
    assert.equal(reversals.stdout.trim(), "2:0\n3:0");
  } finally {
    await psql("postgres", ["-c", `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`]);
  }
});

#!/usr/bin/env bash
# red-on-base-db.sh — Lauren 3-W: run integration tests against a FRESH
# disposable database built from THIS checkout's own schema, so a red-on-base
# proof can be re-run in CI (each side gets its own schema: base without the
# fix, head with it). Use it as the red-on-base command:
#
#   node scripts/red-on-base.mjs --test <tests> --expect '<reason>' \
#     --cmd "bash scripts/red-on-base-db.sh {tests}"
#
# Run it from the checkout root whose schema to use (red-on-base does). Needs
# $DATABASE_URL pointing at a local server (127.0.0.1 / localhost / [::1])
# and CONDOLA_RLS_DISPOSABLE=YES, the same guard as the integration tests, and
# psql on PATH. It creates database condola_rob_<random> on that server, applies
# supabase/stub/supabase_stub.sql and supabase/migrations/*.sql in order (psql
# -X -v ON_ERROR_STOP=1 -f, as CI does), seeds it (src/server/seed.ts), runs
# `npx tsx --test --test-concurrency=1 <tests>` with DATABASE_URL set to it, and
# drops it on exit. Credentials go to psql through PG* environment variables,
# never on the command line. Exit: the test run's status; 3 when setup fails.
set -uo pipefail
die() { echo "red-on-base-db: $*" >&2; exit 3; }
# Works on the CURRENT directory (red-on-base runs it in each side's checkout),
# not on this script's location: CI runs the head copy on the base side too.
[ -d supabase/migrations ] && [ -f supabase/stub/supabase_stub.sql ] && [ -f src/server/seed.ts ] \
  || die "run from a Condola checkout root (no supabase/migrations here: $PWD)"
[ "$#" -gt 0 ] || die "no test files given"
[ "${CONDOLA_RLS_DISPOSABLE:-}" = "YES" ] || die "CONDOLA_RLS_DISPOSABLE=YES is required (disposable local database only)"
url="${DATABASE_URL:-}"
re='^postgres(ql)?://([A-Za-z0-9_]+)(:([^@/]*))?@(127\.0\.0\.1|localhost|\[::1\]):([0-9]+)/([A-Za-z0-9_]+)$'
[[ "$url" =~ $re ]] || die "DATABASE_URL must be postgres://user[:password]@127.0.0.1|localhost|[::1]:port/db"
export PGUSER="${BASH_REMATCH[2]}" PGPASSWORD="${BASH_REMATCH[4]}" PGHOST="${BASH_REMATCH[5]}" PGPORT="${BASH_REMATCH[6]}"
[ "$PGHOST" = "[::1]" ] && PGHOST="::1"
command -v psql >/dev/null 2>&1 || die "psql not found on PATH"

name="condola_rob_$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
created=""
cleanup() {
  if [ -n "$created" ]; then
    PGDATABASE=postgres psql -X -q -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$name\" WITH (FORCE)" >/dev/null 2>&1 \
      || echo "red-on-base-db: could not drop $name" >&2
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

PGDATABASE=postgres psql -X -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$name\"" >/dev/null || die "cannot create database $name"
created=1
apply() { PGDATABASE="$name" psql -X -q -v ON_ERROR_STOP=1 -f "$1" >/dev/null || die "schema file failed: $1"; }
apply supabase/stub/supabase_stub.sql
for migration in supabase/migrations/*.sql; do apply "$migration"; done
test_url="postgres://${PGUSER}${PGPASSWORD:+:$PGPASSWORD}@${BASH_REMATCH[5]}:${PGPORT}/${name}"
DATABASE_URL="$test_url" DEMO_MODE="${DEMO_MODE:-true}" npx tsx src/server/seed.ts >/dev/null || die "seed failed"
echo "red-on-base-db: fresh database ready ($(ls supabase/migrations/*.sql | wc -l | tr -d ' ') migrations)"

DATABASE_URL="$test_url" npx tsx --test --test-concurrency=1 "$@"

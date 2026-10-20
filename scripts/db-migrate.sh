#!/usr/bin/env bash
# Apply supabase/migrations to the database in DATABASE_URL.
# Does not apply supabase/stub/supabase_stub.sql and does not seed.
# Re-runs skip files already recorded in condola_ops.schema_migrations.
#
# Staging CI passes the Tokyo Supabase session connection (port 5432).
# Do not point this at the Worker transaction-pooler URL (port 6543).
# The script does not read .env.local and does not print DATABASE_URL.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required. Pass the staging Supabase session connection. Do not print it." >&2
  exit 1
fi

local_demo="postgres://condola:condola@127.0.0.1:5432/condola"
local_demo_host="postgres://condola:condola@localhost:5432/condola"
if [[ "${DATABASE_URL}" == "${local_demo}" || "${DATABASE_URL}" == "${local_demo_host}" ]]; then
  if [[ "${CONDOLA_MIGRATE_LOCAL:-}" != "1" ]]; then
    echo "Refusing to migrate the local demo database. Set CONDOLA_MIGRATE_LOCAL=1 to rehearse the script locally." >&2
    exit 1
  fi
fi

case "${DATABASE_URL}" in
  *:6543|*:6543/*|*:6543\?*)
    echo "Refusing the transaction pooler (port 6543). Migrations need the Tokyo session connection (port 5432)." >&2
    exit 1
    ;;
esac

psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 <<'SQL'
CREATE SCHEMA IF NOT EXISTS condola_ops;
CREATE TABLE IF NOT EXISTS condola_ops.schema_migrations (
  filename text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
SQL

shopt -s nullglob
files=(supabase/migrations/*.sql)
if [[ ${#files[@]} -eq 0 ]]; then
  echo "No files in supabase/migrations." >&2
  exit 1
fi

for migration in "${files[@]}"; do
  name="$(basename "${migration}")"
  case "${name}" in
    *stub*)
      echo "Refusing to apply ${name}." >&2
      exit 1
      ;;
  esac
  applied="$(psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -v "filename=${name}" -tA <<'SQL'
SELECT 1 FROM condola_ops.schema_migrations WHERE filename = :'filename'
SQL
)"
  if [[ "${applied}" == "1" ]]; then
    echo "already applied: ${name}"
    continue
  fi
  echo "applying: ${name}"
  psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 --single-transaction -f "${migration}"
  psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -v "filename=${name}" <<'SQL'
INSERT INTO condola_ops.schema_migrations (filename) VALUES (:'filename')
SQL
done

echo "Migrations are applied."

#!/usr/bin/env bash
# Create the local demo database and apply the Supabase migration.
# Hosted Supabase and `supabase start` already provide auth, so they should
# run only supabase/migrations — not supabase/stub/supabase_stub.sql.
set -euo pipefail
cd "$(dirname "$0")/.."

if command -v service >/dev/null 2>&1; then
  sudo service postgresql start || true
fi

sudo -u postgres psql -v ON_ERROR_STOP=1 <<'SQL'
DO $$ BEGIN
  CREATE ROLE condola LOGIN PASSWORD 'condola' SUPERUSER;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
SQL

sudo -u postgres psql -v ON_ERROR_STOP=1 -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'condola' AND pid <> pg_backend_pid();" || true
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS condola;"
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE DATABASE condola OWNER condola;"
sudo -u postgres psql -d condola -v ON_ERROR_STOP=1 -f supabase/stub/supabase_stub.sql
sudo -u postgres psql -d condola -v ON_ERROR_STOP=1 -f supabase/migrations/20261018120000_schema.sql

npm run db:reset
echo "Database condola is ready."

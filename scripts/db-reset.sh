#!/usr/bin/env bash
# Reseed the demo database. Uses DATABASE_URL from the environment, or from
# .env.local when that file exists.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -f .env.local ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi
export DATABASE_URL="${DATABASE_URL:-postgres://condola:condola@127.0.0.1:5432/condola}"
export DEMO_MODE="${DEMO_MODE:-true}"
exec npx tsx src/server/seed.ts

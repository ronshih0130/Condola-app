#!/usr/bin/env bash
# Deploy the OpenNext bundle to the Cloudflare Workers env named staging.
# This script has no production path. It ignores extra arguments.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ $# -ne 0 ]]; then
  echo "cf-deploy-staging.sh takes no arguments. It deploys --env staging only." >&2
  exit 1
fi

if [[ -n "${CLOUDFLARE_ENV:-}" && "${CLOUDFLARE_ENV}" != "staging" ]]; then
  echo "Refusing to deploy: CLOUDFLARE_ENV must be staging or unset. Production is not deployed from here." >&2
  exit 1
fi

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "CLOUDFLARE_API_TOKEN is required. The value is not printed." >&2
  exit 1
fi

# Worker secrets are already on the staging Worker. A value present in this
# process would be baked into the OpenNext bundle if deploy rebuilds.
unset DATABASE_URL \
  SUPABASE_URL \
  SUPABASE_ANON_KEY \
  SUPABASE_SERVICE_ROLE_KEY \
  NEXT_PUBLIC_SUPABASE_URL \
  NEXT_PUBLIC_SUPABASE_ANON_KEY \
  DEMO_MODE \
  LINE_LOGIN_ENABLED \
  RESEND_API_KEY \
  BREVO_API_KEY \
  CRON_SECRET || true

if [[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  unset CLOUDFLARE_ACCOUNT_ID || true
fi

export CLOUDFLARE_ENV=staging
exec npx opennextjs-cloudflare deploy --env staging

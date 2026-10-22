#!/usr/bin/env bash
# Label-gated acceptance suites. Missing security or browser env fails the job.
# Trial length is never defaulted: pricing runs only when QA_TRIAL_UNIT and QA_TRIAL_COUNT are set.
set -euo pipefail

high="${HIGH_RISK:-false}"
migration="${HAS_MIGRATION:-false}"
copy="${COPY_CHANGE:-false}"

if [[ "$high" != "true" && "$migration" != "true" && "$copy" != "true" ]]; then
  echo "acceptance: no high-risk, has-migration, or copy-change label"
  exit 0
fi

if [[ "$high" == "true" || "$migration" == "true" ]]; then
  npx vitest run --config e2e/acceptance/vitest.config.ts e2e/acceptance/tests/money.spec.ts
  missing=0
  for name in SUPABASE_URL SUPABASE_ANON_KEY QA_ORG_A_JWT QA_RPC_CASES_JSON; do
    if [[ -z "${!name:-}" ]]; then
      echo "acceptance: ${name} is required for rpc-security" >&2
      missing=1
    fi
  done
  if [[ "$missing" -ne 0 ]]; then
    exit 1
  fi
  npx vitest run --config e2e/acceptance/vitest.config.ts e2e/acceptance/tests/rpc-security.spec.ts
fi

if [[ "$high" == "true" ]]; then
  missing=0
  for name in E2E_BASE_URL \
    QA_ADMIN_EMAIL QA_ADMIN_PASSWORD QA_ADMIN_DISPLAY_NAME \
    QA_ACCOUNTANT_EMAIL QA_ACCOUNTANT_PASSWORD \
    QA_MANAGER_EMAIL QA_MANAGER_PASSWORD \
    QA_OWNER_EMAIL QA_OWNER_PASSWORD \
    QA_TENANT_EMAIL QA_TENANT_PASSWORD \
    QA_READONLY_PAYMENT_PATH QA_EXISTING_PAYMENT_PATH \
    QA_STATEMENT_PATH QA_NEXT_STATEMENT_PATH QA_NEGATIVE_STATEMENT_PATH \
    QA_STATEMENT_PAYMENT_PATH QA_OTHER_OWNER_STATEMENT_PATH QA_CROSS_ORG_STATEMENT_PATH \
    QA_MOVEOUT_PATH QA_MOVEOUT_SHORTFALL_PATH; do
    if [[ -z "${!name:-}" ]]; then
      echo "acceptance: ${name} is required for the browser suites" >&2
      missing=1
    fi
  done
  if [[ "$missing" -ne 0 ]]; then
    exit 1
  fi
  npx playwright test --config e2e/acceptance/playwright.config.ts \
    tests/payments.e2e.spec.ts tests/settlement.e2e.spec.ts tests/moveout.e2e.spec.ts
fi

if [[ "$copy" == "true" ]]; then
  npx vitest run --config e2e/acceptance/vitest.config.ts e2e/acceptance/tests/copy-banned-terms.spec.ts
fi

if [[ -n "${QA_TRIAL_UNIT:-}" && -n "${QA_TRIAL_COUNT:-}" ]]; then
  npx vitest run --config e2e/acceptance/vitest.config.ts e2e/acceptance/tests/pricing.spec.ts
else
  echo "acceptance: pricing suite not run because QA_TRIAL_UNIT and QA_TRIAL_COUNT are unset"
fi

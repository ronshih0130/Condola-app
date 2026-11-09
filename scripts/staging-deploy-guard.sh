#!/usr/bin/env bash
# Classify a push diff for the existing Depot staging deploy.
# stdin: one changed path per line.
# stdout: "skip" when every path is rehearsal/guard configuration, otherwise "deploy".
# An empty list prints "deploy" so an unreadable diff does not suppress a real release.
set -euo pipefail

safe='.gitignore
.depot/workflows/ci.yml
.github/workflows/pg17-synthetic-rehearsal.yml
docs/pg17-synthetic-rehearsal.md
scripts/pg17-restore-compare.sql
scripts/pg17-synthetic-rehearsal.sh
scripts/staging-deploy-guard.sh
scripts/staging-deploy-guard.test.sh
scripts/claim.sh
scripts/claim-github.test.sh'

saw=0
while IFS= read -r path || [[ -n "$path" ]]; do
  [[ -z "$path" ]] && continue
  saw=1
  if ! grep -Fxq -- "$path" <<< "$safe"; then
    printf 'deploy\n'
    exit 0
  fi
done
if [[ "$saw" == 0 ]]; then
  printf 'deploy\n'
else
  printf 'skip\n'
fi

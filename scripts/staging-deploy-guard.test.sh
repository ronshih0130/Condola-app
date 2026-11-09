#!/usr/bin/env bash
# Fixture checks for the staging-deploy path guard. No network and no database.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
guard="$root/scripts/staging-deploy-guard.sh"
depot="$root/.depot/workflows/ci.yml"

expect() {
  local want=$1
  shift
  local got
  if [[ "$#" -eq 0 ]]; then
    got=$(printf '' | bash "$guard")
  else
    got=$(printf '%s\n' "$@" | bash "$guard")
  fi
  if [[ "$got" != "$want" ]]; then
    printf 'guard expected %s, got %s, paths: %s\n' "$want" "$got" "$*" >&2
    exit 1
  fi
}

expect skip \
  .gitignore \
  .depot/workflows/ci.yml \
  .github/workflows/pg17-synthetic-rehearsal.yml \
  docs/pg17-synthetic-rehearsal.md \
  scripts/pg17-restore-compare.sql \
  scripts/pg17-synthetic-rehearsal.sh \
  scripts/staging-deploy-guard.sh \
  scripts/staging-deploy-guard.test.sh
expect deploy src/server/seed.ts
expect deploy .gitignore src/server/seed.ts
expect deploy package.json
expect deploy supabase/migrations/20261106000000_b008_monthly_rent_operation.sql
expect deploy scripts/staging-deploy-guard.sh.bak
expect deploy 'scripts/staging-deploy-guard.sh '
expect deploy
python3 - "$depot" <<'PY'
import pathlib, sys
import yaml
text = pathlib.Path(sys.argv[1]).read_text()
doc = yaml.safe_load(text)
job = doc["jobs"]["deploy-staging"]
condition = job["if"]
for required in (
    "github.event_name == 'push'",
    "github.ref == 'refs/heads/main'",
    "vars.STAGING_AUTODEPLOY == 'true'",
    "needs.check.outputs.staging_deploy == 'yes'",
):
    if required not in condition:
        raise SystemExit(f"deploy condition missing {required}")
if "secrets.CLOUDFLARE_API_TOKEN" not in text or "scripts/cf-deploy-staging.sh" not in text:
    raise SystemExit("staging deploy command was removed")
check = doc["jobs"]["check"]
if check.get("outputs", {}).get("staging_deploy") != "${{ steps.guard.outputs.staging_deploy }}":
    raise SystemExit("check job does not publish the guard output")
guard_steps = [step for step in check["steps"] if step.get("id") == "guard"]
if len(guard_steps) != 1:
    raise SystemExit("expected one guard step on the check job")
step = guard_steps[0]
if step.get("if") != "github.event_name == 'push' && github.ref == 'refs/heads/main'":
    raise SystemExit("guard step is not limited to main pushes")
if "exit 0" not in step.get("run", ""):
    raise SystemExit("guard step must not fail the existing check job")
print("depot-guard-ok")
PY
printf 'guard-ok\n'

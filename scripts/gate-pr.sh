#!/usr/bin/env bash
# Lauren item 6: one local PR gate, identical on the Mac and the box.
# Runs, in order, stopping at the first failure:
#   1. typecheck        npm run typecheck
#   2. lint             npm run lint
#   3. check-pr-rules   node scripts/check-pr-rules.mjs --r2-only (R3 = typecheck + test:unit, run as steps 1 and 4)
#   4. test:unit        npm run test:unit
# Usage: npm run gate:pr [-- --base <ref>] [-- --pr-body-file <path>]
#   --base defaults to origin/main. The PR body (for R2 `Spec-Change:` lines) comes from --pr-body-file,
#   else $PR_BODY_FILE, else `gh pr view --json body` for the current branch when gh is available, else empty.
# Test hooks (used only by scripts/gate-pr.test.ts): GATE_PR_DRY_RUN=1 prints each step instead of running it;
#   GATE_PR_FAIL_AT=<step> makes that step fail in dry-run mode.
# This does not replace scripts/gate.sh (full/release gate) and is not wired into any workflow.
set -uo pipefail

base="origin/main"
body_file="${PR_BODY_FILE:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --base) base="${2:?--base needs a ref}"; shift 2 ;;
    --pr-body-file) body_file="${2:?--pr-body-file needs a path}"; shift 2 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "gate:pr: unknown argument: $1" >&2; exit 2 ;;
  esac
done

tmp_body=""
cleanup() { if [ -n "$tmp_body" ]; then rm -f -- "$tmp_body"; fi; }
trap cleanup EXIT
if [ -z "$body_file" ] && [ "${GATE_PR_DRY_RUN:-}" != "1" ] && command -v gh >/dev/null 2>&1; then
  tmp_body="$(mktemp "${TMPDIR:-/tmp}/gate-pr-body.XXXXXX")"
  if gh pr view --json body -q .body > "$tmp_body" 2>/dev/null; then body_file="$tmp_body"; fi
fi
rules=(node scripts/check-pr-rules.mjs --base "$base" --head HEAD --r2-only)
if [ -n "$body_file" ]; then rules+=(--pr-body-file "$body_file"); fi

step() {
  local name="$1"; shift
  echo "== gate:pr [$name] $*"
  if [ "${GATE_PR_DRY_RUN:-}" = "1" ]; then
    if [ "${GATE_PR_FAIL_AT:-}" = "$name" ]; then echo "gate:pr FAIL at $name"; exit 1; fi
    return 0
  fi
  if ! "$@"; then echo "gate:pr FAIL at $name"; exit 1; fi
}

step typecheck npm run -s typecheck
step lint npm run -s lint
step check-pr-rules "${rules[@]}"
step test:unit npm run -s test:unit
echo "gate:pr PASS (typecheck, lint, check-pr-rules, test:unit) at $(git rev-parse --short HEAD 2>/dev/null || echo unknown)"

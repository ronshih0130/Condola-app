#!/usr/bin/env bash
# Lauren item 6: one local PR gate, identical on the Mac and the box.
# Runs, in order, stopping at the first failure:
#   1. typecheck        npm run typecheck
#   2. lint             npm run lint
#   3. check-pr-rules   node scripts/check-pr-rules.mjs --no-r3: every rule except R3 (R2 Spec-Change, R4 Verification);
#                       R3 = typecheck + test:unit, run as steps 1 and 4
#   4. test:unit        npm run test:unit
# Usage: npm run gate:pr [-- --base <ref>] [-- --pr-body-file <path>] [-- --pr-title <text>]
#   --base defaults to origin/main. The PR body (R2 `Spec-Change:`, R4 `## Verification`) comes from --pr-body-file,
#   else $PR_BODY_FILE, else `gh pr view` for the current branch when gh is available, else empty (R4 then fails).
#   The PR title (R4 spots `fix:` titles) comes from --pr-title, else $PR_TITLE, else the same `gh pr view`.
# There is no skip or dry-run switch: every step always runs (tests use stub npm/node executables on PATH).
# This does not replace scripts/gate.sh (full/release gate) and is not wired into any workflow.
set -uo pipefail

base="origin/main"
body_file="${PR_BODY_FILE:-}"
title="${PR_TITLE:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --base) base="${2:?--base needs a ref}"; shift 2 ;;
    --pr-body-file) body_file="${2:?--pr-body-file needs a path}"; shift 2 ;;
    --pr-title) title="${2?--pr-title needs a value}"; shift 2 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "gate:pr: unknown argument: $1" >&2; exit 2 ;;
  esac
done

tmp_body=""
cleanup() { if [ -n "$tmp_body" ]; then rm -f -- "$tmp_body"; fi; }
trap cleanup EXIT
if [ -z "$body_file" ] && command -v gh >/dev/null 2>&1; then
  tmp_body="$(mktemp "${TMPDIR:-/tmp}/gate-pr-body.XXXXXX")"
  if gh pr view --json body -q .body > "$tmp_body" 2>/dev/null; then
    body_file="$tmp_body"
    if [ -z "$title" ]; then title="$(gh pr view --json title -q .title 2>/dev/null || true)"; fi
  fi
fi
rules=(node scripts/check-pr-rules.mjs --base "$base" --head HEAD --no-r3)
if [ -n "$body_file" ]; then rules+=(--pr-body-file "$body_file"); fi
if [ -n "$title" ]; then rules+=(--pr-title "$title"); fi

step() {
  local name="$1"; shift
  echo "== gate:pr [$name] $*"
  if ! "$@"; then echo "gate:pr FAIL at $name"; exit 1; fi
}

step typecheck npm run -s typecheck
step lint npm run -s lint
step check-pr-rules "${rules[@]}"
step test:unit npm run -s test:unit
echo "gate:pr PASS (typecheck, lint, check-pr-rules, test:unit) at $(git rev-parse --short HEAD 2>/dev/null || echo unknown)"

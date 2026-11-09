#!/usr/bin/env bash
# Isolated claim.sh checks. Uses temporary repositories only. Does not read or write live ops-lock.
set -euo pipefail
# This process must not inherit the operator URL rewrite. The assertions set
# remote URLs themselves. claim.sh is not changed to ignore that rewrite.
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_SYSTEM=/dev/null
root=$(cd "$(dirname "$0")/.." && pwd)
claim="$root/scripts/claim.sh"
real_git=$(command -v git)
fail() { printf 'claim-github.test: %s\n' "$*" >&2; exit 1; }

new_repo() {
  local dir=$1
  mkdir -p "$dir/src"
  "$real_git" init -q -b main "$dir/src"
  "$real_git" -C "$dir/src" config user.email test@example.com
  "$real_git" -C "$dir/src" config user.name test
  printf 'handoff\n' >"$dir/src/HANDOFF.md"
  "$real_git" -C "$dir/src" add HANDOFF.md
  "$real_git" -C "$dir/src" commit -q -m init
  "$real_git" init -q --bare "$dir/remote.git"
  "$real_git" -C "$dir/src" remote add origin "$dir/remote.git"
  "$real_git" -C "$dir/src" push -q origin main
}

assert_rejects() {
  local url=$1
  local needle=$2
  local secret=${3:-}
  local dir err
  dir=$(mktemp -d)
  new_repo "$dir"
  "$real_git" -C "$dir/src" remote set-url origin "$url"
  "$real_git" -C "$dir/src" remote set-url --push origin "$url"
  set +e
  err=$(cd "$dir/src" && bash "$claim" status 2>&1)
  set -e
  printf '%s\n' "$err" | grep -q -- "$needle" || fail "expected [$needle] for url class, got [$err]"
  if [[ -n "$secret" ]] && printf '%s\n' "$err" | grep -q -- "$secret"; then
    fail "rejection printed an embedded credential"
  fi
  rm -rf "$dir"
}

assert_rejects "https://origin.cursor.com/ron-shih/condola-app.git" "origin fetch must target GitHub"
assert_rejects "https://github.com/other/Condola-app.git" "origin fetch must target GitHub"
assert_rejects "https://x-access-token:super-secret-token@github.com/ronshih0130/Condola-app.git" "no embedded credentials" "super-secret-token"

accept_url() {
  local url=$1
  local dir bin err
  dir=$(mktemp -d)
  bin="$dir/bin"
  mkdir -p "$bin"
  cat >"$bin/git" <<EOF
#!/bin/bash
if [[ "\$1" == ls-remote && "\$2" == --exit-code ]]; then
  exit 2
fi
exec "$real_git" "\$@"
EOF
  chmod +x "$bin/git"
  new_repo "$dir"
  "$real_git" -C "$dir/src" remote set-url origin "$url"
  "$real_git" -C "$dir/src" remote set-url --push origin "$url"
  set +e
  err=$(cd "$dir/src" && PATH="$bin:$PATH" bash "$claim" status 2>&1)
  set -e
  printf '%s\n' "$err" | grep -q "ops-lock is absent" || fail "allowed url was not accepted: [$err]"
  printf '%s\n' "$err" | grep -q "Cursor Origin" && fail "still mentions Cursor Origin"
  rm -rf "$dir"
}

accept_url "https://github.com/ronshih0130/Condola-app"
accept_url "https://github.com/ronshih0130/Condola-app.git"
accept_url "git@github.com:ronshih0130/Condola-app.git"
accept_url "ssh://git@github.com/ronshih0130/Condola-app.git"

lifecycle() {
  local dir=$1
  local session=$2
  local base=(env CLAIM_TEST_ANY_REMOTE=YES CONDOLA_SESSION_ID="$session" CONDOLA_MODEL=test)
  new_repo "$dir"
  (cd "$dir/src" && "${base[@]}" CLAIM_BOOTSTRAP=YES bash "$claim" acquire repo B FixtureOwner >/dev/null)
  local status_out
  status_out=$(cd "$dir/src" && CLAIM_TEST_ANY_REMOTE=YES bash "$claim" status)
  printf '%s\n' "$status_out" | grep -q 'effective=ACTIVE' || fail "acquire did not become ACTIVE"
  local other
  other=$(cat /proc/sys/kernel/random/uuid)
  if (cd "$dir/src" && CLAIM_TEST_ANY_REMOTE=YES CONDOLA_SESSION_ID="$other" bash "$claim" acquire repo B OtherOwner >/dev/null 2>&1); then
    fail "second session acquired a held lock"
  fi
  (cd "$dir/src" && "${base[@]}" bash "$claim" renew >/dev/null)
  local gen
  gen=$("$real_git" -C "$dir/src" fetch -q origin ops-lock && "$real_git" -C "$dir/src" show FETCH_HEAD:ops/LOCK | awk -F= '$1=="generation"{print $2}')
  [[ "$gen" == 2 ]] || fail "renew did not advance generation to 2 (got $gen)"
  if (cd "$dir/src" && "${base[@]}" bash "$claim" release >/dev/null 2>&1); then
    fail "release succeeded without CLAIM_STOPPED"
  fi
  (cd "$dir/src" && "${base[@]}" CLAIM_STOPPED=YES CLAIM_EVIDENCE=fixture bash "$claim" release >/dev/null)
  status_out=$(cd "$dir/src" && CLAIM_TEST_ANY_REMOTE=YES bash "$claim" status)
  printf '%s\n' "$status_out" | grep -q 'effective=RELEASED' || fail "release did not become RELEASED"
}

life=$(mktemp -d)
session=$(cat /proc/sys/kernel/random/uuid)
lifecycle "$life" "$session"

# A failed ops-lock push must not be retried and must not create the ref.
cas=$(mktemp -d)
casbin="$cas/bin"
mkdir -p "$casbin"
cat >"$casbin/git" <<EOF
#!/bin/bash
if [[ "\$1" == push ]]; then
  exit 1
fi
exec "$real_git" "\$@"
EOF
chmod +x "$casbin/git"
new_repo "$cas"
set +e
cas_err=$(cd "$cas/src" && PATH="$casbin:$PATH" CLAIM_TEST_ANY_REMOTE=YES CLAIM_BOOTSTRAP=YES CONDOLA_SESSION_ID="$(cat /proc/sys/kernel/random/uuid)" bash "$claim" acquire repo B FixtureOwner 2>&1)
cas_rc=$?
set -e
[[ "$cas_rc" -ne 0 ]] || fail "forced push failure still acquired"
printf '%s\n' "$cas_err" | grep -q "CAS failed" || fail "missing CAS failure: [$cas_err]"
if "$real_git" -C "$cas/remote.git" rev-parse --verify --quiet refs/heads/ops-lock >/dev/null; then
  fail "failed CAS still published ops-lock"
fi

# Stale renewal does not make the lock available to someone else.
stale=$(mktemp -d)
stale_session=$(cat /proc/sys/kernel/random/uuid)
new_repo "$stale"
(cd "$stale/src" && CLAIM_TEST_ANY_REMOTE=YES CONDOLA_SESSION_ID="$stale_session" CLAIM_BOOTSTRAP=YES bash "$claim" acquire repo B FixtureOwner >/dev/null)
"$real_git" clone -q --branch ops-lock "$stale/remote.git" "$stale/lock"
awk -F= 'BEGIN{OFS="="} $1=="renewed_epoch_seconds"{$2=1} {print}' "$stale/lock/ops/LOCK" >"$stale/lock/ops/LOCK.new"
mv "$stale/lock/ops/LOCK.new" "$stale/lock/ops/LOCK"
"$real_git" -C "$stale/lock" config user.email test@example.com
"$real_git" -C "$stale/lock" config user.name test
"$real_git" -C "$stale/lock" add ops/LOCK
"$real_git" -C "$stale/lock" commit -q -m 'fixture stale renewal'
"$real_git" -C "$stale/lock" push -q origin HEAD:ops-lock --force-with-lease
stale_status=$(cd "$stale/src" && CLAIM_TEST_ANY_REMOTE=YES bash "$claim" status)
printf '%s\n' "$stale_status" | grep -q 'effective=SUSPECT' || fail "stale claim was not SUSPECT: [$stale_status]"
if (cd "$stale/src" && CLAIM_TEST_ANY_REMOTE=YES CONDOLA_SESSION_ID="$(cat /proc/sys/kernel/random/uuid)" bash "$claim" acquire repo B OtherOwner >/dev/null 2>&1); then
  fail "SUSPECT lock was taken by another session"
fi

rm -rf "$life" "$cas" "$stale"
printf 'claim-github-ok\n'

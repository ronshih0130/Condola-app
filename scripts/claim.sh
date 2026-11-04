#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

usage() {
  cat <<'EOF'
Usage:
  claim.sh acquire <repo|prod|staging> <A|B> <who>
  claim.sh renew
  claim.sh release
  claim.sh status
  claim.sh break <reason>

CLAIM_RESOURCE selects renew/release/break (default: repo).
status shows all resources unless CLAIM_RESOURCE is set.
All mutations require CONDOLA_SESSION_ID: one UUID per ownership session.
Keep that UUID in the supervising shell; subordinate jobs share ownership.

First-time branch creation only:
  CLAIM_BOOTSTRAP=YES claim.sh acquire repo <A|B> <who>
This creates the initial ops-lock commit only if the remote ref is absent.

Resource acquisition requires CLAIM_LANE and CLAIM_SHA.
Production also requires CLAIM_BASELINE (commit), CLAIM_ROLLBACK (version),
and CLAIM_PHASE=PREPARED or INCIDENT_TAKEOVER.
Renew may update CLAIM_PHASE and CLAIM_EVIDENCE, not candidate/baseline.

Release requires CLAIM_STOPPED=YES and CLAIM_EVIDENCE (sanitized reference).
Production release requires CLAIM_PHASE=T15_PASS or INCIDENT_RESOLVED.
Repository release requires clean main and every local branch published.
break requires CLAIM_FENCE_EVIDENCE and interactive confirmation by Ron:
confirm shutdown/fencing, outstanding operations, and the exact holder.

Renew manually at checkpoints. Six hours without renewal => SUSPECT.
SUSPECT never means available. PROD_LOCK never expires.
Receipts live in the common Git directory; never copy them between hosts.
CAS rejection is not retried. Fetch, inspect, and reconcile before retrying.
EOF
}

die() { printf 'claim: %s\n' "$*" >&2; exit 1; }
stamp() { TZ=America/Los_Angeles date '+%Y-%m-%dT%H:%M:%S%z PT (America/Los_Angeles)'; }
single_line() {
  [ -n "$1" ] || die "Required value is empty."
  case "$1" in *$'\n'*|*$'\r'*|*$'\t'*) die "Values must be single-line text." ;; esac
}
uuid() {
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen
  elif [ -r /proc/sys/kernel/random/uuid ]; then
    cat /proc/sys/kernel/random/uuid
  else
    die "Need uuidgen or /proc/sys/kernel/random/uuid."
  fi
}
filename() {
  case "$1" in
    repo) printf LOCK ;;
    prod) printf PROD_LOCK ;;
    staging) printf STAGING_LOCK ;;
    *) die "Unknown resource: $1" ;;
  esac
}

[ "$#" -gt 0 ] || { usage >&2; exit 2; }
command_name=$1
shift
case "$command_name" in -h|--help) usage; exit 0 ;; esac
resource=${CLAIM_RESOURCE:-repo}
mode=
who=
reason=
case "$command_name" in
  acquire)
    [ "$#" -eq 3 ] || { usage >&2; exit 2; }
    resource=$1; mode=$2; who=$3
    case "$mode" in A|B) ;; *) die "Mode must be A or B." ;; esac
    single_line "$who"
    ;;
  renew|release|status)
    [ "$#" -eq 0 ] || { usage >&2; exit 2; }
    ;;
  break)
    [ "$#" -eq 1 ] || { usage >&2; exit 2; }
    reason=$1
    single_line "$reason"
    ;;
  *) usage >&2; exit 2 ;;
esac
filename "$resource" >/dev/null

root=$(git rev-parse --show-toplevel) || die "Run inside the canonical checkout."
cd "$root"
common=$(git rev-parse --git-common-dir)
case "$common" in /*) ;; *) common="$root/$common" ;; esac
common=$(cd "$common" && pwd -P)
# GitHub ronshih0130/Condola-app is canonical (DECISIONS 2026-11-03/04).
# Validate effective fetch AND push destinations (pushurl, url rewrites).
allowed_remote() {
  case "$1" in
    https://github.com/ronshih0130/Condola-app|https://github.com/ronshih0130/Condola-app.git) return 0 ;;
    git@github.com:ronshih0130/Condola-app.git|ssh://git@github.com/ronshih0130/Condola-app.git) return 0 ;;
    *) return 1 ;;
  esac
}
fetch_url=$(git ls-remote --get-url origin)
push_urls=$(git remote get-url --push --all origin)
if [ "${CLAIM_TEST_ANY_REMOTE:-}" != "YES" ]; then
  allowed_remote "$fetch_url" ||
    die "origin fetch must target GitHub ronshih0130/Condola-app (no embedded credentials); refusing to print its URL."
  while IFS= read -r pu; do
    allowed_remote "$pu" ||
      die "origin push must target GitHub ronshih0130/Condola-app (no embedded credentials); refusing to print its URL."
  done <<<"$push_urls"
fi

session=${CONDOLA_SESSION_ID:-}
host=$(hostname)
guard=
tmp=
snapshot_ref="refs/condola/claim-snapshot-$$"
cleanup() {
  git update-ref -d "$snapshot_ref" >/dev/null 2>&1 || :
  [ -z "$tmp" ] || rm -rf "$tmp"
  [ -z "$guard" ] || rmdir "$guard" 2>/dev/null || :
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "$command_name" != status ]; then
  [[ "$session" =~ ^[[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12}$ ]] ||
    die "Set CONDOLA_SESSION_ID to a unique ownership-session UUID."
  if mkdir "$common/condola-claim.guard" 2>/dev/null; then
    guard="$common/condola-claim.guard"
  else
    die "Another local claim command may be running. After proving it stopped, remove $common/condola-claim.guard manually."
  fi
fi
tmp=$(mktemp -d "${TMPDIR:-/tmp}/condola-claim.XXXXXX")
old=
if advertised=$(git ls-remote --exit-code origin refs/heads/ops-lock); then
  git fetch --quiet --no-tags origin "+refs/heads/ops-lock:$snapshot_ref" ||
    die "Cannot fetch ownership; stop new work."
  old=$(git rev-parse "$snapshot_ref^{commit}")
else
  rc=$?
  [ "$rc" -eq 2 ] || die "Cannot reach origin; ownership is unknown."
  if [ "$command_name" != acquire ] || [ "$resource" != repo ] ||
     [ "${CLAIM_BOOTSTRAP:-}" != YES ]; then
    die "ops-lock is absent. Explicit CLAIM_BOOTSTRAP=YES is required for initial repo acquisition."
  fi
fi

now=$(date +%s)
written_at=$(stamp)
for item in repo prod staging; do
  name=$(filename "$item")
  if [ -n "$old" ]; then
    git show "$old:ops/$name" >"$tmp/$item" ||
      die "Malformed ops-lock: missing ops/$name. Repair through reviewed recovery."
  else
    cat >"$tmp/$item" <<EOF
resource=$item
state=RELEASED
generation=0
mode=-
who=-
host=-
session_uuid=-
claim_uuid=-
acquired_at=-
renewed_at=-
renewed_epoch_seconds=0
updated_at=$written_at
stopped_at=-
checkpoint=-
handoff_commit=-
lane=-
sha=-
baseline=-
rollback=-
phase=INITIAL
event=INITIAL
actor=-
evidence=-
reason=-
EOF
  fi
done

field() {
  awk -v key="$2" '
    index($0, key "=") == 1 { count++; value=substr($0,length(key)+2) }
    END { if (count != 1) exit 1; print value }
  ' "$tmp/$1"
}
put() {
  single_line "$3"
  CLAIM_FIELD_VALUE=$3 awk -v key="$2" '
    BEGIN { value=ENVIRON["CLAIM_FIELD_VALUE"] }
    index($0,key "=") == 1 { print key "=" value; found=1; next }
    { print }
    END { if (!found) print key "=" value }
  ' "$tmp/$1" >"$tmp/edit"
  mv "$tmp/edit" "$tmp/$1"
}
for item in repo prod staging; do
  [ "$(field "$item" resource)" = "$item" ] || die "Resource record mismatch."
  case "$(field "$item" state)" in ACTIVE|RELEASED) ;; *) die "Invalid lock state." ;; esac
  for key in generation renewed_epoch_seconds; do
    value=$(field "$item" "$key")
    [[ "$value" =~ ^(0|[1-9][0-9]{0,11})$ ]] || die "Invalid numeric lock field: $key."
  done
done

fresh() {
  [ "$1" = prod ] && return 0
  age=$((now - $(field "$1" renewed_epoch_seconds)))
  [ "$age" -ge 0 ] && [ "$age" -le 21600 ]
}
is_owned() {
  [ "$(field "$1" state)" = ACTIVE ] || return 1
  [ "$(field "$1" session_uuid)" = "$session" ] || return 1
  [ "$(field "$1" host)" = "$host" ] || return 1
  [ -f "$common/condola-claims/$session/$1" ] || return 1
  [ "$(cat "$common/condola-claims/$session/$1")" = "$(field "$1" claim_uuid)" ]
}
require_owned() { is_owned "$1" || die "This host/session does not own $1."; }
require_repo() {
  require_owned repo
  fresh repo || die "Repository ownership is SUSPECT; renew repo explicitly first."
}
children_released() {
  for child in prod staging; do
    [ "$(field "$child" state)" = RELEASED ] ||
      die "$child remains held; resolve/release or explicitly fence it first."
  done
}
show_status() {
  for item in "$@"; do
    effective=$(field "$item" state)
    if [ "$effective" = ACTIVE ] && ! fresh "$item"; then effective=SUSPECT; fi
    printf '\n[%s] effective=%s observed_at=%s\n' "$item" "$effective" "$(stamp)"
    cat "$tmp/$item"
    [ "$item" != prod ] || printf 'expiry=NEVER\n'
  done
}
if [ "$command_name" = status ]; then
  if [ -n "${CLAIM_RESOURCE:-}" ]; then
    show_status "$resource"
  else
    show_status repo prod staging
  fi
  exit 0
fi

# Idempotent only for this exact host/session/receipt and original identity.
if [ "$command_name" = acquire ] && [ "$(field "$resource" state)" = ACTIVE ]; then
  is_owned "$resource" || die "$resource is held; age never makes it available."
  [ "$(field "$resource" mode)" = "$mode" ] &&
    [ "$(field "$resource" who)" = "$who" ] ||
    die "Existing claim identity differs."
  command_name=renew
fi

case "$command_name" in
  acquire)
    [ "$(field "$resource" state)" = RELEASED ] || die "$resource is not released."
    if [ "$resource" = repo ]; then
      children_released
    else
      require_repo
      [ "$(field repo mode)" = "$mode" ] &&
        [ "$(field repo who)" = "$who" ] ||
        die "Resource identity must match repository owner."
      lane=${CLAIM_LANE:-}
      candidate=${CLAIM_SHA:-}
      single_line "$lane"; single_line "$candidate"
      candidate=$(git rev-parse --verify "$candidate^{commit}") ||
        die "CLAIM_SHA must identify a local commit."
      put "$resource" lane "$lane"
      put "$resource" sha "$candidate"
      if [ "$resource" = prod ]; then
        baseline=${CLAIM_BASELINE:-}
        rollback=${CLAIM_ROLLBACK:-}
        phase=${CLAIM_PHASE:-}
        single_line "$baseline"; single_line "$rollback"
        case "$phase" in PREPARED|INCIDENT_TAKEOVER) ;; *) die "Invalid production acquisition phase." ;; esac
        if [ "$(field prod phase)" = BROKEN_RECONCILE ] && [ "$phase" != INCIDENT_TAKEOVER ]; then
          die "Broken production claim requires INCIDENT_TAKEOVER and reconciliation."
        fi
        baseline=$(git rev-parse --verify "$baseline^{commit}") ||
          die "CLAIM_BASELINE must identify a local commit."
        put prod baseline "$baseline"
        put prod rollback "$rollback"
        put prod phase "$phase"
      else
        put staging phase "${CLAIM_PHASE:-CLAIMED}"
      fi
    fi
    claim_uuid=$(uuid)
    mkdir -p "$common/condola-claims/$session"
    # Save before push: a lost push response must not lose the acquisition receipt.
    printf '%s\n' "$claim_uuid" >"$common/condola-claims/$session/$resource"
    put "$resource" state ACTIVE
    put "$resource" mode "$mode"
    put "$resource" who "$who"
    put "$resource" host "$host"
    put "$resource" session_uuid "$session"
    put "$resource" claim_uuid "$claim_uuid"
    put "$resource" acquired_at "$written_at"
    put "$resource" stopped_at -
    [ "$resource" != repo ] || put repo phase WORKING
    ;;
  renew)
    require_owned "$resource"
    [ "$resource" = repo ] || require_repo
    if [ -n "${CLAIM_PHASE:-}" ]; then put "$resource" phase "$CLAIM_PHASE"; fi
    ;;
  release)
    require_owned "$resource"
    [ "$resource" = repo ] || require_repo
    [ "${CLAIM_STOPPED:-}" = YES ] || die "Confirm drained local/remote jobs with CLAIM_STOPPED=YES."
    single_line "${CLAIM_EVIDENCE:-}"
    if [ "$resource" = prod ]; then
      case "${CLAIM_PHASE:-}" in
        T15_PASS|INCIDENT_RESOLVED) put prod phase "$CLAIM_PHASE" ;;
        *) die "Production release needs T15_PASS or INCIDENT_RESOLVED evidence." ;;
      esac
    fi
    if [ "$resource" = repo ]; then
      children_released
      [ -z "$(git status --porcelain --untracked-files=all)" ] ||
        die "Publish/preserve all work before repository release."
      branch=$(git symbolic-ref --quiet --short HEAD) ||
        die "Release repository ownership from main, not detached HEAD."
      [ "$branch" = main ] || die "Publish HANDOFF/board on main before release."
      git cat-file -e HEAD:HANDOFF.md || die "HANDOFF.md must be committed."
      git ls-remote --heads origin >"$tmp/published"
      git for-each-ref --format='%(refname) %(objectname)' refs/heads >"$tmp/local-heads"
      while read -r ref tip; do
        [ "$ref" != refs/heads/ops-lock ] || continue
        remote_tip=$(awk -v ref="$ref" '$2 == ref { print $1 }' "$tmp/published")
        [ "$tip" = "$remote_tip" ] || die "Local branch is not published at the same tip: $ref"
      done <"$tmp/local-heads"
      put repo phase STOPPED
    fi
    put "$resource" state RELEASED
    put "$resource" stopped_at "$(stamp)"
    ;;
  break)
    [ "$(field "$resource" state)" = ACTIVE ] || die "$resource is already released."
    single_line "${CLAIM_FENCE_EVIDENCE:-}"
    [ "$resource" != repo ] || children_released
    holder="$(field "$resource" mode)/$(field "$resource" who)/$(field "$resource" session_uuid)/$(field "$resource" claim_uuid)"
    printf 'Ron: confirm prior executor shutdown/fencing and checked deployment/DB operations.\nEvidence: %s\nType STOPPED or FENCED: ' "$CLAIM_FENCE_EVIDENCE" >/dev/tty
    read -r confirmation </dev/tty
    case "$confirmation" in STOPPED|FENCED) ;; *) die "Break cancelled." ;; esac
    printf 'Type the current holder exactly:\n%s\n> ' "$holder" >/dev/tty
    read -r typed_holder </dev/tty
    [ "$typed_holder" = "$holder" ] || die "Holder confirmation did not match."
    put "$resource" state RELEASED
    put "$resource" phase BROKEN_RECONCILE
    put "$resource" stopped_at "$(stamp)"
    put "$resource" reason "$reason"
    put "$resource" evidence "$CLAIM_FENCE_EVIDENCE"
    put "$resource" fence_confirmation "$confirmation"
    put "$resource" broken_holder "$holder"
    ;;
esac

now=$(date +%s)
written_at=$(stamp)
generation=$(field "$resource" generation)
put "$resource" generation "$((generation + 1))"
put "$resource" updated_at "$written_at"
put "$resource" event "$command_name"
put "$resource" actor "$(id -un)@$host/$session"
put "$resource" checkpoint "$(git rev-parse HEAD)"
handoff=$(git log -1 --format=%H HEAD -- HANDOFF.md)
put "$resource" handoff_commit "${handoff:-unknown}"
if [ "$command_name" = acquire ] || [ "$command_name" = renew ]; then
  put "$resource" renewed_at "$written_at"
  put "$resource" renewed_epoch_seconds "$now"
fi
if [ -n "${CLAIM_EVIDENCE:-}" ] && [ "$command_name" != break ]; then
  put "$resource" evidence "$CLAIM_EVIDENCE"
fi

export GIT_INDEX_FILE="$tmp/index"
if [ -n "$old" ]; then git read-tree "$old"; else git read-tree --empty; fi
for item in repo prod staging; do
  blob=$(git hash-object -w "$tmp/$item")
  git update-index --add --cacheinfo 100644 "$blob" "ops/$(filename "$item")"
done
tree=$(git write-tree)
model=${CONDOLA_MODEL:-human}
single_line "$model"
cat >"$tmp/message" <<EOF
ops: $command_name $resource generation $((generation + 1))

Timestamp: $written_at
Evidence: $(field "$resource" evidence)
Reason: $(field "$resource" reason)

Model: $model
Role: ownership
Session: $session
EOF
if [ -n "$old" ]; then
  new=$(TZ=America/Los_Angeles git commit-tree "$tree" -p "$old" <"$tmp/message")
  [ "$(git rev-parse "$new^")" = "$old" ] || die "New commit is not a direct child."
else
  # Explicit initialization is the sole parentless case.
  new=$(TZ=America/Los_Angeles git commit-tree "$tree" <"$tmp/message")
fi

if ! git push origin "$new:refs/heads/ops-lock" \
  --force-with-lease="refs/heads/ops-lock:$old"; then
  printf 'CAS failed or its result is uncertain. No retry; receipt retained.\n' >&2
  if git fetch --quiet --no-tags origin "+refs/heads/ops-lock:$snapshot_ref"; then
    latest=$(git rev-parse "$snapshot_ref")
    printf 'Refetched ops-lock=%s; attempted=%s. Run status and reevaluate.\n' "$latest" "$new" >&2
  else
    printf 'Refetch failed; stop new work until ownership is verified.\n' >&2
  fi
  exit 1
fi
if [ "$command_name" = release ]; then
  rm -f "$common/condola-claims/$session/$resource"
fi
printf '%s: %s; ops-lock=%s; timestamp=%s\n' "$resource" "$command_name" "$new" "$written_at"

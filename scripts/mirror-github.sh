#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

usage() {
  cat <<'EOF'
Usage: scripts/mirror-github.sh [--dry-run] [--accept-drift-overwrite]
                               [--i-hold-the-lock]
One-way Origin → GitHub mirror of all heads (including cursor/*) and tags.
Requires git and python3. Mirror: https://github.com/ronshih0130/condola-app.git (private,
decided by Ron 2026-10-27); CONDOLA_GITHUB_MIRROR_URL overrides it.
Uses credential helpers, or GITHUB_MIRROR_TOKEN through temporary GIT_ASKPASS.
A successful claim.sh status must unambiguously identify this host as the
repository owner. The explicit assertion is accepted only if status is unavailable.
Drift exits 3 unless explicitly accepted. Pushes use per-ref leases and --atomic.
EOF
}
die() { printf 'mirror-github: %s\n' "$*" >&2; exit 1; }
stamp() { TZ=America/Los_Angeles date '+%Y-%m-%dT%H:%M:%S%z PT (America/Los_Angeles)'; }

dry=no
accept=no
assert_lock=no
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) dry=yes ;;
    --accept-drift-overwrite) accept=yes ;;
    --i-hold-the-lock) assert_lock=yes ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
  shift
done
for tool in git python3; do
  command -v "$tool" >/dev/null 2>&1 || die "Missing tool: $tool"
done
root=$(git rev-parse --show-toplevel) || die "Run inside the repository."
origin_url=https://origin.cursor.com/ron-shih/condola-app.git
github_url=${CONDOLA_GITHUB_MIRROR_URL:-https://github.com/ronshih0130/condola-app.git}
case "$github_url" in
  https://github.com/*)
    case "$github_url" in *'@'*|*'?'*|*'#'*) die "Credential-free URL required." ;; esac ;;
  git@github.com:*) ;;
  *) die "Set CONDOLA_GITHUB_MIRROR_URL to a credential-free GitHub URL." ;;
esac
cache=${CONDOLA_MIRROR_DIR:-"${HOME:?}/.cache/condola/mirror.git"}
case "$cache" in /*) ;; *) die "CONDOLA_MIRROR_DIR must be absolute." ;; esac

tmp=$(mktemp -d "${TMPDIR:-/tmp}/condola-mirror.XXXXXX")
chmod 700 "$tmp"
locked=no
cleanup() {
  rm -rf "$tmp"
  if [ "$locked" = yes ]; then rmdir "$cache.running" || :; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

check_lock() {
  if [ -f "$root/scripts/claim.sh" ] &&
     CLAIM_RESOURCE=repo bash "$root/scripts/claim.sh" status >"$tmp/status" 2>/dev/null; then
    # Fail closed on unfamiliar formats. Adapt this parser only after reviewing
    # claim.sh's actual status contract; a host mention alone is not ownership.
    python3 - "$tmp/status" "$(hostname)" <<'PY'
import json, re, sys
text = open(sys.argv[1], encoding="utf-8").read()
host = sys.argv[2]
owned = False
try:
    obj = json.loads(text)
    records = obj if isinstance(obj, list) else [obj]
    for r in records:
        if not isinstance(r, dict):
            continue
        resource = r.get("resource")
        owner = r.get("owner")
        owner_host = owner.get("host") if isinstance(owner, dict) else None
        owner_host = r.get("host", owner_host)
        state = str(r.get("status", r.get("state", ""))).upper()
        if resource == "repo" and owner_host == host and state in ("HELD", "ACTIVE", "OWNED"):
            owned = True
except (ValueError, TypeError):
    # Supported text contract: one repo record with explicit state and host.
    for line in text.splitlines():
        if re.search(r"(^|\s)resource=repo(\s|$)", line):
            fields = dict(re.findall(r"(resource|host|status|state)=([^\s]+)", line))
            if fields.get("host") == host and fields.get("status", fields.get("state")) in ("HELD", "ACTIVE", "OWNED"):
                owned = True
if not owned:
    print("mirror-github: Cannot verify active repo ownership by this host; inspect claim.sh status.", file=sys.stderr)
    sys.exit(1)
PY
  else
    [ "$assert_lock" = yes ] ||
      die "claim.sh status unavailable; --i-hold-the-lock is required."
  fi
}
check_lock

if [ -n "${GITHUB_MIRROR_TOKEN:-}" ]; then
  cat >"$tmp/askpass" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
set +x
case "${1:-}" in
  *Username*|*username*) printf '%s\n' x-access-token ;;
  *Password*|*password*) printf '%s\n' "${GITHUB_MIRROR_TOKEN:?}" ;;
  *) exit 1 ;;
esac
EOF
  chmod 700 "$tmp/askpass"
  export GIT_ASKPASS="$tmp/askpass"
  export GIT_TERMINAL_PROMPT=0
  # Override helpers only in this process; no persisted credential changes.
  export GIT_CONFIG_COUNT=1
  export GIT_CONFIG_KEY_0=credential.helper
  export GIT_CONFIG_VALUE_0=
fi

mkdir -p "$(dirname "$cache")"
mkdir "$cache.running" 2>/dev/null ||
  die "Mirror cache is busy; inspect any stale .running directory manually."
locked=yes
if [ ! -e "$cache" ]; then
  git clone --mirror "$origin_url" "$cache" >"$tmp/git-output" 2>&1 ||
    die "Origin mirror clone failed; diagnostics withheld."
fi
[ "$(git -C "$cache" rev-parse --is-bare-repository)" = true ] ||
  die "Mirror cache must be bare."
[ "$(git -C "$cache" remote get-url origin)" = "$origin_url" ] ||
  die "Mirror cache origin differs; review manually."

# Do not remote-update github: its namespace is fetched explicitly below.
git -C "$cache" remote update --prune origin >"$tmp/git-output" 2>&1 ||
  die "Origin update failed; diagnostics withheld."
if git -C "$cache" remote get-url github >/dev/null 2>&1; then
  git -C "$cache" remote set-url github "$github_url"
else
  git -C "$cache" remote add github "$github_url"
fi
git -C "$cache" config --unset-all remote.github.pushurl || :
git -C "$cache" config --unset-all remote.github.mirror || :
git -C "$cache" config remote.github.mirror false

# Remove old snapshots so GitHub deletions cannot leave stale observations.
git -C "$cache" for-each-ref --format='delete %(refname)' refs/github-seen/ |
  git -C "$cache" update-ref --stdin
git -C "$cache" fetch --no-tags github \
  '+refs/heads/*:refs/github-seen/heads/*' \
  '+refs/tags/*:refs/github-seen/tags/*' >"$tmp/git-output" 2>&1 ||
  die "GitHub snapshot fetch failed; diagnostics withheld."

git -C "$cache" for-each-ref --format='%(refname) %(objectname)' \
  refs/heads/ refs/tags/ >"$tmp/origin"
git -C "$cache" for-each-ref --format='%(refname) %(objectname)' \
  refs/github-seen/ >"$tmp/github"

python3 - "$cache" "$tmp" "$accept" <<'PY'
import os, subprocess, sys
cache, tmp, accept = sys.argv[1:]
def read(name):
    result = {}
    with open(os.path.join(tmp, name)) as f:
        for line in f:
            ref, sha = line.split()
            result[ref] = sha
    return result
origin = read("origin")
seen = {r.replace("refs/github-seen/", "refs/", 1): s
        for r, s in read("github").items()}
drift = []
for ref, old in seen.items():
    new = origin.get(ref)
    if new is None:
        drift.append((ref, old, "-", "GitHub-only"))
    elif old != new:
        rc = subprocess.run(
            ["git", "-C", cache, "merge-base", "--is-ancestor", old, new],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode
        if rc != 0:
            drift.append((ref, old, new, "not ancestor-or-equal"))
for ref, old, new, reason in drift:
    print("DRIFT", ref, old, "->", new, reason)
if drift and accept != "yes":
    sys.exit(3)
with open(os.path.join(tmp, "leases"), "w") as leases:
    for ref in sorted(origin.keys() | seen.keys()):
        old, new = seen.get(ref, ""), origin.get(ref, "")
        leases.write("--force-with-lease=" + ref + ":" + old + "\n")
        if old != new:
            print("PLAN", ref, old or "-", "->", new or "-")
with open(os.path.join(tmp, "summary"), "w") as f:
    changed = sum(origin.get(r) != seen.get(r) for r in origin.keys() | seen.keys())
    f.write("changed=" + str(changed) + " origin_refs=" + str(len(origin)) +
            " github_refs=" + str(len(seen)))
PY

leases=()
while IFS= read -r lease; do
  leases+=("$lease")
done <"$tmp/leases"
[ "${#leases[@]}" -gt 0 ] || die "No refs to mirror."

check_lock
push_options=(--atomic --prune)
[ "$dry" = no ] || push_options+=(--dry-run)
if git -C "$cache" push "${push_options[@]}" "${leases[@]}" github \
  'refs/heads/*:refs/heads/*' 'refs/tags/*:refs/tags/*' \
  >"$tmp/git-output" 2>&1; then
  result=success
else
  result=failed
fi

mkdir -p "$root/ops/log"
printf '%s mirror dry_run=%s result=%s %s\n' \
  "$(stamp)" "$dry" "$result" "$(cat "$tmp/summary")" >>"$root/ops/log/mirror.log"
[ "$result" = success ] ||
  die "Push rejected or failed; no automatic retry. Diagnostics withheld."
printf 'Mirror completed: %s dry_run=%s\n' "$(stamp)" "$dry"

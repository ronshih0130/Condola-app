#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

usage() {
  cat <<'EOF'
Usage: scripts/make-staging-bundle.sh --recipient age1... [--out DIR]
Box-only staging bundle builder. Requires Linux, python3, age, and sha256sum.
Sources:
  /home/box/.secrets/condola_staging.env
  Optional colon-separated paths in CONDOLA_STAGING_EXTRA_ENV
Allowlist: ops/staging-bundle.allowlist
Records are literal NAME=value; shell syntax is never evaluated.
EOF
}
die() { printf 'make-staging-bundle: %s\n' "$*" >&2; exit 1; }
stamp() { TZ=America/Los_Angeles date '+%Y-%m-%dT%H:%M:%S%z PT (America/Los_Angeles)'; }

recipient=
out=/workspace/ops/handoff/out
while [ "$#" -gt 0 ]; do
  case "$1" in
    --recipient) [ "$#" -ge 2 ] || die "Missing recipient."; recipient=$2; shift 2 ;;
    --out) [ "$#" -ge 2 ] || die "Missing output directory."; out=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
[ "$(uname -s)" = Linux ] || die "Box-only: Linux required."
case "$recipient" in age1?*) ;; *) die "An age public recipient is required." ;; esac
for tool in age python3 sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || die "Missing tool: $tool"
done
root=$(git rev-parse --show-toplevel) || die "Run inside the repository."
allowlist="$root/ops/staging-bundle.allowlist"
if [ ! -e "$allowlist" ]; then
  mkdir -p "$root/ops"
  (
    set -o noclobber
    cat >"$allowlist" <<'EOF'
# TODO: Review and add explicit STAGING variable names, one per line.
# No values, wildcards, production credentials, or ID_DOC_* keys.
# Example names are intentionally not enabled.
EOF
  )
  die "Created TODO template ops/staging-bundle.allowlist; review it and rerun."
fi
[ -f "$allowlist" ] || die "Allowlist must be a regular file."
[ ! -L "$out" ] || die "Output directory must not be a symlink."
mkdir -p "$out"
chmod 700 "$out"
final="$out/condola-staging-$(date +%Y%m%d).env.age"
[ ! -e "$final" ] || die "Today's bundle exists; archive it explicitly before re-issuing."
tmp=$(mktemp -d "$out/.bundle.XXXXXX")
chmod 700 "$tmp"
trap 'rm -rf "$tmp"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Validation finishes before any plaintext is emitted. Only ciphertext is stored.
python3 - "$allowlist" <<'PY' |
import os, re, sys

def fail(message):
    print("make-staging-bundle: " + message, file=sys.stderr)
    sys.exit(1)

pattern = re.compile(r"[A-Z][A-Z0-9_]*")
deny = {
    "SUPABASE_SERVICE_ROLE_KEY_PROD", "ID_DOC_ENCRYPTION_KEY",
    "ID_DOC_HMAC_KEY", "ID_DOC_SIGNING_SECRET", "CLOUDFLARE_API_TOKEN_PROD"
}
def forbidden(name):
    return "PROD" in name or name in deny or name.startswith("ID_DOC_")

allowed = set()
try:
    with open(sys.argv[1], encoding="utf-8") as f:
        for line in f:
            name = line.strip()
            if not name or name.startswith("#"):
                continue
            if not pattern.fullmatch(name):
                fail("Invalid allowlist entry; contents withheld.")
            if forbidden(name):
                fail("Forbidden allowlist variable: " + name)
            allowed.add(name)
except (OSError, UnicodeError):
    fail("Cannot read allowlist; details withheld.")
if not allowed:
    fail("Allowlist is empty; complete the TODO template.")

paths = ["/home/box/.secrets/condola_staging.env"]
extra = os.environ.get("CONDOLA_STAGING_EXTRA_ENV", "")
if extra:
    paths.extend(extra.split(":"))
if any(not p or not os.path.isabs(p) for p in paths):
    fail("Extra sources must be nonempty absolute paths.")

prod_ref = os.environ.get("CONDOLA_PROD_PROJECT_REF", "")
if not prod_ref:
    fail("CONDOLA_PROD_PROJECT_REF is required for production-value screening.")

values = {}
skipped = set()
for path in paths:
    try:
        with open(path, encoding="utf-8", newline="") as f:
            text = f.read()
    except (OSError, UnicodeError):
        fail("Cannot read a source env file; path and details withheld.")
    for line in text.split("\n"):
        if not line or line.startswith("#"):
            continue
        name, sep, value = line.partition("=")
        if not sep or not pattern.fullmatch(name):
            fail("Invalid source NAME=value record; contents withheld.")
        if forbidden(name):
            fail("Forbidden source variable: " + name)
        if "condola-prod" in value or prod_ref in value:
            fail("Production-looking value for " + name)
        if "\x00" in value or "\r" in value:
            fail("Invalid value for " + name)
        if name not in allowed:
            skipped.add(name)
            continue
        if name in values:
            fail("Duplicate included variable: " + name)
        values[name] = value

missing = allowed - values.keys()
if missing:
    for name in sorted(missing):
        print("Missing allowlisted variable: " + name, file=sys.stderr)
    fail("Required allowlisted variables are missing.")
for name in sorted(skipped):
    print("SKIPPED " + name + ": not allowlisted", file=sys.stderr)
for name in sorted(values):
    print("INCLUDED " + name, file=sys.stderr)
for name in sorted(values):
    sys.stdout.write(name + "=" + values[name] + "\n")
PY
  age -r "$recipient" -o "$tmp/bundle.age" 2>/dev/null ||
  die "Bundle validation or encryption failed; no final bundle written."

# Hard-link publication refuses an intervening file and stays on one filesystem.
ln "$tmp/bundle.age" "$final" || die "Could not publish bundle without overwriting."
chmod 600 "$final"
printf 'Bundle created: %s\n' "$(stamp)"
sha256sum "$final"

#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

usage() {
  cat <<'EOF'
Usage:
  secrets-run.sh staging -- <cmd> [args...]
  secrets-run.sh staging --list
Decrypt staging credentials into memory and execute a command.
--list validates the bundle and prints variable names only.
Requires age and python3. No shell evaluation of bundle contents.
EOF
}
die() { printf 'secrets-run: %s\n' "$*" >&2; exit 1; }
stamp() { TZ=America/Los_Angeles date '+%Y-%m-%dT%H:%M:%S%z PT (America/Los_Angeles)'; }

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  '') usage >&2; exit 2 ;;
  staging) shift ;;
  *) die "Mode B is staging-only; production credentials are never stored on the Mac" ;;
esac
list=no
case "${1:-}" in
  --list) [ "$#" -eq 1 ] || die "Unexpected arguments."; list=yes ;;
  --) shift; [ "$#" -gt 0 ] || die "Command required." ;;
  *) usage >&2; exit 2 ;;
esac
command -v age >/dev/null 2>&1 || die "age is required."
command -v python3 >/dev/null 2>&1 || die "python3 is required."

bundle=${CONDOLA_STAGING_BUNDLE:-}
if [ -z "$bundle" ]; then
  bundle=$(python3 - "${HOME:?HOME is required}/.config/condola/bundles" <<'PY'
import glob, os, sys
paths = [p for p in glob.glob(os.path.join(sys.argv[1], "condola-staging-*.env.age"))
         if os.path.isfile(p)]
if paths:
    print(max(paths, key=lambda p: (os.path.getmtime(p), p)))
PY
  )
fi
[ -n "$bundle" ] && [ -f "$bundle" ] || die "No staging bundle found."

identities=()
if [ -n "${CONDOLA_AGE_IDENTITY:-}" ]; then
  [ -f "$CONDOLA_AGE_IDENTITY" ] || die "CONDOLA_AGE_IDENTITY is not a file."
  identities+=(-i "$CONDOLA_AGE_IDENTITY")
else
  for identity in "${HOME:?}/.config/condola/age/"*.key; do
    [ -f "$identity" ] || continue
    identities+=(-i "$identity")
  done
fi
[ "${#identities[@]}" -gt 0 ] || die "No age identity found."

# Decided 2026-10-27 (Ron): plain age key file, chmod 600, under ~/.config/condola/, outside any repo.
check_identity() {
  local f=$1 mode dir
  mode=$(stat -c %a "$f" 2>/dev/null || stat -f %Lp "$f" 2>/dev/null) || die "Cannot stat identity."
  [ "$mode" = 600 ] || die "Identity must be chmod 600: $f"
  dir=$(cd "$(dirname "$f")" && pwd -P)
  if git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    die "Identity must live outside any git checkout: $f"
  fi
}
i=0
while [ "$i" -lt "${#identities[@]}" ]; do
  [ "${identities[$i]}" = -i ] && check_identity "${identities[$((i + 1))]}"
  i=$((i + 1))
done

python3 - "$bundle" <<'PY'
import datetime, os, re, sys
name = os.path.basename(sys.argv[1])
m = re.fullmatch(r"condola-staging-(\d{8})\.env\.age", name)
if not m:
    print("secrets-run: WARNING: bundle filename has no valid YYYYMMDD date.", file=sys.stderr)
else:
    try:
        issued = datetime.datetime.strptime(m[1], "%Y%m%d").date()
        today = datetime.datetime.now(datetime.timezone.utc).date()
        days = (today - issued).days
        if days > 30:
            print("secrets-run: WARNING: bundle older than 30 days; request re-issue.", file=sys.stderr)
        elif days < 0:
            print("secrets-run: WARNING: bundle date is in the future.", file=sys.stderr)
    except ValueError:
        print("secrets-run: WARNING: invalid bundle date.", file=sys.stderr)
PY

# Sentinel preserves trailing newlines and makes command-substitution failure explicit.
plaintext=$(
  age -d "${identities[@]}" "$bundle" 2>/dev/null || exit 1
  printf '\001'
) || die "Decryption failed; no plaintext diagnostics emitted."
plaintext=${plaintext%$'\001'}

# Python receives plaintext through a pipe, never through argv or a temporary file.
# Parsing is literal NAME=value; quotes and backslashes are not interpreted.
printf '%s' "$plaintext" |
  python3 -c '
import os, re, sys
def fail(message):
    print("secrets-run: " + message, file=sys.stderr)
    sys.exit(1)
deny = {
    "SUPABASE_SERVICE_ROLE_KEY_PROD", "ID_DOC_ENCRYPTION_KEY",
    "ID_DOC_HMAC_KEY", "ID_DOC_SIGNING_SECRET", "CLOUDFLARE_API_TOKEN_PROD"
}
try:
    text = sys.stdin.buffer.read().decode("utf-8")
except UnicodeError:
    fail("Bundle must be UTF-8.")
values = {}
for line in text.split("\n"):
    if not line or line.startswith("#"):
        continue
    name, sep, value = line.partition("=")
    if not sep or not re.fullmatch(r"[A-Z][A-Z0-9_]*", name):
        fail("Invalid NAME=value record; contents withheld.")
    if "PROD" in name or name in deny or name.startswith("ID_DOC_"):
        fail("Forbidden variable name: " + name)
    if "condola-prod" in value or "\x00" in value or "\r" in value:
        fail("Forbidden or invalid value for " + name)
    if name in values:
        fail("Duplicate variable name: " + name)
    values[name] = value
if not values:
    fail("Bundle contains no variables.")
if sys.argv[1] == "yes":
    print("\n".join(sorted(values)))
else:
    env = os.environ.copy()
    env.update(values)
    try:
        os.execvpe(sys.argv[2], sys.argv[2:], env)
    except OSError:
        fail("Command execution failed; arguments withheld.")
' "$list" "$@"

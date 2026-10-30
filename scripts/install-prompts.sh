#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

usage() {
  cat <<'EOF'
Usage: scripts/install-prompts.sh [--check]
Generate tracked Codex and Claude skills from ops/roles/*.md.
--check compares complete expected files without changing anything.
Commit generated skills together with their role sources.
EOF
}
die() { printf 'install-prompts: %s\n' "$*" >&2; exit 1; }
stamp() { TZ=America/Los_Angeles date '+%Y-%m-%dT%H:%M:%S%z PT (America/Los_Angeles)'; }
ask() {
  local answer
  [ -t 0 ] || return 1
  printf '%s [y/N] ' "$1" >&2
  read -r answer || return 1
  case "$answer" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}
hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

check=no
case "${1:-}" in
  '') [ "$#" -eq 0 ] || die "Unexpected arguments." ;;
  --check) [ "$#" -eq 1 ] || die "Unexpected arguments."; check=yes ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

root=$(git rev-parse --show-toplevel) || die "Run inside the checkout."
cd "$root"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/condola-skills.XXXXXX")
pending=
cleanup() {
  [ -z "$pending" ] || rm -f "$pending"
  rm -rf "$tmp"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for role in pe qa ceo rd start handoff; do
  source_path="ops/roles/$role.md"
  [ -f "$source_path" ] || die "Missing source: $source_path"
  digest=$(hash_file "$source_path")
  {
    printf '%s\n' '---'
    printf 'name: condola-%s\n' "$role"
    printf 'description: "Explicit Condola %s role workflow from ops/roles/%s.md."\n' "$role" "$role"
    printf '%s\n\n' '---'
    printf '<!-- Generated from %s; source-sha256: %s; do not edit; edit ops/roles. -->\n' \
      "$source_path" "$digest"
    cat "$source_path"
  } >"$tmp/$role.md"
done
printf 'policy:\n  allow_implicit_invocation: false\n' >"$tmp/openai.yaml"

failed=0
install_one() {
  local expected destination directory
  expected=$1
  destination=$2
  if [ "$check" = yes ]; then
    if [ -f "$destination" ] && cmp -s "$expected" "$destination"; then
      printf 'MATCH %s\n' "$destination"
    else
      printf 'DRIFT_OR_MISSING %s\n' "$destination" >&2
      failed=1
    fi
    return
  fi
  directory=$(dirname "$destination")
  mkdir -p "$directory"
  [ ! -L "$destination" ] || die "Refusing destination symlink: $destination"
  if [ ! -f "$destination" ] || ! cmp -s "$expected" "$destination"; then
    pending=$(mktemp "$directory/.condola-skill.XXXXXX")
    cat "$expected" >"$pending"
    mv "$pending" "$destination"
    pending=
  fi
}

for role in pe qa ceo rd start handoff; do
  install_one "$tmp/$role.md" ".agents/skills/$role/SKILL.md"
  install_one "$tmp/openai.yaml" ".agents/skills/$role/agents/openai.yaml"
  install_one "$tmp/$role.md" ".claude/skills/$role/SKILL.md"
done

if [ "$check" = no ]; then
  for role in pe qa ceo rd start handoff; do
    legacy="${HOME:?HOME is required}/.codex/prompts/$role.md"
    [ -f "$legacy" ] && [ ! -L "$legacy" ] || continue
    first=
    IFS= read -r first <"$legacy" || :
    case "$first" in
      "<!-- Generated from ops/roles/$role.md; source-sha256: "*" ;"*) ;;
    esac
    if printf '%s\n' "$first" |
      LC_ALL=C grep -Eq "^<!-- Generated from ops/roles/$role[.]md; source-sha256: [0-9a-f]{64}; edit source and reinstall[.] -->$"; then
      if ask "Remove legacy generated prompt $legacy?"; then
        rm "$legacy"
      else
        printf 'Legacy prompt retained: %s\n' "$legacy"
      fi
    fi
  done
fi

printf '%s\n' \
  "Skill processing finished: $(stamp)" \
  'Commit .agents/skills/ and .claude/skills/ with the ops/roles change.'
exit "$failed"

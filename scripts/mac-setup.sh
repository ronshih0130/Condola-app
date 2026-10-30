#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

usage() {
  cat <<'EOF'
Usage: bash scripts/mac-setup.sh
Provision Ron's Mac and ~/code/condola-app.
No Codex or Claude CLI required. No automatic lock acquisition or push.
Optional installations, key generation, and smoke checks require agreement.
EOF
}
die() { printf 'mac-setup: %s\n' "$*" >&2; exit 1; }
stamp() { TZ=America/Los_Angeles date '+%Y-%m-%dT%H:%M:%S%z PT (America/Los_Angeles)'; }
ask() {
  local answer
  if [ ! -t 0 ]; then
    printf '%s [y/N] noninteractive: no\n' "$1" >&2
    return 1
  fi
  printf '%s [y/N] ' "$1" >&2
  read -r answer || return 1
  case "$answer" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}
fallback() {
  cat >&2 <<'EOF'
FALLBACK: Origin access is unavailable; setup stopped.
Authenticate to the private GitHub mirror using gh auth login or the macOS
keychain, then clone the mirror into a separate checkout.
Read and push only mac/<lane> branches there. Ask the Mode A box owner to
review and port those branches into Origin.
Fallback cannot take the repository lock or establish Mode B ownership.
Mirror URL: https://github.com/ronshih0130/condola-app.git (private; decided
by Ron 2026-10-27). CONDOLA_GITHUB_MIRROR_URL overrides it.
EOF
  exit 1
}

case "${1:-}" in
  '') [ "$#" -eq 0 ] || die "Unexpected arguments." ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac
[ "$(uname -s)" = Darwin ] || die "macOS only."
[ -n "${HOME:-}" ] || die "HOME is required."
printf 'Setup started: %s\n' "$(stamp)"

if [ ! -d /Applications/Codex.app ] && [ ! -d /Applications/ChatGPT.app ]; then
  printf 'WARNING: Codex/ChatGPT app not found in /Applications.\n' >&2
fi
[ -d /Applications/Claude.app ] ||
  printf 'WARNING: Claude app not found in /Applications.\n' >&2
printf 'TODO: Confirm exact Codex/ChatGPT and Claude application bundle names.\n'

command -v brew >/dev/null 2>&1 || die "Install Homebrew, then rerun."
repo="$HOME/code/condola-app"
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
pins="$script_dir/../ops/toolchain.json"
[ ! -f "$repo/ops/toolchain.json" ] || pins="$repo/ops/toolchain.json"

# Bootstrap Node permits JSON parsing without requiring Python on macOS.
if ! brew list --versions node@20 >/dev/null 2>&1 &&
   ! command -v node >/dev/null 2>&1; then
  ask "Install Homebrew formula node@20 to read toolchain pins?" ||
    die "Node is required."
  brew install node@20
fi
if brew list --versions node@20 >/dev/null 2>&1; then
  export PATH="$(brew --prefix node@20)/bin:$PATH"
fi
node_major=20
if [ -f "$pins" ]; then
  node_major=$(node - "$pins" <<'NODE'
const fs = require("fs");
try {
  const p = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const value = p.node ?? p.versions?.node ?? p.toolchain?.node;
  const raw = typeof value === "object" && value ? value.version : value;
  const match = String(raw ?? "").match(/^(?:node@|v)?(\d+)(?:\.\d+){0,2}$/);
  if (!match) throw new Error();
  process.stdout.write(match[1]);
} catch {
  console.error("mac-setup: Unsupported or missing Node pin in ops/toolchain.json.");
  process.exit(1);
}
NODE
  ) || die "Review the Node pin schema before continuing."
fi

for formula in git "node@$node_major" postgresql@16 age; do
  if ! brew list --versions "$formula" >/dev/null 2>&1; then
    ask "Install Homebrew formula $formula?" || die "Required formula missing: $formula"
    brew install "$formula"
  fi
  export PATH="$(brew --prefix "$formula")/bin:$PATH"
done
[ "$(node -p 'process.versions.node.split(".")[0]')" = "$node_major" ] ||
  die "Pinned Node major must be first on PATH."


export PATH="$HOME/.local/bin:$PATH"
if ! command -v origin >/dev/null 2>&1; then
  printf '%s\n' 'Official install command:' \
    'curl -fsSL https://downloads.cursor.com/origin/install.sh | sh'
  ask "Run the official Origin installer?" || fallback
  curl -fsSL https://downloads.cursor.com/origin/install.sh | sh
fi
printf '%s\n' 'For future zsh shells, add to ~/.zshrc:' \
  'export PATH="$HOME/.local/bin:$PATH"'
command -v origin >/dev/null 2>&1 || fallback
if ! origin auth status >/dev/null 2>&1; then
  printf 'Run origin auth login in Terminal for browser sign-in, then rerun.\n' >&2
  fallback
fi
origin_url=https://origin.cursor.com/ron-shih/condola-app.git
git ls-remote "$origin_url" HEAD >/dev/null 2>&1 || fallback

mkdir -p "$HOME/code"
if [ ! -e "$repo" ]; then
  git clone --origin origin "$origin_url" "$repo"
fi
cd "$repo"
[ "$(git rev-parse --show-toplevel)" = "$(pwd -P)" ] ||
  die "Expected a standalone checkout."
[ "$(git remote get-url origin)" = "$origin_url" ] ||
  die "Existing origin differs; review manually. URL withheld."
git fetch --prune origin
if [ -z "$(git status --porcelain --untracked-files=all)" ]; then
  if [ "$(git symbolic-ref --quiet --short HEAD || :)" = main ] &&
     git merge-base --is-ancestor HEAD origin/main; then
    git merge --ff-only origin/main
  else
    printf 'Checkout preserved: update the selected branch manually after review.\n'
  fi
else
  printf 'Dirty checkout preserved; no merge attempted.\n'
fi

mirror_url=${CONDOLA_GITHUB_MIRROR_URL:-https://github.com/ronshih0130/condola-app.git}
case "$mirror_url" in
  https://github.com/*)
    case "$mirror_url" in *'@'*|*'?'*|*'#'*) die "Use a credential-free mirror URL." ;; esac ;;
  git@github.com:*) ;;
  *) die "Use a credential-free GitHub HTTPS or SSH mirror URL." ;;
esac
if git remote get-url github >/dev/null 2>&1; then
  [ "$(git remote get-url github)" = "$mirror_url" ] ||
    die "Existing github URL differs; review manually."
else
  git remote add github "$mirror_url"
fi
git config --unset-all remote.github.pushurl || :
git config --add remote.github.pushurl no_push
printf 'GitHub remote (ronshih0130/condola-app) is fetch-only here; only the lock holder mirrors.\n'

key_dir="$HOME/.config/condola/age"
mkdir -p "$key_dir"
chmod 700 "$key_dir"
has_key=no
for identity in "$key_dir"/*.key; do
  [ -f "$identity" ] || continue
  chmod 600 "$identity"
  has_key=yes
done
if [ "$has_key" = no ] && ask "Generate a new staging age identity on this Mac?"; then
  # Decided 2026-10-27: plain age key file, no Touch ID / Secure Enclave.
  identity="$key_dir/mac.key"
  age-keygen -o "$identity" >/dev/null 2>&1 ||
    die "age key generation failed; inspect locally."
  chmod 600 "$identity"
fi
for identity in "$key_dir"/*.key; do
  [ -f "$identity" ] || continue
  recipient=$(age-keygen -y "$identity" 2>/dev/null) ||
    die "Cannot derive public recipient; inspect identity locally."
  printf 'Public recipient: %s\n' "$recipient"
done
printf 'Send only the public recipient line to the box; never send identity contents.\n'
cat <<'EOF'
Key backup (do once): copy ~/.config/condola/age/mac.key to ONE offline encrypted
medium you control (APFS-encrypted USB drive or encrypted .dmg). Never iCloud/Drive,
chat, email or any repo. Lost/exposed key: generate a new one, send the new public
line, and the box re-issues the staging bundle.
EOF

bash scripts/install-prompts.sh --check || bash scripts/install-prompts.sh
cat <<'EOF'
Next steps:
1. Complete the switch-A-to-B checklist and confirm Mode A released the lock.
2. Start a logged session; retain CONDOLA_SESSION_ID in the supervising shell.
3. Set the claim prerequisites from claim.sh usage, then run:
   scripts/claim.sh acquire repo B Ron
4. Download the staging bundle and verify its SHA-256 before use.
5. Codex app: Projects + Local → choose ~/code/condola-app.
6. Claude desktop: Code tab → Local → Open folder → ~/code/condola-app.
Commit generated skills together with their role sources.
Keep the Homebrew Node and PostgreSQL bin directories on your future shell PATH.
EOF

if ask 'Run scripts/gate.sh --skip-rls "mac setup smoke" now?'; then
  [ -z "$(git status --porcelain --untracked-files=all)" ] ||
    die "Smoke requires a clean checkout; review generated changes first."
  bash scripts/gate.sh --skip-rls "mac setup smoke"
fi
printf 'Setup finished: %s\n' "$(stamp)"

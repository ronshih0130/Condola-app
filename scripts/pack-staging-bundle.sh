#!/usr/bin/env bash
# Pack a staging OpenNext build that wrangler can deploy as-is.
# wrangler main is custom-worker.mjs, which imports ./.open-next/worker.js
# and exports scheduled(). Both files have to sit in those paths inside the tarball.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_ROOT="${SOURCE_ROOT:-$ROOT}"
OUT="${1:-$ROOT/condola-staging-open-next.tar.gz}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

if [[ ! -f "$SOURCE_ROOT/custom-worker.mjs" ]]; then
  echo "missing custom-worker.mjs under $SOURCE_ROOT" >&2
  exit 1
fi
if [[ ! -f "$SOURCE_ROOT/id-purge-cron.mjs" ]]; then
  echo "missing id-purge-cron.mjs under $SOURCE_ROOT" >&2
  exit 1
fi
if [[ ! -f "$SOURCE_ROOT/.open-next/worker.js" ]]; then
  echo "missing .open-next/worker.js under $SOURCE_ROOT" >&2
  exit 1
fi
if ! grep -q "scheduled" "$SOURCE_ROOT/custom-worker.mjs"; then
  echo "custom-worker.mjs has no scheduled handler" >&2
  exit 1
fi
if ! grep -q "id-purge-cron.mjs" "$SOURCE_ROOT/custom-worker.mjs"; then
  echo "custom-worker.mjs does not run the ID purge" >&2
  exit 1
fi
if ! grep -q "purge_due_identity_documents" "$SOURCE_ROOT/id-purge-cron.mjs"; then
  echo "id-purge-cron.mjs does not call purge_due_identity_documents" >&2
  exit 1
fi
if ! grep -q "SET LOCAL ROLE service_role" "$SOURCE_ROOT/id-purge-cron.mjs"; then
  echo "id-purge-cron.mjs does not use service_role" >&2
  exit 1
fi
if grep -q "SET LOCAL ROLE anon" "$SOURCE_ROOT/id-purge-cron.mjs"; then
  echo "id-purge-cron.mjs must not use anon" >&2
  exit 1
fi
if ! grep -q "cron/reminders" "$SOURCE_ROOT/custom-worker.mjs"; then
  echo "custom-worker.mjs does not call the reminder route" >&2
  exit 1
fi

# Bundle pg into the worker entry so a deploy of this tarball does not need node_modules.
# .open-next/worker.js stays external and is packed beside it.
if [[ ! -e "$SOURCE_ROOT/node_modules/pg" ]]; then
  ln -s "$ROOT/node_modules" "$SOURCE_ROOT/node_modules"
fi
npx esbuild "$SOURCE_ROOT/custom-worker.mjs" \
  --bundle \
  --platform=node \
  --format=esm \
  --external:./.open-next/worker.js \
  --outfile="$STAGE/custom-worker.mjs"
cp "$SOURCE_ROOT/id-purge-cron.mjs" "$STAGE/id-purge-cron.mjs"
cp -a "$SOURCE_ROOT/.open-next/." "$STAGE/.open-next/"
cp "$SOURCE_ROOT/wrangler.jsonc" "$STAGE/wrangler.jsonc"
cp "$SOURCE_ROOT/package.json" "$STAGE/package.json"
if [[ -f "$SOURCE_ROOT/COMMIT" ]]; then
  cp "$SOURCE_ROOT/COMMIT" "$STAGE/COMMIT"
else
  git -C "$ROOT" log -1 --format='%H%n%s' > "$STAGE/COMMIT"
fi

mkdir -p "$(dirname "$OUT")"
tar -C "$STAGE" -czf "$OUT" .
members="$(mktemp)"
tar -tzf "$OUT" > "$members"
grep -qx './custom-worker.mjs' "$members"
grep -qx './id-purge-cron.mjs' "$members"
grep -qx './.open-next/worker.js' "$members"
rm -f "$members"
entry="$(tar -xOf "$OUT" ./custom-worker.mjs)"
printf '%s\n' "$entry" | grep -q 'scheduled'
printf '%s\n' "$entry" | grep -q 'purge_due_identity_documents'
printf '%s\n' "$entry" | grep -q 'SET LOCAL ROLE service_role'
printf '%s\n' "$entry" | grep -q 'open-next/worker.js'
printf '%s\n' "$entry" | grep -q 'cron/reminders'
echo "$OUT"

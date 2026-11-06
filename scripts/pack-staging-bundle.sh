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
if [[ ! -f "$SOURCE_ROOT/.open-next/worker.js" ]]; then
  echo "missing .open-next/worker.js under $SOURCE_ROOT" >&2
  exit 1
fi
if ! grep -q "scheduled" "$SOURCE_ROOT/custom-worker.mjs"; then
  echo "custom-worker.mjs has no scheduled handler" >&2
  exit 1
fi
if ! grep -q 'from "./.open-next/worker.js"' "$SOURCE_ROOT/custom-worker.mjs"; then
  echo "custom-worker.mjs must import ./.open-next/worker.js" >&2
  exit 1
fi
if grep -q 'from "pg"\|id-purge-cron\|require("events")' "$SOURCE_ROOT/custom-worker.mjs"; then
  echo "custom-worker.mjs must not bundle pg" >&2
  exit 1
fi
if ! grep -q "cron/purge-id-documents" "$SOURCE_ROOT/custom-worker.mjs"; then
  echo "custom-worker.mjs does not call the purge route" >&2
  exit 1
fi
if ! grep -q "cron/reminders" "$SOURCE_ROOT/custom-worker.mjs"; then
  echo "custom-worker.mjs does not call the reminder route" >&2
  exit 1
fi
if ! grep -q "globalThis.__CONDOLA_FONTS" "$SOURCE_ROOT/custom-worker.mjs"; then
  echo "custom-worker.mjs does not publish the watermark fonts" >&2
  exit 1
fi

# Copy the thin entry. Bundling pg here makes wrangler reject the upload
# (error 10021, dynamic require of "events").
cp "$SOURCE_ROOT/custom-worker.mjs" "$STAGE/custom-worker.mjs"
bytes="$(wc -c < "$STAGE/custom-worker.mjs" | tr -d ' ')"
if [[ "$bytes" -gt 4096 ]]; then
  echo "custom-worker.mjs is ${bytes} bytes; the packed entry must stay small" >&2
  exit 1
fi
cp -a "$SOURCE_ROOT/.open-next/." "$STAGE/.open-next/"
# The entry imports these as Wrangler Data modules. They are not inside the OpenNext handler.
for font in public/fonts/DroidSansFallback-subset.ttf src/server/fonts/DejaVuSans.ttf; do
  if [[ ! -f "$SOURCE_ROOT/$font" ]]; then
    echo "missing $font under $SOURCE_ROOT" >&2
    exit 1
  fi
  mkdir -p "$STAGE/$(dirname "$font")"
  cp "$SOURCE_ROOT/$font" "$STAGE/$font"
done
cp "$SOURCE_ROOT/wrangler.jsonc" "$STAGE/wrangler.jsonc"
cp "$SOURCE_ROOT/package.json" "$STAGE/package.json"
if [[ -f "$SOURCE_ROOT/COMMIT" ]]; then
  cp "$SOURCE_ROOT/COMMIT" "$STAGE/COMMIT"
else
  git -C "$ROOT" log -1 --format='%H%n%s' > "$STAGE/COMMIT"
fi
node "$ROOT/scripts/write-pr-migrations.mjs" "$STAGE/pr-migrations"

mkdir -p "$(dirname "$OUT")"
tar -C "$STAGE" -czf "$OUT" .
members="$(mktemp)"
tar -tzf "$OUT" > "$members"
grep -qx './custom-worker.mjs' "$members"
grep -qx './.open-next/worker.js' "$members"
grep -qx './public/fonts/DroidSansFallback-subset.ttf' "$members"
grep -qx './src/server/fonts/DejaVuSans.ttf' "$members"
grep -qx './pr-migrations/MANIFEST.md' "$members"
grep -qx './pr-migrations/PERMISSIONS.md' "$members"
rm -f "$members"
entry="$(tar -xOf "$OUT" ./custom-worker.mjs)"
grep -q 'scheduled' <<< "$entry"
grep -q 'open-next/worker.js' <<< "$entry"
grep -q 'cron/reminders' <<< "$entry"
grep -q 'cron/purge-id-documents' <<< "$entry"
if grep -q 'from "pg"\|purge_due_identity_documents\|require("events")\|id-purge-cron' <<< "$entry"; then
  echo "packed custom-worker.mjs still contains the database driver" >&2
  exit 1
fi
echo "$OUT"

#!/usr/bin/env bash
# Public smoke check.
#   scripts/qa/smoke.sh <base_url> [expected_sha]
# Prints PASS or FAIL for each item and writes JSON (SMOKE_JSON, default scripts/qa/smoke-result.json).
# Banned words go through scripts/check-banned-terms.mjs, which reads config/banned_terms.md.
set -u
cd "$(dirname "$0")/../.."

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "usage: scripts/qa/smoke.sh <base_url> [expected_sha]" >&2
  exit 2
fi

base="${1%/}"
expected="${2:-}"
checker="scripts/check-banned-terms.mjs"
json_path="${SMOKE_JSON:-scripts/qa/smoke-result.json}"
work="$(mktemp -d)"
items="$work/items.jsonl"
trap 'rm -rf "$work"' EXIT
export SMOKE_ITEMS="$items"
: > "$items"

record() {
  local ok="$1" name="$2" detail="$3"
  if [[ "$ok" == "1" ]]; then
    printf 'PASS  %s\n' "$name"
  else
    printf 'FAIL  %s\n' "$name"
  fi
  if [[ -n "$detail" ]]; then
    printf '%s\n' "$detail" | sed 's/^/      /'
  fi
  SMOKE_OK="$ok" SMOKE_NAME="$name" SMOKE_DETAIL="$detail" node --input-type=module -e '
    import { appendFileSync } from "node:fs";
    const item = {
      name: process.env.SMOKE_NAME,
      ok: process.env.SMOKE_OK === "1",
      detail: process.env.SMOKE_DETAIL ?? "",
    };
    appendFileSync(process.env.SMOKE_ITEMS, JSON.stringify(item) + "\n");
  '
}

fetch_code() {
  local path="$1" body="$2" hdr="$3"
  local code
  code="$(curl -sS --max-time 30 -o "$body" -D "$hdr" -w '%{http_code}' "${base}${path}" 2>"$work/curl.err" || true)"
  printf '%s' "$code"
}

status_of() {
  awk 'BEGIN{IGNORECASE=1} /^HTTP\// { code=$2 } END{ print code }' "$1" | tr -d '\r'
}

location_path() {
  awk 'tolower($1)=="location:" { print $2; exit }' "$1" \
    | tr -d '\r' \
    | sed -E 's#^[a-zA-Z][a-zA-Z0-9+.-]*://[^/]+##; s/[?#].*$//'
}

public_paths=("/" "/login" "/signup" "/forgot" "/pricing")
for path in "${public_paths[@]}"; do
  body="$work/body"
  hdr="$work/hdr"
  code="$(fetch_code "$path" "$body" "$hdr")"
  http="$(status_of "$hdr")"
  if [[ "$code" == "200" && "$http" == "200" ]]; then
    record 1 "GET $path" "200"
  else
    record 0 "GET $path" "expected 200, got ${http:-$code}"
  fi
  slug="$(printf '%s' "$path" | tr '/' '_')"
  cp "$body" "$work/page$slug"
done

for path in "/m" "/t"; do
  body="$work/redir-body"
  hdr="$work/redir-hdr"
  code="$(fetch_code "$path" "$body" "$hdr")"
  http="$(status_of "$hdr")"
  loc="$(location_path "$hdr")"
  if [[ "$code" == "307" && "$http" == "307" && "$loc" == "/login" ]]; then
    record 1 "GET $path logged out" "307 Location: /login"
  else
    record 0 "GET $path logged out" "expected 307 Location: /login, got ${http:-$code} Location: ${loc:-<none>}"
  fi
done

missing="/qa-no-such-page"
body="$work/missing-body"
hdr="$work/missing-hdr"
code="$(fetch_code "$missing" "$body" "$hdr")"
http="$(status_of "$hdr")"
if [[ "$code" == "404" && "$http" == "404" ]]; then
  record 1 "GET $missing" "404"
else
  record 0 "GET $missing" "expected 404, got ${http:-$code}"
fi

version_body="$work/version"
version_hdr="$work/version-hdr"
code="$(fetch_code "/api/version" "$version_body" "$version_hdr")"
http="$(status_of "$version_hdr")"
sha="$(node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(String(j.sha??""))}catch{process.stdout.write("")}})' < "$version_body" || true)"
commit="$(node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(String(j.commit??""))}catch{process.stdout.write("")}})' < "$version_body" || true)"
if [[ "$http" != "200" || -z "$sha" ]]; then
  record 0 "GET /api/version" "expected a sha, got HTTP ${http:-$code}"
elif [[ -z "$expected" ]]; then
  record 1 "GET /api/version" "sha=$sha (no expected sha)"
elif [[ "$expected" == "$sha" || "$expected" == "$commit" ]]; then
  record 1 "GET /api/version" "sha=$sha"
else
  record 0 "GET /api/version" "expected $expected, got sha=$sha commit=$commit"
fi

scan_page() {
  local path="$1" src="$2"
  local err="$work/banned-err" out=""
  if out="$(node "$checker" --label "$path" --html "$src" 2>"$err")"; then
    record 1 "banned words $path" "clean"
  else
    local detail
    detail="$(printf '%s\n%s\n' "$out" "$(cat "$err")" | sed '/^$/d')"
    record 0 "banned words $path" "$detail"
  fi
}

for path in "${public_paths[@]}"; do
  slug="$(printf '%s' "$path" | tr '/' '_')"
  scan_page "$path" "$work/page$slug"
done
scan_page "$missing" "$work/missing-body"

mkdir -p "$(dirname "$json_path")"
SMOKE_BASE="$base" SMOKE_EXPECTED="$expected" SMOKE_SHA="${sha:-}" SMOKE_JSON_PATH="$json_path" node --input-type=module -e '
  import { readFileSync, writeFileSync } from "node:fs";
  const items = readFileSync(process.env.SMOKE_ITEMS, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const result = {
    baseUrl: process.env.SMOKE_BASE,
    expectedSha: process.env.SMOKE_EXPECTED || null,
    sha: process.env.SMOKE_SHA || null,
    ok: items.every((item) => item.ok),
    items,
  };
  writeFileSync(process.env.SMOKE_JSON_PATH, JSON.stringify(result, null, 2) + "\n");
'

echo "result $json_path"
if grep -q '"ok":false' "$items"; then
  exit 1
fi
exit 0

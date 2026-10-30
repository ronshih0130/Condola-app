#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

usage() {
  cat <<'EOF'
Usage: gate.sh [--release] [--skip-rls "reason"] [SHA]
SHA defaults to HEAD; HEAD must equal the resolved immutable SHA.
Requires a completely clean checkout, including untracked files.
Runs npm ci, typecheck, lint, test:unit, copy:check, RLS, and flag expiry.
--release also runs build, test:worker, test:e2e and forbids an RLS waiver.

ops/toolchain.json must pin exact versions as {"node":"20.x.y","npm":"x.y.z"};
replace x/y/z with real numeric versions. PostgreSQL must be version 16.
For RLS: DATABASE_URL must target local disposable PostgreSQL 16;
set CONDOLA_RLS_DISPOSABLE=YES. No database credential is printed.
If DATABASE_URL is absent, --skip-rls requires a nonempty reason.
A waiver produces PASS_WITH_RLS_WAIVER, never release readiness.

If ops/flags.yaml exists, a locked yaml or js-yaml dependency is required.
Accepted shape: flags is a mapping or a list of records with name.
Each flag needs owner and expires_at (or expires), quoted as:
  "2026-11-10T18:00:00-08:00 PT (America/Los_Angeles)"
Optional stable_ga_at uses the same format and enforces the 14-day removal.
Unknown/malformed structures fail closed; no parser is installed on the fly.

Summary: e2e/results/gate-<full-sha>.md.
Raw command logs: private directory under the common Git directory.
Inspect/sanitize logs before any publication; the summary contains no raw output.
A successful gate is evidence, not QA sign-off or deployment authorization.
EOF
}
die() { printf 'gate: %s\n' "$*" >&2; exit 1; }
stamp() { TZ=America/Los_Angeles date '+%Y-%m-%dT%H:%M:%S%z PT (America/Los_Angeles)'; }

release=no
skip_reason=
target=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --release) release=yes; shift ;;
    --skip-rls)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      skip_reason=$2
      case "$skip_reason" in ''|*$'\n'*|*$'\r'*|*$'\t'*) die "Supply a single-line RLS waiver reason." ;; esac
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    --*) usage >&2; exit 2 ;;
    *)
      [ -z "$target" ] || { usage >&2; exit 2; }
      target=$1; shift
      ;;
  esac
done

root=$(git rev-parse --show-toplevel) || die "Run inside the repository."
cd "$root"
sha=$(git rev-parse --verify "${target:-HEAD}^{commit}") || die "Invalid candidate SHA."
common=$(git rev-parse --git-common-dir)
case "$common" in /*) ;; *) common="$root/$common" ;; esac
common=$(cd "$common" && pwd -P)
mkdir -p "$common/condola-gate-logs"
logs=$(mktemp -d "$common/condola-gate-logs/$sha.XXXXXX")
table="$logs/steps.md"
printf '| Check | Result | Exit |\n|---|---|---|\n' >"$table"
report="$root/e2e/results/gate-$sha.md"
started=$(stamp)
failed=0
waived=no

record() {
  printf '| %s | %s | %s |\n' "$1" "$2" "$3" >>"$table"
  printf 'gate: %s %s\n' "$1" "$2"
}
finish() {
  exit_status=$?
  trap - EXIT
  if [ "$exit_status" -ne 0 ]; then failed=1; fi
  if [ "$failed" -ne 0 ]; then
    verdict=FAIL
    result_code=1
  elif [ "$waived" = yes ]; then
    verdict=PASS_WITH_RLS_WAIVER
    result_code=0
  else
    verdict=PASS
    result_code=0
  fi
  mkdir -p "$root/e2e/results"
  {
    printf '# Gate %s\n\n' "$sha"
    printf 'Result: %s\n\n' "$verdict"
    printf 'Candidate: `%s`\n\nRelease checks requested: %s\n\n' "$sha" "$release"
    printf 'Started: %s\n\nFinished: %s\n\n' "$started" "$(stamp)"
    cat "$table"
    if [ "$waived" = yes ]; then
      printf '\nRLS waiver: %s\n\nThis smoke result cannot authorize release.\n' "$skip_reason"
    fi
    printf '\nPrivate raw-log directory: `%s`\n' "$logs"
    printf '\nLogs are local and unreviewed; publish only sanitized evidence/manifests.\n'
    printf '\nThis summary does not supply independent QA, Class B conditions, CEO GO, or production monitoring.\n'
  } >"$report"
  printf 'gate: %s; summary=%s\n' "$verdict" "$report"
  exit "$result_code"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

run_step() {
  step=$1
  shift
  if "$@" >"$logs/$step.log" 2>&1; then
    record "$step" PASS 0
    return 0
  else
    step_rc=$?
    record "$step" FAIL "$step_rc"
    failed=1
    return "$step_rc"
  fi
}
reject() {
  record "$1" FAIL 1
  printf 'gate: %s\n' "$2" >&2
  failed=1
  exit 1
}

[ "$(git rev-parse HEAD)" = "$sha" ] ||
  reject pinned-checkout "Check out the candidate SHA before running the gate."
[ -z "$(git status --porcelain --untracked-files=all)" ] ||
  reject clean-checkout "Commit/preserve changes and untracked files before running."
record pinned-clean-checkout PASS 0
if [ "$release" = yes ] && [ -n "$skip_reason" ]; then
  reject release-rls-policy "--release cannot use --skip-rls."
fi
command -v node >/dev/null 2>&1 || reject node "Node.js is required."
command -v npm >/dev/null 2>&1 || reject npm "npm is required."

if ! run_step toolchain node <<'NODE'
const fs = require('fs');
const cp = require('child_process');
try {
  const p = JSON.parse(fs.readFileSync('ops/toolchain.json', 'utf8'));
  const exact = /^\d+\.\d+\.\d+$/;
  if (!exact.test(p.node || '') || !exact.test(p.npm || ''))
    throw new Error('ops/toolchain.json needs exact node and npm version strings');
  if (!p.node.startsWith('20.'))
    throw new Error('The approved setup uses Node 20; reconcile toolchain policy');
  const npm = cp.execFileSync('npm', ['--version'], {encoding: 'utf8'}).trim();
  if (process.versions.node !== p.node || npm !== p.npm)
    throw new Error('Installed Node/npm do not match the committed pins');
  console.log('Exact Node/npm pins match.');
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
NODE
then
  exit 1
fi

if ! run_step npm-ci npm ci; then exit 1; fi
run_step typecheck npm run typecheck || :
run_step lint npm run lint || :
run_step test-unit npm run test:unit || :
run_step copy-check npm run copy:check || :

if [ -n "${DATABASE_URL:-}" ]; then
  if [ "${CONDOLA_RLS_DISPOSABLE:-}" != YES ]; then
    record disposable-database-confirmation FAIL 1
    failed=1
  else
    if run_step postgres-16 node <<'NODE'
(async () => {
  let client;
  try {
    const u = new URL(process.env.DATABASE_URL);
    if (!['postgres:', 'postgresql:'].includes(u.protocol) ||
        !['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname) ||
        !u.pathname || u.pathname === '/')
      throw new Error('Require a named local disposable database');
    for (const key of u.searchParams.keys()) {
      if (/^(host|hostaddr|port|service|dbname)$/i.test(key))
        throw new Error('Connection destination overrides are forbidden');
    }
    const {Client} = require('pg');
    client = new Client({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 5000,
      query_timeout: 5000
    });
    await client.connect();
    const r = await client.query('SHOW server_version_num');
    if (Math.floor(Number(r.rows[0].server_version_num) / 10000) !== 16)
      throw new Error('PostgreSQL 16 required');
    console.log('Local PostgreSQL 16 confirmed.');
  } catch (_) {
    console.error('Local PostgreSQL 16 validation failed; credential details withheld.');
    process.exitCode = 1;
  } finally {
    if (client) await client.end().catch(() => {});
  }
})();
NODE
    then
      run_step test-rls npm run test:rls || :
    else
      record test-rls BLOCKED -
    fi
  fi
elif [ -n "$skip_reason" ]; then
  waived=yes
  record test-rls WAIVED -
else
  record test-rls FAIL 1
  failed=1
  printf 'gate: DATABASE_URL absent; supply a local disposable database or a smoke waiver.\n' >&2
fi

if [ -f ops/flags.yaml ]; then
  run_step flag-expiry node <<'NODE' || :
const fs = require('fs');
function fail(message) { throw new Error(message); }
function ptTime(value, label) {
  if (typeof value !== 'string') fail(`${label}: quoted PT timestamp required`);
  const m = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})([+-]\d{2}:\d{2}) PT \(America\/Los_Angeles\)$/);
  if (!m) fail(`${label}: explicit offset and PT (America/Los_Angeles) required`);
  const epoch = Date.parse(m[1] + 'T' + m[2] + m[3]);
  if (!Number.isFinite(epoch)) fail(`${label}: invalid timestamp`);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(epoch));
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  const local = `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
  if (local !== m[1] + 'T' + m[2]) fail(`${label}: date or Los Angeles offset is wrong`);
  return epoch;
}
try {
  const input = fs.readFileSync('ops/flags.yaml', 'utf8');
  let parse;
  try {
    const yaml = require('yaml');
    parse = text => yaml.parse(text, {uniqueKeys: true, maxAliasCount: 50});
  } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') throw e;
    try {
      const yaml = require('js-yaml');
      parse = text => yaml.load(text, {schema: yaml.JSON_SCHEMA});
    } catch (_) {
      fail('flags.yaml requires yaml or js-yaml in the committed npm dependency graph');
    }
  }
  const doc = parse(input);
  if (!doc || typeof doc !== 'object' || !Object.hasOwn(doc, 'flags'))
    fail('Expected a top-level flags mapping or list');
  let entries;
  if (Array.isArray(doc.flags)) {
    entries = doc.flags.map(x => [x && x.name, x]);
  } else if (doc.flags && typeof doc.flags === 'object') {
    entries = Object.entries(doc.flags);
  } else {
    fail('flags must be a mapping or list');
  }
  const names = new Set();
  const now = Date.now();
  for (const [name, flag] of entries) {
    if (typeof name !== 'string' || !name.trim() || names.has(name))
      fail('Flag names must be nonempty and unique');
    names.add(name);
    if (!flag || typeof flag !== 'object' || Array.isArray(flag) ||
        typeof flag.owner !== 'string' || !flag.owner.trim())
      fail(`${name}: owner required`);
    if (flag.expires_at !== undefined && flag.expires !== undefined)
      fail(`${name}: use only one expiry field`);
    const expires = ptTime(flag.expires_at ?? flag.expires, `${name} expiry`);
    if (expires <= now) fail(`${name}: expired`);
    if (flag.stable_ga_at !== undefined) {
      const ga = ptTime(flag.stable_ga_at, `${name} stable GA`);
      if (ga > now) fail(`${name}: stable GA cannot be in the future`);
      if (now >= ga + 14 * 86400000) fail(`${name}: remove flag after 14 days of stable GA`);
    }
  }
  console.log(`Validated ${entries.length} flag records.`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
NODE
else
  record flag-expiry NOT_PRESENT -
fi

if [ "$release" = yes ]; then
  run_step build npm run build || :
  run_step test-worker npm run test:worker || :
  run_step test-e2e npm run test:e2e || :
fi
if [ "$(git rev-parse HEAD)" != "$sha" ] ||
   [ -n "$(git status --porcelain --untracked-files=all)" ]; then
  record final-pinned-clean-checkout FAIL 1
  failed=1
else
  record final-pinned-clean-checkout PASS 0
fi
# The EXIT handler writes the summary only after checking the worktree.
exit 0

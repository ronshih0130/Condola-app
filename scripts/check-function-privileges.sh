#!/usr/bin/env bash
# Fail when anon can execute any function in schema public, or when
# authenticated can execute a public function that is not listed in
# supabase/rpc-allowlist.txt. The allowlist has one mode, authenticated.
# "@mode any" is rejected because it would allow anon.
#
# CI runs this after npm ci, with the workflow's Postgres service:
#   DATABASE_URL=postgres://condola:condola@127.0.0.1:5432/condola
#   bash scripts/check-function-privileges.sh
# The script refuses any non-local host, creates a scratch database, and
# drops it on exit. It does not use the application database and it does not
# read .env.local.
#
# Hosted Supabase grants EXECUTE on new public functions to anon,
# authenticated, and service_role. The scratch database records that default
# before migrations so has_function_privilege sees the same grants a hosted
# CREATE FUNCTION receives. 20261029120000 then revokes those defaults.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -z "${DATABASE_URL:-}" ]]; then
  DATABASE_URL="postgres://condola:condola@127.0.0.1:5432/condola"
fi
export DATABASE_URL

python3 - <<'PY'
import os, sys
from urllib.parse import urlparse
host = (urlparse(os.environ["DATABASE_URL"]).hostname or "").lower()
if host not in {"localhost", "127.0.0.1", "::1"}:
    sys.stderr.write("Refusing to check function privileges on a non-local database.\n")
    sys.exit(2)
PY

scratch_url="$(python3 - <<'PY'
import os
from urllib.parse import urlparse, urlunparse
url = urlparse(os.environ["DATABASE_URL"])
print(urlunparse(url._replace(path="/condola_fn_priv")))
PY
)"

cleanup() {
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
    "DROP DATABASE IF EXISTS condola_fn_priv WITH (FORCE);" >/dev/null 2>&1 || true
}
trap cleanup EXIT

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
  "DROP DATABASE IF EXISTS condola_fn_priv WITH (FORCE);"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
  "CREATE DATABASE condola_fn_priv;"

psql "$scratch_url" -v ON_ERROR_STOP=1 -q <<'SQL'
DO $body$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
    CREATE ROLE postgres NOLOGIN SUPERUSER;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    CREATE ROLE supabase_admin NOLOGIN SUPERUSER;
  END IF;
END
$body$;
SQL

# One session: stub (creates anon, authenticated, service_role), Supabase-like
# defaults, then every migration as postgres, the role that creates functions
# on the hosted project.
{
  echo "SET client_min_messages TO warning;"
  echo "SET ROLE postgres;"
  echo "\\i supabase/stub/supabase_stub.sql"
  echo "RESET ROLE;"
  cat <<'SQL'
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
SQL
  echo "SET ROLE postgres;"
  for migration in supabase/migrations/*.sql; do
    printf '\\i %s\n' "$migration"
  done
} | psql "$scratch_url" -v ON_ERROR_STOP=1 -q

default_file="supabase/migrations/20261029120000_default_function_privileges.sql"
if [[ -f "$default_file" ]]; then
  psql "$scratch_url" -v ON_ERROR_STOP=1 -q <<'SQL'
SET ROLE postgres;
CREATE FUNCTION public.rpc_default_priv_probe() RETURNS integer
LANGUAGE sql AS $$ SELECT 1 $$;
RESET ROLE;
SET ROLE supabase_admin;
CREATE FUNCTION public.rpc_default_priv_probe_admin() RETURNS integer
LANGUAGE sql AS $$ SELECT 1 $$;
RESET ROLE;
SQL

  probe="$(psql "$scratch_url" -v ON_ERROR_STOP=1 -tA <<'SQL'
SELECT proname || ' anon=' || has_function_privilege('anon', oid, 'EXECUTE')
    || ' authenticated=' || has_function_privilege('authenticated', oid, 'EXECUTE')
    || ' public=' || has_function_privilege('public', oid, 'EXECUTE')
FROM pg_proc
WHERE proname IN ('rpc_default_priv_probe', 'rpc_default_priv_probe_admin')
ORDER BY proname;
SQL
)"
  echo "$probe"

  probe_ok="$(psql "$scratch_url" -v ON_ERROR_STOP=1 -tA <<'SQL'
SELECT bool_and(
  NOT has_function_privilege('anon', oid, 'EXECUTE')
  AND NOT has_function_privilege('authenticated', oid, 'EXECUTE')
  AND NOT has_function_privilege('public', oid, 'EXECUTE')
)
FROM pg_proc
WHERE proname IN ('rpc_default_priv_probe', 'rpc_default_priv_probe_admin');
SQL
)"
  if [[ "$probe_ok" != "t" ]]; then
    echo "A function created after the default-privilege migration is still executable by anon, authenticated, or PUBLIC." >&2
    exit 1
  fi

  psql "$scratch_url" -v ON_ERROR_STOP=1 -q -c \
    "DROP FUNCTION public.rpc_default_priv_probe(); DROP FUNCTION public.rpc_default_priv_probe_admin();"
  echo "default-privilege probe: enforced"
else
  echo "default-privilege probe: skipped (migration not in tree)"
fi

table_state="$(psql "$scratch_url" -v ON_ERROR_STOP=1 -tA <<'SQL'
SELECT CASE
  WHEN to_regclass('public.gotrue_confirm_uses') IS NULL THEN 'missing'
  WHEN EXISTS (
    SELECT 1
    FROM (VALUES ('anon'), ('authenticated'), ('public')) AS r(role)
    CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(perm)
    WHERE has_table_privilege(r.role, 'public.gotrue_confirm_uses', p.perm)
  ) THEN 'granted'
  ELSE 'none'
END;
SQL
)"
echo "gotrue_confirm_uses anon/authenticated/public: ${table_state}"
if [[ -f supabase/migrations/20261029160000_gotrue_confirm_single_use.sql && "$table_state" != "none" ]]; then
  echo "anon, authenticated, or PUBLIC can use public.gotrue_confirm_uses (${table_state})" >&2
  exit 1
fi

# Stand in for PR #18 when those functions are not in this database. Grant
# broadly, re-apply the lock migration, require the intended EXECUTE, then
# drop only the stand-ins so the public scan below stays the real schema.
if [[ -f supabase/migrations/20261029150000_lock_public_function_execute.sql ]]; then
echo "utility function revoke probe"
psql "$scratch_url" -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE TABLE IF NOT EXISTS public.fn_priv_probe_created (sig text PRIMARY KEY);
TRUNCATE public.fn_priv_probe_created;
DO $body$
BEGIN
  IF to_regprocedure('public.post_reversal(uuid, text, uuid)') IS NULL THEN
    EXECUTE $fn$
      CREATE FUNCTION public.post_reversal(p_txn uuid, p_reason text, p_invoice uuid)
      RETURNS uuid LANGUAGE sql AS $sql$ SELECT p_txn $sql$
    $fn$;
    INSERT INTO public.fn_priv_probe_created VALUES ('public.post_reversal(uuid, text, uuid)');
  END IF;
  IF to_regprocedure('public.utility_runs_fill_unit_id()') IS NULL THEN
    EXECUTE $fn$
      CREATE FUNCTION public.utility_runs_fill_unit_id()
      RETURNS trigger LANGUAGE plpgsql AS $sql$ BEGIN RETURN NEW; END $sql$
    $fn$;
    INSERT INTO public.fn_priv_probe_created VALUES ('public.utility_runs_fill_unit_id()');
  END IF;
  IF to_regprocedure('public.utility_runs_reuse_open_period()') IS NULL THEN
    EXECUTE $fn$
      CREATE FUNCTION public.utility_runs_reuse_open_period()
      RETURNS trigger LANGUAGE plpgsql AS $sql$ BEGIN RETURN NEW; END $sql$
    $fn$;
    INSERT INTO public.fn_priv_probe_created VALUES ('public.utility_runs_reuse_open_period()');
  END IF;
  IF to_regprocedure('app.audit_event(uuid, text, jsonb)') IS NULL THEN
    EXECUTE $fn$
      CREATE FUNCTION app.audit_event(p_org uuid, p_event text, p_detail jsonb)
      RETURNS void LANGUAGE plpgsql AS $sql$ BEGIN RETURN; END $sql$
    $fn$;
    INSERT INTO public.fn_priv_probe_created VALUES ('app.audit_event(uuid, text, jsonb)');
  END IF;
END
$body$;
GRANT EXECUTE ON FUNCTION public.post_reversal(uuid, text, uuid) TO PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.utility_runs_fill_unit_id() TO PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.utility_runs_reuse_open_period() TO PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.audit_event(uuid, text, jsonb) TO PUBLIC, anon, authenticated;
SQL
{
  echo "SET client_min_messages TO warning;"
  echo "\\i supabase/migrations/20261029150000_lock_public_function_execute.sql"
} | psql "$scratch_url" -v ON_ERROR_STOP=1 -q

utility_priv="$(psql "$scratch_url" -v ON_ERROR_STOP=1 -tA <<'SQL'
SELECT 'public.post_reversal(uuid, text, uuid)'
    || ' anon=' || has_function_privilege('anon', 'public.post_reversal(uuid, text, uuid)', 'EXECUTE')
    || ' authenticated=' || has_function_privilege('authenticated', 'public.post_reversal(uuid, text, uuid)', 'EXECUTE')
    || ' public=' || has_function_privilege('public', 'public.post_reversal(uuid, text, uuid)', 'EXECUTE')
UNION ALL
SELECT 'public.utility_runs_fill_unit_id()'
    || ' anon=' || has_function_privilege('anon', 'public.utility_runs_fill_unit_id()', 'EXECUTE')
    || ' authenticated=' || has_function_privilege('authenticated', 'public.utility_runs_fill_unit_id()', 'EXECUTE')
    || ' public=' || has_function_privilege('public', 'public.utility_runs_fill_unit_id()', 'EXECUTE')
UNION ALL
SELECT 'public.utility_runs_reuse_open_period()'
    || ' anon=' || has_function_privilege('anon', 'public.utility_runs_reuse_open_period()', 'EXECUTE')
    || ' authenticated=' || has_function_privilege('authenticated', 'public.utility_runs_reuse_open_period()', 'EXECUTE')
    || ' public=' || has_function_privilege('public', 'public.utility_runs_reuse_open_period()', 'EXECUTE')
UNION ALL
SELECT 'app.audit_event(uuid, text, jsonb)'
    || ' anon=' || has_function_privilege('anon', 'app.audit_event(uuid, text, jsonb)', 'EXECUTE')
    || ' authenticated=' || has_function_privilege('authenticated', 'app.audit_event(uuid, text, jsonb)', 'EXECUTE')
    || ' public=' || has_function_privilege('public', 'app.audit_event(uuid, text, jsonb)', 'EXECUTE')
UNION ALL
SELECT 'stand-ins=' || count(*)::text FROM public.fn_priv_probe_created;
SQL
)"
echo "$utility_priv"
utility_ok="$(psql "$scratch_url" -v ON_ERROR_STOP=1 -tA <<'SQL'
SELECT
  NOT has_function_privilege('anon', 'public.post_reversal(uuid, text, uuid)', 'EXECUTE')
  AND NOT has_function_privilege('public', 'public.post_reversal(uuid, text, uuid)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.post_reversal(uuid, text, uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.utility_runs_fill_unit_id()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.utility_runs_fill_unit_id()', 'EXECUTE')
  AND NOT has_function_privilege('public', 'public.utility_runs_fill_unit_id()', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.utility_runs_reuse_open_period()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.utility_runs_reuse_open_period()', 'EXECUTE')
  AND NOT has_function_privilege('public', 'public.utility_runs_reuse_open_period()', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'app.audit_event(uuid, text, jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('public', 'app.audit_event(uuid, text, jsonb)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'app.audit_event(uuid, text, jsonb)', 'EXECUTE');
SQL
)"
if [[ "$utility_ok" != "t" ]]; then
  echo "utility function revoke probe failed" >&2
  exit 1
fi
psql "$scratch_url" -v ON_ERROR_STOP=1 -q <<'SQL'
DO $drop$
DECLARE sig text;
BEGIN
  FOR sig IN SELECT fn_priv_probe_created.sig FROM public.fn_priv_probe_created LOOP
    EXECUTE 'DROP FUNCTION ' || sig;
  END LOOP;
END
$drop$;
DROP TABLE public.fn_priv_probe_created;
SQL
echo "utility function revoke probe: enforced"
else
  echo "utility function revoke probe: skipped (lock migration not in tree)"
fi

psql "$scratch_url" -v ON_ERROR_STOP=1 -tA -F $'\t' <<'SQL' > /tmp/condola-fn-priv.tsv
SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
       has_function_privilege('anon', p.oid, 'EXECUTE'),
       has_function_privilege('authenticated', p.oid, 'EXECUTE')
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prokind = 'f'
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend d
    WHERE d.objid = p.oid
      AND d.classid = 'pg_proc'::regclass
      AND d.deptype = 'e'
  )
ORDER BY 1;
SQL

lock_file="supabase/migrations/20261029150000_lock_public_function_execute.sql"
if [[ -f "$lock_file" ]]; then
  mode="full"
else
  mode="forward"
fi
echo "privilege gate: ${mode}"

python3 - "$mode" supabase/rpc-allowlist.txt /tmp/condola-fn-priv.tsv <<'PY'
import pathlib, sys
mode, allow_path, scan_path = sys.argv[1:]

def norm(signature: str) -> str:
    return "".join(signature.split()).lower()

mode_for = {}
current = "authenticated"
for raw in pathlib.Path(allow_path).read_text().splitlines():
    line = raw.strip()
    if not line or line.startswith("#"):
        if line.startswith("# @mode "):
            current = line.split()[2]
            if current == "any":
                sys.stderr.write("@mode any is rejected: anon must not execute any public function\n")
                sys.exit(1)
            if current != "authenticated":
                sys.stderr.write(f"unknown allowlist mode: {line}\n")
                sys.exit(1)
        continue
    if current != "authenticated":
        sys.stderr.write(f"allowlist entry is not authenticated-only: {line}\n")
        sys.exit(1)
    mode_for[norm(line)] = current

rows = []
for raw in pathlib.Path(scan_path).read_text().splitlines():
    if not raw.strip():
        continue
    sig, anon, auth = raw.split("\t")
    rows.append((sig, anon == "t", auth == "t"))

anon_hits = [sig for sig, anon, _auth in rows if anon]
print(f"anon executable public functions: {len(anon_hits)}")
if anon_hits:
    sys.stderr.write("anon can execute public functions:\n")
    for sig in anon_hits:
        sys.stderr.write(f"  {sig}\n")
    sys.exit(1)

exposed = [(sig, anon, auth) for sig, anon, auth in rows if anon or auth]
print(f"exposed public functions: {len(exposed)}")
unexpected = []
for sig, anon, auth in exposed:
    grant = mode_for.get(norm(sig))
    flags = f"anon={'yes' if anon else 'no'} authenticated={'yes' if auth else 'no'}"
    if grant is None:
        unexpected.append(sig)
        print(f"  UNLISTED {sig} {flags}")
    elif anon:
        unexpected.append(sig)
        print(f"  ANON {sig} {flags}")
    else:
        print(f"  ok {sig} {flags} mode={grant}")

if mode == "forward":
    # anon is already required to be zero. A function introduced at or after
    # the default-privilege change must be allowlisted to be executable by
    # authenticated. Older authenticated exposure is printed above.
    import re
    introduced = set()
    root = pathlib.Path("supabase/migrations")
    for path in sorted(root.glob("*.sql")):
        version = path.name.split("_", 1)[0]
        if version < "20261029120000":
            continue
        text = path.read_text()
        for match in re.finditer(
            r"create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-zA-Z_][a-zA-Z0-9_]*)",
            text,
            flags=re.IGNORECASE,
        ):
            introduced.add(match.group(1).lower())
    gated = [sig for sig in unexpected if sig.split(".", 1)[1].split("(", 1)[0].lower() in introduced]
    if gated:
        sys.stderr.write("New migration exposes a function that is not allowlisted:\n")
        for sig in gated:
            sys.stderr.write(f"  {sig}\n")
        sys.exit(1)
    print("forward gate: anon execute is zero; historical authenticated exposure was not failed")
    sys.exit(0)

if unexpected:
    sys.stderr.write("Public functions executable by authenticated and not allowlisted:\n")
    for sig in unexpected:
        sys.stderr.write(f"  {sig}\n")
    sys.exit(1)
print("full gate: anon execute is zero; allowlist matches exposure")
PY

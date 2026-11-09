#!/usr/bin/env bash
# Disposable PostgreSQL 17 backup/restore rehearsal for the synthetic app database.
# Refuses inherited credentials, non-loopback targets, and production-like env names.
set -euo pipefail

PRODUCT_SHA=9ebe581108c1ed6a9b050dc31f429201fb5be781
PRODUCT_TREE=e4e4f6ee925127e20ee7aed8654196008cf9f79e
PG17_IMAGE=postgres:17.11@sha256:ff87138949ad9a46f32ff23bd6852b52ce024a13dffe9b4087be98292cdd3b4f
PG17_INDEX_DIGEST=sha256:ff87138949ad9a46f32ff23bd6852b52ce024a13dffe9b4087be98292cdd3b4f
NODE_EXPECT=v20.20.2
NPM_EXPECT=10.8.2
SRC_DB=condola_pg17_src
DST_DB=condola_pg17_dst
ADMIN_DB=postgres
PGHOST_EXPECT=127.0.0.1
PGUSER_EXPECT=condola
PGPASSWORD_EXPECT=condola

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SQL_FILE=$(cd "$(dirname "$0")" && pwd)/pg17-restore-compare.sql
WORKFLOW="$ROOT/.github/workflows/pg17-synthetic-rehearsal.yml"

static_check() {
  python3 - "$WORKFLOW" "$SQL_FILE" "$PG17_IMAGE" "$PRODUCT_SHA" "$PRODUCT_TREE" <<'PY'
import pathlib, sys
import yaml
workflow_path, sql_path, image, sha, tree = sys.argv[1:]
text = pathlib.Path(workflow_path).read_text()
sql = pathlib.Path(sql_path).read_text()
if "${{ secrets" in text or "secrets." in text:
    raise SystemExit("workflow references secrets")
if "workflow_run" in text or "repository_dispatch" in text:
    raise SystemExit("unexpected event style")
doc = yaml.safe_load(text)
on = doc.get(True) or doc.get("on")
if not isinstance(on, dict) or set(on) != {"workflow_dispatch"}:
    raise SystemExit(f"trigger must be workflow_dispatch only, got {on!r}")
if on["workflow_dispatch"]:
    raise SystemExit("workflow_dispatch inputs are not allowed")
perms = doc.get("permissions") or {}
expected_false = {
    "checks": "none",
    "deployments": "none",
    "discussions": "none",
    "id-token": "none",
    "issues": "none",
    "packages": "none",
    "pages": "none",
    "pull-requests": "none",
    "repository-projects": "none",
    "security-events": "none",
    "statuses": "none",
}
if perms.get("contents") != "read" or perms.get("actions") != "write":
    raise SystemExit(f"unexpected token scopes: {perms}")
for key, value in expected_false.items():
    if perms.get(key) != value:
        raise SystemExit(f"missing {key}: {value}")
job = doc["jobs"]["rehearse"]
if job.get("runs-on") != "ubuntu-latest":
    raise SystemExit("runner must be ubuntu-latest")
if "environment" in job:
    raise SystemExit("job selects a GitHub environment")
service = job["services"]["postgres"]
if service["image"] != image:
    raise SystemExit("service image does not match the pinned digest")
if service["env"].get("POSTGRES_DB") != "postgres":
    raise SystemExit("service must not pre-create the app database")
checkouts = [step for step in job["steps"] if str(step.get("uses", "")).startswith("actions/checkout@")]
if len(checkouts) != 2:
    raise SystemExit("expected two checkouts")
for step in checkouts:
    if step["with"].get("persist-credentials") is not False:
        raise SystemExit("persist-credentials must be false")
product = checkouts[1]["with"]
if product.get("ref") != sha or product.get("path") != "product" or product.get("fetch-depth") != 1:
    raise SystemExit("product checkout pin mismatch")
setup = next(step for step in job["steps"] if str(step.get("uses", "")).startswith("actions/setup-node@"))
if setup["with"].get("node-version") != "20.20.2":
    raise SystemExit("node version mismatch")
if "npm ci" not in "\n".join(step.get("run", "") for step in job["steps"] if "run" in step):
    raise SystemExit("npm ci missing")
if "npm install" in text:
    raise SystemExit("npm install is not allowed")
upload = next(step for step in job["steps"] if str(step.get("uses", "")).startswith("actions/upload-artifact@"))
with_ = upload["with"]
if with_.get("path") != "product/pg17-rehearsal-out/summary.json":
    raise SystemExit("artifact path is not the summary allowlist")
if with_.get("retention-days") != 1 or with_.get("if-no-files-found") != "error":
    raise SystemExit("artifact retention is not short and strict")
script = pathlib.Path(sql_path).with_name("pg17-synthetic-rehearsal.sh").read_text()
if tree not in script or sha not in script or image not in script:
    raise SystemExit("script pins drifted from the workflow")
for required in ("last_value", "is_called", "relrowsecurity", "relforcerowsecurity", "pg_policy", "relacl"):
    if required not in sql:
        raise SystemExit(f"comparator missing {required}")
print("static-ok")
PY
  bash -n "$ROOT/scripts/pg17-synthetic-rehearsal.sh"
}

if [[ "${1:-}" == "--static" ]]; then
  static_check
  exit 0
fi

if [[ "${CONDOLA_RLS_DISPOSABLE:-}" != "YES" || "${CONDOLA_SYNTHETIC_REHEARSAL:-}" != "YES" || "${DEMO_MODE:-}" != "true" ]]; then
  echo "Refusing to run without explicit synthetic disposable consent." >&2
  exit 1
fi
case "${CONDOLA_ENV:-}" in
  production|staging|staging-real) echo "Refusing production-like CONDOLA_ENV." >&2; exit 1 ;;
esac
case "${NODE_ENV:-}" in
  production) echo "Refusing NODE_ENV=production." >&2; exit 1 ;;
esac
for inherited in ID_DOC_ENCRYPTION_KEY ID_DOC_HMAC_KEY ID_DOC_SIGNING_SECRET CLOUDFLARE_API_TOKEN SUPABASE_URL SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY PROD_DB_URL_SESSION DATABASE_URL; do
  if [[ -n "${!inherited:-}" ]]; then
    echo "Refusing inherited ${inherited}." >&2
    exit 1
  fi
done
if [[ "${CONDOLA_PG17_USE_SERVICE:-}" == "1" && "${CONDOLA_PG17_START:-}" == "1" ]]; then
  echo "Choose either the service container or a locally started container." >&2
  exit 1
fi
if [[ "${CONDOLA_PG17_USE_SERVICE:-}" != "1" && "${CONDOLA_PG17_START:-}" != "1" ]]; then
  echo "Set CONDOLA_PG17_USE_SERVICE=1 or CONDOLA_PG17_START=1." >&2
  exit 1
fi
PGPORT="${PGPORT:-5432}"
if [[ ! "$PGPORT" =~ ^[0-9]+$ || "$PGPORT" -lt 1 || "$PGPORT" -gt 65535 ]]; then
  echo "Refusing PGPORT." >&2
  exit 1
fi
if [[ -z "${PRODUCT_DIR:-}" || ! -f "$PRODUCT_DIR/package-lock.json" || ! -d "$PRODUCT_DIR/supabase/migrations" ]]; then
  echo "PRODUCT_DIR must be the fixed product checkout." >&2
  exit 1
fi
if [[ -e "$PRODUCT_DIR/.env" || -e "$PRODUCT_DIR/.env.local" || -e "$PRODUCT_DIR/.dev.vars" ]]; then
  echo "Refusing a product checkout that contains env files." >&2
  exit 1
fi
actual_sha=$(git -C "$PRODUCT_DIR" rev-parse HEAD)
actual_tree=$(git -C "$PRODUCT_DIR" rev-parse 'HEAD^{tree}')
if [[ "$actual_sha" != "$PRODUCT_SHA" || "$actual_tree" != "$PRODUCT_TREE" ]]; then
  echo "Product checkout is ${actual_sha} tree ${actual_tree}." >&2
  exit 1
fi
if [[ "$(node -v)" != "$NODE_EXPECT" || "$(npm -v)" != "$NPM_EXPECT" ]]; then
  echo "Node/npm must be ${NODE_EXPECT} / ${NPM_EXPECT}; found $(node -v) / $(npm -v)." >&2
  exit 1
fi
if [[ ! -x "$PRODUCT_DIR/node_modules/.bin/tsx" ]]; then
  echo "tsx is missing. Run npm ci from the existing lockfile first." >&2
  exit 1
fi

export PRODUCT_SHA PRODUCT_TREE PG17_IMAGE NODE_EXPECT NPM_EXPECT SRC_DB DST_DB
started=0
cid=""
summary_written=0
result=fail
postgres_version=""
fingerprint_sha=""
mismatch_count=0
table_count=0
total_rows=0
sequence_count=0
policy_count=0
preview_file=$(mktemp)
src_fp=$(mktemp)
dst_fp=$(mktemp)
diff_file=$(mktemp)
out_dir="$PRODUCT_DIR/pg17-rehearsal-out"
mkdir -p "$out_dir"
chmod 700 "$out_dir"

cleanup() {
  docker exec "$cid" rm -f /tmp/condola-pg17-synthetic.dump >/dev/null 2>&1 || true
  if [[ "$started" == 1 && -n "$cid" ]]; then
    docker rm -f "$cid" >/dev/null 2>&1 || true
  fi
  rm -f "$src_fp" "$dst_fp" "$diff_file"
  if [[ "$summary_written" != 1 ]]; then
    RESULT=fail POSTGRES_VERSION="$postgres_version" FINGERPRINT_SHA="$fingerprint_sha" \
      MISMATCH_COUNT="$mismatch_count" TABLE_COUNT="$table_count" TOTAL_ROWS="$total_rows" \
      SEQUENCE_COUNT="$sequence_count" POLICY_COUNT="$policy_count" PREVIEW_FILE="$preview_file" \
      OUT_FILE="$out_dir/summary.json" WORKFLOW_SHA="${GITHUB_SHA:-}" WORKFLOW_REF="${GITHUB_REF:-}" \
      python3 - <<'PY'
import json, os, pathlib
preview = []
path = os.environ.get("PREVIEW_FILE")
if path and os.path.exists(path):
    lines = pathlib.Path(path).read_text(errors="replace").splitlines()
    preview = [line[:240] for line in lines[:30]]
doc = {
    "kind": "condola-pg17-synthetic-rehearsal",
    "evidence_class": "synthetic-runtime",
    "result": "fail",
    "product_sha": os.environ["PRODUCT_SHA"],
    "product_tree": os.environ["PRODUCT_TREE"],
    "workflow_sha": os.environ.get("WORKFLOW_SHA") or None,
    "workflow_ref": os.environ.get("WORKFLOW_REF") or None,
    "node": os.environ["NODE_EXPECT"],
    "npm": os.environ["NPM_EXPECT"],
    "image": os.environ["PG17_IMAGE"],
    "postgres_version": os.environ.get("POSTGRES_VERSION") or None,
    "source_database": os.environ["SRC_DB"],
    "restore_database": os.environ["DST_DB"],
    "same_cluster": True,
    "cluster_roles_in_dump": False,
    "mismatch_count": int(os.environ.get("MISMATCH_COUNT") or 0),
    "mismatch_preview": preview,
    "product_role_acceptance": {"management": "not-run", "tenant": "not-run", "owner": "not-run", "vendor": "not-run"},
    "excluded_stacks": "left-off",
    "qa_gate_added": False,
}
pathlib.Path(os.environ["OUT_FILE"]).write_text(json.dumps(doc, indent=2) + "\n")
PY
    summary_written=1
  fi
  rm -f "$preview_file"
}
trap cleanup EXIT

psql_c() {
  local db=$1
  local sql=$2
  docker exec -e PGOPTIONS="-c client_min_messages=warning" "$cid" psql -v ON_ERROR_STOP=1 -U "$PGUSER_EXPECT" -d "$db" -Atc "$sql"
}
psql_file() {
  local db=$1
  local file=$2
  docker exec -e PGOPTIONS="-c client_min_messages=warning" -i "$cid" psql -v ON_ERROR_STOP=1 -U "$PGUSER_EXPECT" -d "$db" < "$file"
}

if [[ "${CONDOLA_PG17_START:-}" == 1 ]]; then
  cid="condola-pg17-rehearsal-$$"
  docker rm -f "$cid" >/dev/null 2>&1 || true
  docker run -d --name "$cid" \
    -e POSTGRES_USER="$PGUSER_EXPECT" \
    -e POSTGRES_PASSWORD="$PGPASSWORD_EXPECT" \
    -e POSTGRES_DB="$ADMIN_DB" \
    -p "${PGPORT}:5432" \
    "$PG17_IMAGE" >/dev/null
  started=1
else
  mapfile -t ids < <(docker ps -q --filter "publish=${PGPORT}")
  if [[ "${#ids[@]}" -ne 1 ]]; then
    echo "Expected one container publishing ${PGPORT}." >&2
    exit 1
  fi
  cid="${ids[0]}"
fi

ready=0
for _ in $(seq 1 60); do
  if docker exec "$cid" pg_isready -U "$PGUSER_EXPECT" -d "$ADMIN_DB" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then
  echo "PostgreSQL did not become ready." >&2
  exit 1
fi

digests=$(docker inspect -f '{{range .RepoDigests}}{{println .}}{{end}}' "$(docker inspect -f '{{.Image}}' "$cid")")
if [[ "$digests" != *"$PG17_INDEX_DIGEST"* ]]; then
  echo "Container image digest does not match the pinned official index." >&2
  exit 1
fi
postgres_version=$(psql_c "$ADMIN_DB" "SHOW server_version")
if [[ "$postgres_version" != 17.11* ]]; then
  echo "Server version is not 17.11." >&2
  exit 1
fi
listen=$(psql_c "$ADMIN_DB" "SHOW listen_addresses")
if [[ "$listen" != "*" && "$listen" != "0.0.0.0" && "$listen" != "127.0.0.1" && "$listen" != localhost ]]; then
  echo "Refusing unexpected listen_addresses." >&2
  exit 1
fi

export DATABASE_URL="postgres://${PGUSER_EXPECT}:${PGPASSWORD_EXPECT}@${PGHOST_EXPECT}:${PGPORT}/${SRC_DB}"

shopt -s nullglob
migrations=("$PRODUCT_DIR"/supabase/migrations/*.sql)
if [[ "${#migrations[@]}" -eq 0 ]]; then
  echo "No migrations found." >&2
  exit 1
fi
echo "Applying stub and ${#migrations[@]} migrations to ${SRC_DB}."
psql_c "$ADMIN_DB" "DROP DATABASE IF EXISTS ${SRC_DB} WITH (FORCE)" >/dev/null
psql_c "$ADMIN_DB" "DROP DATABASE IF EXISTS ${DST_DB} WITH (FORCE)" >/dev/null
psql_c "$ADMIN_DB" "CREATE DATABASE ${SRC_DB} TEMPLATE template0" >/dev/null
psql_file "$SRC_DB" "$PRODUCT_DIR/supabase/stub/supabase_stub.sql" >/dev/null
for migration in "${migrations[@]}"; do
  psql_file "$SRC_DB" "$migration" >/dev/null
done
echo "Seeding synthetic demo fixtures."

(
  cd "$PRODUCT_DIR"
  ID_DOC_ENCRYPTION_KEY=$(python3 -c 'import secrets; print(secrets.token_hex(32))') \
  ID_DOC_HMAC_KEY=$(python3 -c 'import secrets; print(secrets.token_hex(32))') \
  ID_DOC_SIGNING_SECRET=$(python3 -c 'import secrets; print(secrets.token_hex(32))') \
  DEMO_MODE=true \
  DATABASE_URL="$DATABASE_URL" \
  CONDOLA_RLS_DISPOSABLE=YES \
  ./node_modules/.bin/tsx src/server/seed.ts
) >/dev/null

role_count=$(psql_c "$SRC_DB" "SELECT count(*) FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')")
if [[ "$role_count" != 3 ]]; then
  echo "Synthetic stub roles are missing." >&2
  exit 1
fi

echo "Dumping ${SRC_DB} and restoring into ${DST_DB}."
psql_c "$ADMIN_DB" "CREATE DATABASE ${DST_DB} TEMPLATE template0" >/dev/null
docker exec "$cid" pg_dump -U "$PGUSER_EXPECT" -d "$SRC_DB" --format=custom --file=/tmp/condola-pg17-synthetic.dump
docker exec "$cid" pg_restore -U "$PGUSER_EXPECT" -d "$DST_DB" --exit-on-error --single-transaction /tmp/condola-pg17-synthetic.dump
docker exec "$cid" rm -f /tmp/condola-pg17-synthetic.dump

normalize_fingerprint() {
  python3 - "$1" "$2" <<'PY'
import pathlib, re, sys
src, dest = sys.argv[1:]
token_re = re.compile(r"\s+|\(|\)|,|'(?:[^']|'')*'|\"(?:[^\"]|\"\")*\"|\bAND\b|\bOR\b|\bNOT\b|[^(),\s]+", re.I)

def tokens(expr):
    out = []
    for part in token_re.findall(expr):
        if part.isspace():
            continue
        if part == ",":
            out.append(",")
            continue
        word = part.upper()
        if word in {"AND", "OR", "NOT"}:
            out.append(word)
        else:
            out.append(part)
    return out

def parse(parts):
    pos = 0
    def peek():
        return parts[pos] if pos < len(parts) else None
    def take():
        nonlocal pos
        current = parts[pos]
        pos += 1
        return current
    def parse_or():
        node = parse_and()
        kids = [node]
        while peek() == "OR":
            take()
            kids.append(parse_and())
        return ("OR", kids) if len(kids) > 1 else node
    def parse_and():
        node = parse_not()
        kids = [node]
        while peek() == "AND":
            take()
            kids.append(parse_not())
        return ("AND", kids) if len(kids) > 1 else node
    def parse_not():
        if peek() == "NOT":
            take()
            return ("NOT", [parse_not()])
        return parse_primary()
    def parse_primary():
        if peek() == "(":
            take()
            node = parse_or()
            if peek() != ")":
                raise ValueError("unbalanced")
            take()
            return node
        if peek() is None:
            raise ValueError("truncated")
        atom = take()
        if peek() == "(":
            take()
            args = [parse_or()]
            while peek() == ",":
                take()
                args.append(parse_or())
            if peek() != ")":
                raise ValueError("call")
            take()
            return ("CALL", atom, args)
        return ("ATOM", atom)
    node = parse_or()
    if pos != len(parts):
        raise ValueError("trailing")
    return node

def flatten(node):
    kind = node[0]
    if kind == "ATOM":
        return node
    if kind == "CALL":
        return ("CALL", node[1], [flatten(arg) for arg in node[2]])
    kids = [flatten(child) for child in node[1]]
    if kind in {"AND", "OR"}:
        flat = []
        for child in kids:
            if child[0] == kind:
                flat.extend(child[1])
            else:
                flat.append(child)
        return (kind, flat)
    return (kind, kids)

def render(node):
    kind = node[0]
    if kind == "ATOM":
        return node[1]
    if kind == "CALL":
        return node[1] + "(" + ", ".join(render(arg) for arg in node[2]) + ")"
    if kind == "NOT":
        return "NOT " + render(node[1][0])
    joiner = f" {kind} "
    return joiner.join(render(child) for child in node[1])

def normalize_check(defn):
    prefix = "CHECK ("
    if not defn.startswith(prefix) or not defn.endswith(")"):
        return defn
    inner = defn[len(prefix):-1]
    try:
        return "CHECK (" + render(flatten(parse(tokens(inner)))) + ")"
    except ValueError:
        return defn

lines = []
for raw in pathlib.Path(src).read_text().splitlines():
    if raw.startswith("CONSTRAINT\t"):
        sch, rel, name, contype, defn = raw.split("\t", 4)[1:]
        if contype == "c":
            defn = normalize_check(defn)
        lines.append(f"CONSTRAINT {sch} {rel} {name} {contype} {defn}")
    else:
        lines.append(raw)
pathlib.Path(dest).write_text("\n".join(lines) + ("\n" if lines else ""))
PY
}

fingerprint() {
  local db=$1
  local dest=$2
  local raw
  raw=$(mktemp)
  docker exec -i "$cid" psql -X -q -v ON_ERROR_STOP=1 -U "$PGUSER_EXPECT" -d "$db" < "$SQL_FILE" \
    | grep -E '^(COUNT|CONTENT|SEQUENCE|COLUMN|CONSTRAINT|INDEX|VIEW|FUNCTION|TRIGGER|ACL|ACL_SCHEMA|DEFAULT_ACL|RLS|POLICY|EXTENSION|COMMENT)([ \t]|$)' \
    > "$raw"
  normalize_fingerprint "$raw" "$dest"
  sort -o "$dest" "$dest"
  rm -f "$raw"
}
fingerprint "$SRC_DB" "$src_fp"
fingerprint "$DST_DB" "$dst_fp"
if [[ ! -s "$src_fp" || ! -s "$dst_fp" ]]; then
  echo "Fingerprint was empty." >&2
  exit 1
fi
fingerprint_sha=$(sha256sum "$src_fp" | awk '{print $1}')
table_count=$(grep -c '^COUNT ' "$src_fp" || true)
total_rows=$(awk '$1=="COUNT" {sum+=$4} END {print sum+0}' "$src_fp")
sequence_count=$(grep -c '^SEQUENCE ' "$src_fp" || true)
policy_count=$(grep -c '^POLICY ' "$src_fp" || true)
if diff -u "$src_fp" "$dst_fp" > "$diff_file"; then
  mismatch_count=0
  result=pass
else
  mismatch_count=$(grep -c '^[+-][^+-]' "$diff_file" || true)
  result=fail
  head -n 30 "$diff_file" > "$preview_file"
fi

RESULT="$result" POSTGRES_VERSION="$postgres_version" FINGERPRINT_SHA="$fingerprint_sha" \
  MISMATCH_COUNT="$mismatch_count" TABLE_COUNT="$table_count" TOTAL_ROWS="$total_rows" \
  SEQUENCE_COUNT="$sequence_count" POLICY_COUNT="$policy_count" PREVIEW_FILE="$preview_file" \
  OUT_FILE="$out_dir/summary.json" WORKFLOW_SHA="${GITHUB_SHA:-}" WORKFLOW_REF="${GITHUB_REF:-}" \
  python3 - <<'PY'
import json, os, pathlib
preview = []
path = os.environ.get("PREVIEW_FILE")
if path and os.path.exists(path) and os.environ["RESULT"] != "pass":
    preview = [line[:240] for line in pathlib.Path(path).read_text(errors="replace").splitlines()[:30]]
doc = {
    "kind": "condola-pg17-synthetic-rehearsal",
    "evidence_class": "synthetic-runtime",
    "result": os.environ["RESULT"],
    "product_sha": os.environ["PRODUCT_SHA"],
    "product_tree": os.environ["PRODUCT_TREE"],
    "workflow_sha": os.environ.get("WORKFLOW_SHA") or None,
    "workflow_ref": os.environ.get("WORKFLOW_REF") or None,
    "node": os.environ["NODE_EXPECT"],
    "npm": os.environ["NPM_EXPECT"],
    "image": os.environ["PG17_IMAGE"],
    "postgres_version": os.environ["POSTGRES_VERSION"],
    "source_database": os.environ["SRC_DB"],
    "restore_database": os.environ["DST_DB"],
    "same_cluster": True,
    "cluster_roles_in_dump": False,
    "table_count": int(os.environ["TABLE_COUNT"]),
    "total_rows": int(os.environ["TOTAL_ROWS"]),
    "sequence_count": int(os.environ["SEQUENCE_COUNT"]),
    "policy_count": int(os.environ["POLICY_COUNT"]),
    "fingerprint_sha256": os.environ["FINGERPRINT_SHA"],
    "mismatch_count": int(os.environ["MISMATCH_COUNT"]),
    "mismatch_preview": preview,
    "product_role_acceptance": {"management": "not-run", "tenant": "not-run", "owner": "not-run", "vendor": "not-run"},
    "excluded_stacks": "left-off",
    "qa_gate_added": False,
}
pathlib.Path(os.environ["OUT_FILE"]).write_text(json.dumps(doc, indent=2) + "\n")
PY
summary_written=1
chmod 600 "$out_dir/summary.json"
if [[ "$result" != pass ]]; then
  echo "Restore fingerprint mismatch (${mismatch_count} lines). Summary has no row payloads." >&2
  exit 1
fi
echo "Synthetic PG17 restore fingerprint matched."

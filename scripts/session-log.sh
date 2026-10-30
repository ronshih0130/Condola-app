#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

usage() {
  cat <<'EOF'
Usage:
  scripts/session-log.sh start --role pe --app codex|claude \
    --model "<name or unknown>" --lane <lane> [--sha <sha>] [--reasoning <level>]
  scripts/session-log.sh end --session ID --outcome pass|fail|partial [--evidence path]
  scripts/session-log.sh trailers

Start prints a shell export. To retain it in the supervising shell:
  eval "$(scripts/session-log.sh start --role pe --app codex --model unknown --lane example)"
A child process cannot modify its parent's environment.
Trailers requires CONDOLA_SESSION_ID in the calling environment.
Requires python3. Writes Mode B JSONL records; tokens and cost are "unknown".
EOF
}
die() { printf 'session-log: %s\n' "$*" >&2; exit 1; }
stamp() { TZ=America/Los_Angeles date '+%Y-%m-%dT%H:%M:%S%z PT (America/Los_Angeles)'; }

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  start|end|trailers) action=$1; shift ;;
  *) usage >&2; exit 2 ;;
esac
command -v python3 >/dev/null 2>&1 || die "python3 is required."
root=$(git rev-parse --show-toplevel) || die "Run inside the repository."
export CONDOLA_LOG_ROOT="$root/ops/log"
export CONDOLA_LOG_TS
CONDOLA_LOG_TS=$(stamp)
export CONDOLA_LOG_DAY
CONDOLA_LOG_DAY=$(TZ=America/Los_Angeles date '+%Y-%m-%d')

python3 - "$action" "$@" <<'PY'
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import uuid

def fail(message):
    print("session-log: " + message, file=sys.stderr)
    sys.exit(1)

def single(value, label):
    if not value or any(ord(c) < 32 or ord(c) == 127 for c in value):
        fail(label + " must be nonempty single-line text.")
    return value

def session_id(value):
    try:
        parsed = uuid.UUID(value)
    except (ValueError, AttributeError):
        fail("Session must be a UUID.")
    return str(parsed)

action = sys.argv[1]
p = argparse.ArgumentParser(add_help=False)
if action == "start":
    p.add_argument("--role", required=True, choices=["pe", "qa", "ceo", "rd", "start", "handoff"])
    p.add_argument("--app", required=True, choices=["codex", "claude"])
    p.add_argument("--model", required=True)
    p.add_argument("--lane", required=True)
    p.add_argument("--sha")
    p.add_argument("--reasoning", default="unknown")
elif action == "end":
    p.add_argument("--session", required=True)
    p.add_argument("--outcome", required=True, choices=["pass", "fail", "partial"])
    p.add_argument("--evidence")
args = p.parse_args(sys.argv[2:])

root = Path(os.environ["CONDOLA_LOG_ROOT"])
root.mkdir(parents=True, exist_ok=True, mode=0o700)

def locate(sid):
    matches = list(root.glob("????-??-??/" + sid + ".jsonl"))
    if len(matches) != 1:
        fail("Expected exactly one session log.")
    path = matches[0]
    if path.is_symlink():
        fail("Session log must not be a symlink.")
    return path

def load_locked(file):
    try:
        file.seek(0)
        records = [json.loads(line) for line in file if line.strip()]
    except (ValueError, UnicodeError):
        fail("Invalid session log.")
    if not records or records[0].get("event") != "start":
        fail("Missing session start record.")
    return records

if action == "start":
    sid = str(uuid.uuid4())
    sha_arg = args.sha or "HEAD"
    single(sha_arg, "SHA")
    resolved = subprocess.run(
        ["git", "rev-parse", "--verify", "--end-of-options", sha_arg + "^{commit}"],
        capture_output=True, text=True)
    if resolved.returncode:
        fail("SHA must resolve to a local commit.")
    sha = resolved.stdout.strip()
    record = {
        "ts": os.environ["CONDOLA_LOG_TS"],
        "session": sid, "mode": "B", "role": args.role,
        "provider": "openai" if args.app == "codex" else "anthropic",
        "app": args.app, "model": single(args.model, "Model"),
        "reasoning": single(args.reasoning, "Reasoning"),
        "lane": single(args.lane, "Lane"), "sha": sha,
        "event": "start", "tokens": "unknown", "cost": "unknown"
    }
    directory = root / os.environ["CONDOLA_LOG_DAY"]
    if directory.is_symlink():
        fail("Log directory must not be a symlink.")
    directory.mkdir(mode=0o700, exist_ok=True)
    path = directory / (sid + ".jsonl")
    with path.open("x", encoding="utf-8") as f:
        os.chmod(path, 0o600)
        f.write(json.dumps(record, ensure_ascii=False) + "\n")
        f.flush()
        os.fsync(f.fileno())
    os.environ["CONDOLA_SESSION_ID"] = sid
    print("export CONDOLA_SESSION_ID='" + sid + "'")

elif action == "end":
    sid = session_id(args.session)
    path = locate(sid)
    with path.open("r+", encoding="utf-8") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        records = load_locked(f)
        ended = [r for r in records if r.get("event") == "end"]
        evidence = single(args.evidence, "Evidence") if args.evidence else None
        if ended:
            last = ended[-1]
            if last.get("outcome") == args.outcome and last.get("evidence") == evidence:
                print("Session already ended: " + sid)
                sys.exit(0)
            fail("Session already ended with different results.")
        record = dict(records[0])
        record.update(ts=os.environ["CONDOLA_LOG_TS"], event="end",
                      outcome=args.outcome, evidence=evidence,
                      tokens="unknown", cost="unknown")
        f.seek(0, os.SEEK_END)
        f.write(json.dumps(record, ensure_ascii=False) + "\n")
        f.flush()
        os.fsync(f.fileno())
    print("Session ended: " + sid)

else:
    sid = session_id(os.environ.get("CONDOLA_SESSION_ID", ""))
    with locate(sid).open(encoding="utf-8") as f:
        fcntl.flock(f, fcntl.LOCK_SH)
        records = load_locked(f)
    first = records[0]
    print("Model: " + single(first["model"], "Model"))
    print("Role: " + single(first["role"], "Role"))
    print("Session: " + sid)
PY

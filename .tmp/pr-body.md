## Summary
Lauren 3-W: CI re-runs the red-on-base proofs instead of trusting pasted text. A new step, **"Re-run proofs (npm run gate:proofs)"**, runs the same command in hosted `ci.yml` and the Mac shadow `ci-shadow.yml`, after the disposable database is up. It reuses the PR body, title and base that `scripts/ci-pr-context.mjs` (6-W) already resolves.

- **New `scripts/gate-proofs.mjs`** (`npm run gate:proofs`). Every proof goes through `node scripts/red-on-base.mjs` and must end in `RED-ON-BASE: PASS`; FAIL and INCONCLUSIVE both fail the step.
  1. **Rule Table** (AGENTS.md §16): every row, on every run, as `--base <Proof-Fails-On> --test <ENFORCER> --expect <Expect>` (the table's `\|` read as `|`). Parsing is strict and fails closed: a `none` row, a row without edge pipes, a row split off by a blank line, a second table or section, a bad SHA, path or regex, or a duplicate ID all fail the step. ENFORCER must be tracked at HEAD, and Proof-Fails-On must be a commit HEAD contains.
  2. **Bug-fix PRs** (R4's own detection): each pasted run that R4 accepts is re-run against **the PR's base**; a pasted `--base` is replaced and logged.
     - Arguments are read as a strict shell subset: plain words plus `'...'`/`"..."` without `$` or backquotes. Pipes, redirects, globs, braces, comments and expansions fail the step rather than being guessed.
     - `--cmd` must be `npx tsx --test {tests}`, `node --test {tests}` or `bash scripts/red-on-base-db.sh {tests}`. An untracked local wrapper such as `rob-cmd.sh` fails the step.
  - Missing evidence (a bug-fix PR with no pasted run that ends in PASS) fails the step.
- **New `scripts/red-on-base-db.sh`**: the tracked replacement for local `rob-cmd.sh` wrappers.
  - It gives each red-on-base side a **fresh disposable database built from that side's own schema**: stub, then `supabase/migrations/*.sql` via `psql -X -v ON_ERROR_STOP=1 -f` as CI does, then the seed. It runs `npx tsx --test --test-concurrency=1 <tests>` and drops the database on exit.
  - Guarded like the integration tests: `CONDOLA_RLS_DISPOSABLE=YES` and a localhost `DATABASE_URL` only.
  - Credentials reach psql through PG* env vars, never argv.
- `scripts/check-pr-rules.mjs` exports its R4 parsing helpers and the new `acceptedRedOnBaseRuns()`. R4 uses the same function, so the runs CI re-runs are exactly the ones R4 accepted, and `main()` runs only as a CLI. R4 behaviour is unchanged (its tests pass unchanged).
- Docs: AGENTS.md §16 says the CI step is now the enforcement, alongside the weekly routine; `.github/pull_request_template.md` gives the rules for pasting a re-runnable command.
- **No permissions, token, secrets, trigger, job name, runner or required-check changes.** The new step gets no token. `.depot/` is not touched. Under the 11/20 19:22 PST rule (hub DECISIONS), this is a workflow PR outside the exception list.

## Story / AC
n/a (CI wiring). Plan row 3-W: "CI handles missing evidence, INCONCLUSIVE, and valid red-on-base proof correctly."

## File ownership & merge order (RULES 7)
- Owns: `.github/workflows/ci.yml` (one new step after "Check function execute privileges"), `.github/workflows/ci-shadow.yml` (the same step), new `scripts/gate-proofs.mjs` + test, new `scripts/red-on-base-db.sh`, `scripts/check-pr-rules.mjs` (exports and CLI guard), `package.json` (`gate:proofs` + one `test:unit` entry), `AGENTS.md` §16 (one sentence), `.github/pull_request_template.md` (one sentence).
- **Lock:** open PR #125 (`feat/b045b-site`, not draft) also edits `ci.yml`, only its `on:` triggers; this PR edits only steps. CEO ruling for 6-W: #273 first, then #125 rebases and resolves `ci.yml` without force-push. Proposed: the same order, this PR before #125. `package.json`: only drafts idle more than 7 days and DO NOT MERGE PRs (not locks). No other open PR touches these files.

## Verification
Head `a7d4222c` on base origin/main `c42eb6d8`.

```
$ npm run gate:pr -- --pr-body-file .tmp/pr-body.md --pr-title "ci: CI re-runs the red-on-base proofs, npm run gate:proofs (Lauren 3-W)"
== gate:pr [typecheck] npm run -s typecheck
== gate:pr [lint] npm run -s lint
== gate:pr [check-pr-rules] node scripts/check-pr-rules.mjs --base origin/main --head HEAD --no-r3 --pr-body-file .tmp/pr-body.md --pr-title ci: CI re-runs the red-on-base proofs, npm run gate:proofs (Lauren 3-W)
R2 OK: no existing-test assertion changes
R4 OK: Verification has 5 command block(s) with output
Summary: R2 PASS, R3 SKIP, R4 PASS
== gate:pr [test:unit] npm run -s test:unit
[10 tsx --test batches; TAP trimmed to totals] tests 11504, pass 11503, fail 0, skipped 1, cancelled 0
gate:pr PASS (typecheck, lint, check-pr-rules, test:unit) at a7d4222c
```

```
$ npm run -s gate:proofs -- --pr-body-file .tmp/pr-body.md --pr-title "ci: CI re-runs the red-on-base proofs, npm run gate:proofs (Lauren 3-W)"
== gate:proofs [RT-01] node scripts/red-on-base.mjs --base d7471dd1 --test scripts/gate-pr.test.ts --expect 'DRY_RUN|FAIL_AT|SKIP'
--- base: exit=1 1720ms
--- head: exit=0 4006ms
RED-ON-BASE: PASS base=d7471dd112e2 head=a7d4222ca439 tests=1
== gate:proofs [RT-02] node scripts/red-on-base.mjs --base 3912a1dd --test scripts/red-on-base.test.mjs --expect 'was still running'
--- base: exit=1 10750ms
--- head: exit=0 12781ms
RED-ON-BASE: PASS base=3912a1dd0abc head=a7d4222ca439 tests=1
gate:proofs [pr] not a bug-fix PR: no PR proof to re-run
== gate:proofs summary
PASS RT-01: RED-ON-BASE: PASS base=d7471dd112e2 head=a7d4222ca439 tests=1
PASS RT-02: RED-ON-BASE: PASS base=3912a1dd0abc head=a7d4222ca439 tests=1
gate:proofs PASS (2 proof(s) re-run)
```

`scripts/gate-proofs.test.mjs`: 10 tests pass. One is end to end, in a throwaway repo with real red-on-base: a real fix passes; a pasted PASS for a test that is green on base fails (`RED-ON-BASE: FAIL`); a wrong `--expect` fails (an inconclusive verdict). The tests catch all six script mutations (use the pasted base; an inconclusive verdict counts as a pass; skip malformed rows; allow any `--cmd`; skip the Rule Table; allow pipes):
```
$ npx tsx --test scripts/gate-proofs.test.mjs
# tests 10
# pass 10
# fail 0
mutations: use pasted base -> # fail 1; inconclusive counts -> # fail 3; skip malformed rows -> # fail 1; any cmd allowed -> # fail 2; no rule rows -> # fail 5; pipes allowed -> # fail 2
```

The DB wrapper, run on the Mac's local disposable PostgreSQL 16 (database dropped afterwards; none left):
```
$ bash scripts/red-on-base-db.sh src/server/tenant-payment-history.integration.test.ts
red-on-base-db: fresh database ready (195 migrations)
# tests 12
# pass 12
# fail 0
```

Each side gets its own schema. A throwaway local branch (never pushed, deleted) on top of `904d88dd` added a migration with a function and an integration test calling it:
```
$ node scripts/red-on-base.mjs --base 904d88dd --test src/server/rob-demo.integration.test.ts --cmd "bash scripts/red-on-base-db.sh {tests}" --expect 'function public.rob_demo\(\) does not exist'
--- base: exit=1 5420ms
  base matches --expect: error: 'function public.rob_demo() does not exist'
--- head: exit=0 5421ms
reason: base red for the expected reason (exit 1), head green
RED-ON-BASE: PASS base=904d88dd0d7a head=2b59affcaf87 tests=1
```

**CI proof:** pending; added as the runs finish (hosted and shadow, this PR green and a red-case draft PR whose pasted PASS the CI re-run must reject).

## Review
- Author family: Claude (git trailers).
- Reviewer: pending.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

# Phase 0 — Test infrastructure (local Mac, disposable PG16, QA-STANDARD gates)

| | |
|---|---|
| App SHA | `1e0a8ab` (GitHub `main`, merge of PR #131) |
| Date | 2026-11-13 PT |
| Author | Mac Claude (Phase 0 draft, Fable) |
| Status | **DRAFT for CEO review** — docs only |
| Requirement | hub `20-build/MAC-CLAUDE-HANDOFF-1112.md` §2.3 and §6; hub `20-build/QA-STANDARD.md` (definition of done) |
| Refreshes | `docs/QA_PLAN.md` (stale: says `gate.sh` is not attached and describes Depot as the gate) — left untouched |

**Evidence rules.** Commands and step lists were read from `package.json`, `scripts/`, `.github/workflows/` and `ops/toolchain.json` at `1e0a8ab`. **No gate was executed for this draft**; results quoted from the handoff are marked as reported. Anything about the live runner, hosted run history, or Depot is **unverified**.

---

## 1. Hard rules (read first)

| Rule | Source |
|---|---|
| **Never point a test, seed, reset, or migration at staging or production.** Tests use a disposable local database only | QA-STANDARD; `docs/STAGING.md:25` |
| `CONDOLA_RLS_DISPOSABLE=YES` must be set explicitly; without it DB tests and e2e refuse to start | `src/server/test-disposable-db.ts`, `scripts/run-e2e.ts`, `scripts/gate.sh` |
| `DATABASE_URL` must be `postgres://` on **`localhost` / `127.0.0.1` / `[::1]` only**, with an explicit port, a single named database, and **no query string or fragment** | `test-disposable-db.ts:2-13` |
| Never apply `supabase/stub/supabase_stub.sql` or run `npm run db:reset` against a hosted database | `docs/STAGING.md:25`, `docs/QA_PLAN.md` |
| **0 real outbound** (email / SMS / LINE / Slack). Tests use mocks or a local capture sink; a mocked test never proves real delivery | QA-STANDARD "External services"; handoff §5 |
| Secrets by NAME only. Local ID-document keys are generated per run and never printed | `.github/workflows/ci.yml` step "Generate ephemeral synthetic test material" |
| Never print row values from any shared database; aggregates only | handoff §5 (INC-RLS-1112) |
| No machine-level changes on the Mac (`/opt/homebrew` ownership, Homebrew as `condola-runner`, runner registration) — those stay with Ron/CEO | handoff §5, §6 |
| A baseline failure is never reported as "pass" | QA-STANDARD "Local and database checks" |

---

## 2. Toolchain (dual Node)

Pins live in `ops/toolchain.json`; `.nvmrc` carries the Node 20 pin.

| Lane | Version | Used for |
|---|---|---|
| Node 20 | **20.20.2** (npm **10.8.2**) | `npm ci`, typecheck, lint, unit, copy check, schema/seed, `test:fn-priv`, `test:rls`, `next build`, Playwright e2e |
| Node 22 | **22.23.5** | wrangler lane only: `npm run cf:build`, `npm run test:worker` |
| PostgreSQL | **major 16** (`gate.sh` accepts 16 or 17; CI and shadow use 16) | disposable DB |
| Playwright | `@playwright/test` ^1.64.1, Chromium, `headless: true`, `workers: 1` | `playwright.config.ts` |
| PDF raster | poppler (`pdftoppm`) | PDF tests |

Rules for the two Node versions (as done in `ci-shadow.yml`):

1. Run `npm ci` **once, under Node 20**.
2. Switch `PATH` to Node 22 **without** re-running `npm ci`, then run `cf:build` and `test:worker`.
3. Switch back to Node 20 before e2e.
4. `gate.sh` checks that the active `node`/`npm` equal the Node 20 pins exactly, so run it under Node 20. Its `--release` steps (`build`, `test:worker`, `test:e2e`) then run under Node 20 too; whether `test:worker` passes there is **unverified** (see §7).

The shadow job never installs tools; it fails fast if the pinned versions are not already present. Local work should follow the same principle: use what is installed, ask Ron/CEO for anything missing.

---

## 3. Disposable PostgreSQL 16 on the Mac

`scripts/db-setup.sh` uses `sudo service postgresql` and `sudo -u postgres` (Linux-style) — do not use it on the Mac. Mirror the shadow job instead (`ci-shadow.yml`, step "Start disposable PostgreSQL 16"):

```bash
# Node 20 active. Throwaway cluster in a temp dir, non-default port, loopback only.
PG_BIN=/opt/homebrew/opt/postgresql@16/bin          # or Postgres.app 16 bin dir
export PGDATA="$(mktemp -d)/condola-pg16-data" PGSOCK="$(mktemp -d)" PGPORT=25432
"$PG_BIN/initdb" -D "$PGDATA" -U condola --auth=trust --encoding=UTF8 --no-locale
"$PG_BIN/pg_ctl" -D "$PGDATA" -w -t 60 -o "-p $PGPORT -k $PGSOCK -c listen_addresses=127.0.0.1" start
"$PG_BIN/psql" -h 127.0.0.1 -p "$PGPORT" -U condola -d postgres -v ON_ERROR_STOP=1 \
  -c "ALTER ROLE condola WITH PASSWORD 'condola';" -c "CREATE DATABASE condola OWNER condola;"

export DATABASE_URL="postgres://condola:condola@127.0.0.1:$PGPORT/condola"   # synthetic, local only
export CONDOLA_RLS_DISPOSABLE=YES DEMO_MODE=true WRANGLER_SEND_METRICS=false

# Schema: local auth stub, then every migration in filename order, then seed.
"$PG_BIN/psql" "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/stub/supabase_stub.sql
for m in supabase/migrations/*.sql; do "$PG_BIN/psql" "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$m"; done
npm run db:reset

# When finished: stop by data dir (never by port) and delete the temp dirs.
"$PG_BIN/pg_ctl" -D "$PGDATA" -m immediate stop
```

Notes:

- Port **25432** is used so the disposable cluster can never collide with another Postgres on 5432; stop it **by data directory**, never by port.
- The `condola`/`condola` credentials are the repo's public synthetic defaults (`scripts/db-reset.sh`, CI); they are not secrets and exist only on loopback.
- `scripts/db-reset.sh` sources `.env.local` if present. Make sure no `.env.local` in the worktree names a hosted database before running it.
- The local role is a **superuser**. It ignores RLS on the owner path even where RLS is forced, so only `tx()` / `svc()` behaviour is faithful locally (`architecture-map.md` §4, G4).
- Applying all 160 migrations to an empty database is itself the QA-STANDARD "additive migration replay from a clean database" check. The "supported upgrade state" and "previous-green code against the new schema" checks need a second database built at the previous green SHA and then upgraded — no script for that was found; do it by hand and record the commands.
- The three ID-document key NAMES (`ID_DOC_ENCRYPTION_KEY`, `ID_DOC_HMAC_KEY`, `ID_DOC_SIGNING_SECRET`) must hold random 32-byte hex values for the run; generate them in the shell, do not echo or store them.

---

## 4. Scripts and what each one proves

| Command | Node | Needs DB | What it proves | What it does not prove |
|---|---|---|---|---|
| `npm ci` | 20 | no | lockfile installs cleanly | — |
| `npm run typecheck` | 20 | no | `tsc --noEmit` passes | runtime behaviour |
| `npm run lint` | 20 | no | ESLint rules | — |
| `npm run copy:check` | 20 | no | copy guard (`src/i18n/copy-guard.test.ts`): banned claims/terms | contextual copy review (still manual) |
| `npm run test:unit` | 20 | no | pure rules: 192 distinct test files over 10 `tsx --test` invocations | anything touching Postgres |
| `bash scripts/check-function-privileges.sh` (`npm run test:fn-priv`) | 20 | yes | `EXECUTE` privileges match `supabase/rpc-allowlist.txt` | table grants / RLS state |
| `npm run test:rls` | 20 | yes | RLS, org isolation, role and integration behaviour; runs `test:rls:b021-base` first (107 files, 105 of them `*.integration.test.ts`), then 46 more integration files | owner-path vs forced RLS (superuser locally) |
| `npm run build` | 20 | no | `next build` + third-party licence bundle verification | Worker bundle |
| `npm run cf:build` | **22** | no | OpenNext Cloudflare bundle builds | that it deploys |
| `npm run test:worker` | **22** | yes | built Worker serves the ID-document path (`src/server/id-worker.integration.test.ts`, 180 s timeout) | other routes on the Worker |
| `npm run test:e2e` | 20 | yes | Playwright journeys via `scripts/run-e2e.ts`: 72 spec files, one fresh dev server per spec, 25 Playwright configs | staging behaviour; real devices |
| `bash scripts/preflight-deploy.sh` | after `cf:build` | no | OpenNext middleware-manifest patch marker, Worker output, no foreign dependency paths; must print `PREFLIGHT PASS` | — (required before every staging deploy) |
| `bash scripts/gate.sh [--release] [SHA]` | 20 | yes | one-shot gate (see §5) | independent QA, CEO GO |
| `bash scripts/brand-v2-ci.sh` | 20 | no | three brand-v2 test files | — |
| `bash scripts/pg17-synthetic-rehearsal.sh` | — | own | PG17 restore rehearsal (`docs/pg17-synthetic-rehearsal.md`) | not a merge gate |

Test inventory at `1e0a8ab` (glob count): **357** `*.test.*` files under `src` and `scripts`, of which **154** are `*.integration.test.ts`; **72** e2e specs.
**11 test files are not referenced by any `package.json` script** (e.g. `src/server/org-isolation.integration.test.ts`, `src/server/partner-consent.integration.test.ts`, `src/server/b009-bank-match-owner.test.ts`, `src/components/vendor-document-ui.test.tsx`, three brand-v2 files run by `brand-v2-ci.sh`, two shell tests). Whether each is intentionally excluded is **unverified** — see architecture-map G14.

---

## 5. Running the QA-STANDARD gates locally

### 5.1 One-shot: `scripts/gate.sh`

```bash
# Node 20 active; disposable PG16 running; env from §3 exported; checkout clean and at the candidate SHA.
bash scripts/gate.sh            # npm ci, typecheck, lint, test:unit, copy:check, PG check, test:rls, flag-expiry
bash scripts/gate.sh --release  # adds build, test:worker, test:e2e; forbids an RLS waiver
```

- Requires a **completely clean checkout** (no untracked files) with `HEAD` equal to the candidate SHA; it re-checks at the end.
- Verifies exact Node/npm pins from `ops/toolchain.json`, a local named database, and PostgreSQL 16/17.
- Writes a summary to `e2e/results/gate-<full-sha>.md` and raw logs to a private directory under the Git common dir. Raw logs are unreviewed — sanitize before sharing.
- `--skip-rls "<reason>"` yields `PASS_WITH_RLS_WAIVER`, which **cannot** support a release or a schema/RLS PR.
- The gate does **not** run `test:fn-priv` or `cf:build`. Run those separately (5.2).
- A gate PASS "is evidence, not QA sign-off or deployment authorization" (script usage text).

### 5.2 Step by step (mirrors hosted `ci.yml`, plus the QA-STANDARD extras)

| # | Step | Command | Node |
|---|---|---|---|
| 1 | Clean install | `npm ci` | 20 |
| 2 | Static checks | `npm run typecheck && npm run lint && npm run copy:check` | 20 |
| 3 | Unit | `npm run test:unit` | 20 |
| 4 | Disposable DB + schema + seed | §3 | 20 |
| 5 | Function privileges | `bash scripts/check-function-privileges.sh` | 20 |
| 6 | RLS / integration | `npm run test:rls` | 20 |
| 7 | Flag expiry | via `gate.sh` (hosted `ci.yml` has no separate step) | 20 |
| 8 | Next build | `npm run build` | 20 |
| 9 | Worker bundle | `npm run cf:build` | 22 |
| 10 | Worker test | `npm run test:worker` | 22 |
| 11 | Preflight (before any staging deploy) | `bash scripts/preflight-deploy.sh` → exit 0 and `PREFLIGHT PASS` | after step 9 |
| 12 | e2e | `npm run test:e2e` (all) or `npm run test:e2e -- e2e/<name>.spec.ts` | 20 |

QA-STANDARD items that have **no dedicated script** and must be covered by tests written for the item, with commands recorded:

- anonymous / same-org authorized / same-org unauthorized / cross-org cases, plus sandbox/live separation;
- concurrency, replay and idempotency for financial writes, invitations, notification claims and quota reservations;
- flag OFF and flag ON for each changed journey;
- direct route / API / file authorization and failure states;
- upgrade-state migration replay and previous-green-code-on-new-schema (§3 note);
- screenshots at **390 px and 1280 px** with synthetic data (staging step).

### 5.3 Serial database tests

- All DB tests share **one** database. `test:rls` chains 37 `tsx --test` invocations with `&&`, each `--test-concurrency=1`; the base script chains 106 invocations (70 with `--test-concurrency=1`, the rest single-file). Order and seriality are part of the contract.
- **Do not run two DB suites at once** against the same database (no parallel `test:rls` + `test:e2e`, no second worktree on the same port). Use a second disposable cluster on another port if parallel work is needed.
- `ci-shadow.yml` appends `-- --test-concurrency=4` to `test:unit`, `test:rls` and `test:worker` as a resource cap for the shared Mac. Whether the appended flag reaches more than the last chained invocation, and whether it changes the seriality of the last DB suite, is **unverified** — locally, run `npm run test:rls` without extra flags.
- e2e runs one spec at a time with a fresh dev server per spec (`run-e2e.ts`: a long-lived dev server restarted mid-run on the Mac). `playwright.config.ts` sets `workers: 1`. Stop any other dev server writing the same worktree's `.next` first.
- `run-e2e.ts` turns on `IMPORT_ERROR_DETAILS_ENABLED` and `PAPER_LEASE_VERSIONS_ENABLED` for the child process only, and `ESIGN_ENABLED` only for `e2e/b001-activation.spec.ts`. Do not export those globally.

---

## 6. Hosted CI vs ci-shadow

| | Hosted `ci.yml` | `ci-shadow.yml` (Mac mini) |
|---|---|---|
| Runner | GitHub `ubuntu-latest`, `postgres:16` service on 5432 | self-hosted `condola-macmini`, PG16 via `initdb` on 25432 |
| Triggers | push to any branch, pull_request, workflow_dispatch | push to `main`, workflow_dispatch only — **never** `pull_request*` on self-hosted |
| Node | `.nvmrc` (Node 20) for every step | Node 20, then Node 22 for `cf:build` / `test:worker`, then Node 20 |
| Steps | typecheck, lint, copy, unit, schema+seed, fn-priv, `test:rls`, `cf:build`, `test:worker` | same, with fail-fast toolchain checks and pre/post cleanup |
| e2e | only on workflow_dispatch or PR label `run-e2e` | only on workflow_dispatch |
| Permissions / secrets | no deploy keys | `contents: read`, no secrets, synthetic DB only |
| Concurrency | default | one run at a time per repository; never cancels an in-progress run |
| **Required check** | **Yes** | **No** |

**Status (handoff §6): PENDING runner parity.**

- Required checks **stay on GitHub-hosted CI** until a full parity PASS **and** Ron's switch (which also needs a CEO exact-SHA GO). Do not switch required checks, register runners, change runner config, or change repo visibility.
- Reported in the handoff (not re-verified here): ci-shadow r4 FAIL on 11/12 — PG16 version parse PASS; an RLS flake in `b028-parent-lock-measurement.integration.test.ts` on the push shadow; dispatch Playwright 174 passed / 15 failed / 3 skipped.
- PR #131 (test hardening: b028 lock wait, explicit B-002 skip under ci-shadow, headless Chromium, Mac resource caps) was OPEN when the handoff was written; **it is merged at `1e0a8ab`** (`git log`: "Merge pull request #131"). A parity result on `1e0a8ab` is **unverified**.
- The hosted e2e baseline dispatch named in the handoff has no recorded result here — **unverified**.
- `.depot/workflows/ci.yml` still exists (check job + `deploy-staging` when `STAGING_AUTODEPLOY == 'true'` on a main push). Whether Depot is still connected is **unverified**; production `wrangler.jsonc` sets `STAGING_AUTODEPLOY=false` as a var, and the Depot job reads a repository variable.
- Spend guardrail: Actions spending-limit target is $0; if GitHub reports billing, stop (handoff §5). Note that `ci.yml` runs on every branch push **and** on pull_request, so a PR branch runs twice.

---

## 7. Known flaky or pre-existing failures

Never report these as "pass". A claimed baseline exception needs an exact-SHA independent QA disposition; otherwise the verdict stays INCOMPLETE / NO-GO (QA-STANDARD).

| Item | Symptom | Where seen | Status at `1e0a8ab` |
|---|---|---|---|
| Local `npm run test:worker` | OpenNext `Dynamic require … middleware-manifest.json` → HTTP 500 | local Mac, **observed 2026-11-06, also on `main`** (i.e. not caused by the branch under test) | not re-run for this draft — **unverified today**. Check the Node 22 lane and `preflight-deploy.sh` (it tests for the middleware-manifest patch marker) before treating it as a code defect |
| `b028-parent-lock-measurement.integration.test.ts` | RLS-suite flake on the Mac shadow | handoff §6 (r4) | hardened by PR #131 (lock wait); result on `1e0a8ab` unverified |
| `e2e/b002-retention-http.spec.ts` | needs a private B-002 config absent on the shadow runner | handoff §6 | now an explicit, report-visible `test.skip` under ci-shadow (`e2e/b002-retention-http.spec.ts:27-29`) |
| Shadow Playwright | 15 failed / 3 skipped of 192 on dispatch | handoff §6 (r4) | unverified after PR #131 |
| GUI-session dependency | headed Chromium fails on a headless runner | PR #131 | `headless: true` set in `playwright.config.ts` |

When a new failure appears: record the exact command, exit code, SHA and environment; check whether it reproduces on `main` at the same SHA; do not retry until green and call it a pass.

---

## 8. Evidence a PR must carry

From QA-STANDARD "Evidence and verdict" and handoff §4 / §7. Mac receipts go to hub `20-build/receipts/<item>/` (approved R13) or the app PR body / `e2e-evidence/<ID>/`. Box paths under `/workspace/…` are not reachable from the Mac.

| Evidence | Content |
|---|---|
| Identity | branch (`feat/mac/<item>-<slug>`), **exact full SHA**, story/AC IDs (P51), Class A or B, flags touched and their state (default OFF) |
| `status.md` | timestamp with PT offset, scope, branch/SHA, reserved files, dependencies, commands, next action, blocker references |
| Commands | exact commands, exit codes, environment (Node/npm/PG versions), test counts, failures — from `gate-<sha>.md` or equivalent |
| Hosted CI | link to the green hosted run **on the exact SHA** (required check) |
| `acceptance.md` | each Given/When/Then with result and evidence link, including failure states, permissions and concurrency — not only the happy path |
| Authorization matrix | anonymous, same-org authorized, same-org unauthorized, cross-org, sandbox vs live |
| Flag behaviour | OFF compatibility and scoped ON behaviour |
| Migration / RLS (if any) | clean replay, upgrade replay, previous-green code on new schema, function-privilege result, RLS/grant statement for every new table (post-INC-RLS-1112 default) |
| Preflight | saved output with exit 0 and `PREFLIGHT PASS` (before every staging deploy) |
| Staging | `/api/version` equals the candidate SHA; login, affected portals and changed APIs probed; **zero 5xx**; console/page-error log; screenshots at 390 px and 1280 px incl. empty/error/loading states, zh-TW copy |
| Copy | copy-guard result plus a note on contextual review; no hard-coded prices, 統編, or legal text changes |
| Outbound | statement that tests sent nothing real; mocked delivery not claimed as real delivery |
| `verdict.md` | PASS / NO-GO / INCOMPLETE, exact SHA, tested scope, failures, risks, flag state, migration compatibility, production activation blockers |
| Class B extras | `classb-draft.md`, independent (non-author-model) QA evidence/signature, delta review; security review where flagged (B-056) |
| Step-6 production checklist | migrations, Worker config, secret NAMES only, external-console settings, flag plan, rollback target |

Process reminders:

- Verdicts are bound to a SHA. A docs-only or evidence-only commit does not invalidate a verdict; any code or migration commit does.
- QA model ≠ author model; round 1 lists everything; max 2 rounds; label each condition 阻塞 or 低優先.
- A Mac item reaches staging only after hosted CI green **and** non-author QA on the exact SHA; schema/RLS PRs additionally need a CEO exact-SHA GO before any staging apply. Production is box-PE-only.
- No secrets, tokens, row values, or ID-document photos in any evidence.

---

## 9. Open items for this note

| # | Item | Owner |
|---|---|---|
| T1 | Re-run the full local gate on `1e0a8ab` on the Mac and record results (nothing was executed for this draft) | Mac |
| T2 | Confirm whether local `test:worker` still returns the middleware-manifest 500 under Node 22 at `1e0a8ab` | Mac |
| T3 | Runner parity result after PR #131 merge; hosted e2e baseline result | box PE |
| T4 | Decide whether the 11 unreferenced test files should join a script | CEO / box PE (touches CI contents) |
| T5 | Script for upgrade-state replay and previous-green-code-on-new-schema | proposal via the CI ADR (architecture-map G14) |
| T6 | Is Depot CI still active, and should `.depot/workflows/ci.yml` remain? | CEO / box PE |

*Docs only. Nothing here authorizes a runner, required-check, flag, or configuration change.*

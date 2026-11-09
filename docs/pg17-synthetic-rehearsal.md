# PG17 synthetic rehearsal

Manual GitHub-hosted backup/restore check for frozen product `9ebe581108c1ed6a9b050dc31f429201fb5be781` (tree `e4e4f6ee925127e20ee7aed8654196008cf9f79e`). The workflow file is configuration only. A run checks out that product SHA; it does not test the branch tip.

This is not a release approval, a four-role QA pass, or a production/staging change. Production was last reported at `4aff923`. Do not merge this branch from here, do not dispatch the workflow, and do not register it on `main`.

## Future command

`workflow_dispatch` is available only after this file is on the default branch. Until then the command fails closed. After a reviewed merge, and only then:

```bash
gh workflow run pg17-synthetic-rehearsal.yml --repo ronshih0130/Condola-app --ref main
```

The dispatched ref is the configuration ref. The job still checks out product SHA `9ebe581108c1ed6a9b050dc31f429201fb5be781`.

## What a run does

1. GitHub-hosted `ubuntu-latest`, official image `postgres:17.11@sha256:ff87138949ad9a46f32ff23bd6852b52ce024a13dffe9b4087be98292cdd3b4f` (Docker Hub tag digest and registry `Docker-Content-Digest` matched on 2026-11-08; linux/amd64 manifest `sha256:996e9dc583ba9f0265a2c75547a9c95fb22c251e394749cab205a0a00e1856a1`; image config `PG_VERSION=17.11-1.pgdg13+2`).
2. Node `v20.20.2` / npm `10.8.2` (nodejs.org index for `v20.20.2`) and `npm ci` from that checkout's lockfile.
3. Fresh database `condola_pg17_src` from `supabase/stub/supabase_stub.sql`, every `supabase/migrations/*.sql` file, and `src/server/seed.ts`.
4. `pg_dump -Fc` and `pg_restore --exit-on-error --single-transaction` into fresh `condola_pg17_dst` created from `template0` on the same disposable cluster. `template0` keeps the empty `public` schema because `pg_dump` does not recreate it.
5. Compare counts, content hashes, sequence `last_value` and `is_called`, columns, constraints, indexes, views, functions, triggers, ACLs, default ACLs, RLS flags, policies, extensions, and comment hashes. Owner-only privileges stored as NULL or as `acldefault` compare as the same default. Live column order ignores dropped-column `attnum` holes, which `pg_dump` does not preserve. `CHECK` text is compared after flattening associative `AND`/`OR` parentheses; regrouping those operators still fails the diff. The uploaded file is `pg17-rehearsal-out/summary.json` only, kept 1 day. The dump stays in the container and is deleted. No row payloads, env files, or tokens are uploaded.

Cluster roles (`anon`, `authenticated`, `service_role`) are created by the stub and are not inside a single-database dump. Object grants to those roles are in the dump and are compared. A second cluster is not part of this rehearsal.

Ephemeral `ID_DOC_*` values are generated only for the seed process. The script exits if those names, `DATABASE_URL`, or cloud/prod URL names are already set. Loopback and the two synthetic database names are fixed. `CONDOLA_ENV` of `production`, `staging`, or `staging-real` is refused.

## Stop conditions

- Do not dispatch during review, and do not merge to `main` to make dispatch work.
- Do not push `ops/t0-dump-run`. That branch workflow reads `PROD_DB_URL_SESSION`.
- Do not add the `run-e2e` label. Existing CI would then run the full browser suite, including excluded local stacks.
- Stop if the product SHA or tree, Node/npm, or image digest does not match the pins above.
- Stop if the fingerprint mismatches. A mismatch is a failed rehearsal, not a fix-forward against a live database.
- Stop before any default-branch merge while `STAGING_AUTODEPLOY` is UNKNOWN and the Depot connection is UNVERIFIED. See the guard proposal below.
- A green summary does not accept management, tenant, owner, or vendor, and it does not move flags.

## Product roles

Management, tenant, owner, and vendor are the four product surfaces. Seed staff roles `admin`, `manager`, `accountant`, `maintenance`, and `coastAdmin` are management-side staff, not substitutes for the other three surfaces. `src/server/ids.ts` has no vendor login; the demo seed inserts a vendor contact only.

| Surface | Existing source at `9ebe581` | This rehearsal |
| --- | --- | --- |
| management | `e2e/portfolio.spec.ts`, `e2e/reports.spec.ts`, `e2e/existing-tenant.spec.ts`, `e2e/cards.spec.ts` | Not run. Prior design notes treat these as existing build-only coverage with flags OFF, not as a new runtime pass. |
| tenant | `e2e/tenant-pay.spec.ts`, `e2e/portal-invite.spec.ts` | Not run. No accepted end-to-end binding is added. |
| owner | `e2e/portal-invite.spec.ts`; `e2e/b013-owner-policy-local.spec.ts`; `e2e/b013-owner-override-local.spec.ts`; `e2e/b014-owner-transfers.spec.ts` | Not run. B013 and B014 stay excluded and OFF. `cards.spec.ts` also signs into an owner statements page; that is not a separate owner acceptance. |
| vendor | `e2e/vendor-repair.spec.ts` | Not run. One manager-dispatch path is not a vendor-surface acceptance. |

`scripts/run-e2e.ts` runs the whole browser tree, including those excluded specs, and turns feature flags on inside some of them. This workflow does not call it, `npm run test:rls`, or `npm run test:worker`. The existing public CI run `42456553400` attempt 2 already passed those PG16 checks, including the worker. This rehearsal does not repeat them and does not claim PostgreSQL 17 product QA.

The comparator blob `7b774195` cited by earlier design notes is not in this repository at `9ebe581`. `scripts/pg17-restore-compare.sql` is the missing comparator, not a claim that the old blob was reused.

## Trigger and cost

| Event | Effect of this branch | Deploy | Cost |
| --- | --- | --- | --- |
| Push of this non-main branch | `.github/workflows/ci.yml` runs (`push` branches `"**"`). Browser steps stay off unless the PR is labeled `run-e2e`. | No deploy job in that file. | Existing public GitHub-hosted CI. Public-repo minutes are not a new paid service. The last `main` run took 44m25s. |
| Opening the PR | The same GitHub CI runs again on `pull_request`. | No. | Second public CI run. Unavoidable with the current triggers. `[skip ci]` is not used. |
| `.depot/workflows/ci.yml` | Also declares `push` `"**"` and `pull_request`, but GitHub Actions does not run `.depot` workflows. A run requires the Depot app. | `deploy-staging` needs `push` and `refs/heads/main` and `vars.STAGING_AUTODEPLOY == 'true'`. This ref fails the `main` check even if the variable is true. | Depot connection is UNVERIFIED. No Depot check exists on `9ebe581` (only GitHub Actions app `15368`). If an app is already installed, the existing check job could spend Depot minutes. This PR does not install Depot. |
| `STAGING_AUTODEPLOY` | Not queried again. The recorded GET is HTTP 404, so the value is UNKNOWN, not false. | Unknown variable does not make a non-main ref deploy. | No change to the variable. |
| Repository hooks | This token received HTTP 403 listing hooks. An earlier read returned `[]`. Neither result proves a GitHub App is absent. | No new webhook is registered. | No integration change. |
| `.github/workflows/t0-dump.yml` | Absent at `9ebe581` and absent on this branch. Triggers are `workflow_dispatch` and push to `ops/t0-dump-run` only, and that job uses `secrets.PROD_DB_URL_SESSION`. | Not run by this push. | Do not push that branch. |
| This new workflow | `workflow_dispatch` only. It is not registered until it exists on `main`. | No deploy steps, no `environment`, no `secrets` expressions, `deployments: none`, `id-token: none`. | Does not run for this PR. A future dispatch uses one public hosted runner and the public Postgres image. |

The rehearsal token is `contents: read` and `actions: none`. `setup-node` dependency caching and `actions/upload-artifact` use the Actions API; once a workflow sets any permission, an omitted `actions` scope is none, and saving a cache or uploading an artifact needs `actions: write`. That scope is not limited to one summary file, so those two features are not used. The sanitized JSON is appended to the job step summary, which is a runner file and does not write through the token. The hosted runner still has outbound network. A read-only contents token does not turn that off and does not, by itself, prove a later edit cannot reference secrets. The script rejects inherited secret names. `persist-credentials` is false. `GITHUB_TOKEN` is still injected by GitHub with the scopes above and is not printed.

GitHub environments on this repo: none returned. Deployments API: empty. No self-hosted runner, paid action, package upgrade, flag edit, or live database change is included.

## Default-branch guard

Merging this work to `main` is a push to `main`. `.depot/workflows/ci.yml` can deploy staging only when Depot runs that file, the push ref is `main`, `STAGING_AUTODEPLOY` is exactly `true`, and the check job sets `staging_deploy=yes`. The variable is still UNKNOWN, not false. This change does not set it and does not call Depot.

`scripts/staging-deploy-guard.sh` prints `skip` only when every changed path is one of the rehearsal or guard files. Any other path, and an empty path list, prints `deploy`. The Depot check step uses that result only on a main push. If the previous SHA is missing or `git fetch` fails, the step leaves the decision at `deploy`, so an unreadable diff does not turn staging deploys off. The step always exits 0 and does not change the existing test, build, or `cf-deploy-staging.sh` steps.

A main push that also changes application code still reaches `deploy-staging` under the original variable check. A push that changes only the listed rehearsal and guard files does not. Depot itself remains UNVERIFIED; this guard is the in-repo condition, not a connection test.

## Evidence

Static checks cover the workflow shape, pins, `bash -n`, and `scripts/staging-deploy-guard.test.sh`. One local synthetic run in this disposable environment, with Node v20.20.2 / npm 10.8.2 and the pinned image, matched the fingerprint: 224 tables, 323 rows, 8 sequences, 287 policies, server `17.11 (Debian 17.11-1.pgdg13+2)`. The apply step printed `SET LOCAL can only be used in transaction blocks` twice. That is the existing `psql -f` shape used by CI, and it did not fail the run. That local run is not GitHub Actions execution of this workflow, not the PG16 RLS/worker/browser baseline, and not management/tenant/owner/vendor acceptance.

No tracked advisory record decides dependency risk for production. Dependabot alerts for this repository are disabled (API HTTP 403, that message). Code-scanning alerts are not readable with this token (HTTP 403). This change does not accept that risk and does not upgrade packages.

The earlier suggestion to acquire ownership from a Cursor Origin checkout is withdrawn. GitHub `ronshih0130/Condola-app` is the source of truth. Do not point this branch at Origin.

Frozen `9ebe581` `scripts/claim.sh` blob `8b2a3109717e7d0af044611fd8a1a75a46d6d165` accepts only Cursor Origin. An unmerged candidate already exists: commit `923283c2ff504dc6806757cf8f1d1620de6df16f` on `ops/claim-github-remote` (2026-11-04, parent `4a80cea5`, claim.sh blob `f242c4afa6bac330e40704273e5467ab826bfe1f`). That parent blob equals the frozen blob. There is no pull request and `docs/DECISIONS.md` still records Origin as canonical, so that commit is not treated as an accepted live tool. This branch copies only its remote check. `scripts/claim-github.test.sh` runs acquire, renew, holder refusal, release, and a forced-failed compare-and-swap against a local bare repository. It does not write the live `ops-lock`.

Adoption after independent review: use a checkout whose fetch and push URLs are exactly one of the four credential-free GitHub forms, then `CONDOLA_SESSION_ID=<uuid> bash scripts/claim.sh acquire repo B <who>`. A URL with an embedded token is refused and is not a workaround. `CLAIM_TEST_ANY_REMOTE` stays a test-only switch.

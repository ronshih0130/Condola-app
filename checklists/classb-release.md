<!-- DRAFT for Ron + CEO approval (2026-10-27 PT). Not committed. -->
# Class B release

Normal Mode B stops at staging. Routine production promotion uses this gate in Mode A when Grok returns.

- Lane / candidate / baseline: `<lane> / <full SHA> / <full SHA>`
- Owner / session / repo generation: `<owner> / <session> / <n>`
- Release slot / previous T+15 PASS: `<slot> / <verdict path>`
- Evidence root: `e2e/results/<lane>/`
- All operational timestamps: PT with offset; full-traffic time also UTC/epoch.

## Prepare and freeze

- [ ] Own repository; reserve implementation, independent QA and monitoring capacity.
- [ ] Resolve Rule 7 claims/dependencies/migration order; freeze candidate and baseline.
- [ ] Codex writes `classb-draft.md` from the canonical template.
- [ ] Record prod plan, approved test organizations, frozen scripts, catalog manifests, lock sampling and applicable e-sign G0–G5.
- [ ] Run `scripts/gate.sh "$SHA"`, build, Worker/browser checks and preview smoke; preserve raw failures and exact-SHA dispositions.
- [ ] Use disposable gate DB; Mode B staging credentials enter through `scripts/secrets-run.sh staging -- <cmd>`.
- [ ] Flags ship OFF; record global kill, overrides, owner/expiry and approved internal access.

## Five conditions

1. [ ] Migration/catalog: use read-only `scripts/prodro.sh`; compare live fingerprint with scratch PostgreSQL 16 from candidate migrations; explain repo-only/prod-only/duplicate entries. No invented ledger; unexplained differences or `skip missing` NOTICE mean NO-GO.
2. [ ] Backup: record fresh backup reference/time, isolated restore verification, evidence and release compatibility.
3. [ ] Counts: record before-counts, approved comparison rules and after-count queries; execution remains pending before deployment.
4. [ ] Rollback: verify baseline SHA, existing Worker version, access, schema compatibility and procedure.
5. [ ] Monitoring: approve harness, baseline, pages/roles, error thresholds, logs and counts; T+0/T+15 verdicts remain pending before execution.

## Approval and production claim

- [ ] Independent QA signs exact SHA/baseline/evidence/limits in `approvals.md`.
- [ ] Conditions 1–4 are ready, including before-counts/after-count plan; condition 5 harness is approved.
- [ ] CEO GO names SHA, baseline and slot; candidate/baseline changes invalidate approvals.
- [ ] Through 2026-11-10, previous queued release has T+15 PASS.
- [ ] Acquire `PROD_LOCK` while owning repo; record lane/SHA/baseline/rollback/phase.
- [ ] Recheck live baseline, approvals and absence of concurrent deployment/DB work.
- [ ] Approved migrations execute on box only under frozen plan; revoke temporary write access afterward.

## Deploy

- [ ] Confirm repo/prod locks and run `TARGET_SHA="$SHA" scripts/deploy.sh production`.
- [ ] Wrapper validates approvals and Worker `condola-prod`, uploads with `wrangler versions upload --env production`, then deploys `"$NEW@100%"`.
- [ ] Record returned versions and actual 100% traffic time; this starts T+15.
- [ ] Check `https://app.condola.app/api/version` three consecutive times against candidate/version records; HTTP success alone is insufficient.

## T+0 and T+15

- [ ] Independent model QA runs frozen `scripts/prod-check.sh` with recorded lane arguments.
- [ ] T+0 checks pages, role/org boundaries, client errors versus baseline, Worker logs, counts and version x3; write `verdict-T0.md`.
- [ ] Above-baseline client errors or unexplained anomalies mean NO-GO.
- [ ] Maintain supervision and both claims throughout monitoring.
- [ ] At ≥900 seconds after full traffic, repeat checks; write `verdict-T15.md` with elapsed time/comparison windows.
- [ ] Complete after-count comparison and monitoring evidence; missing checks cannot be PASS.

## NO-GO / rollback

- [ ] Stop release progression, engage kill switch if applicable and record incident.
- [ ] Unknown cause requires compatible code rollback: `TARGET_VERSION="$ROLLBACK_VERSION" scripts/rollback.sh`.
- [ ] Wrapper validates locks/authorization and runs `wrangler versions deploy "$OLD@100%"`.
- [ ] Verify rollback identity x3, pages, roles, errors, logs and counts; record recovery verdict.
- [ ] DB recovery is fix-forward; no blind reverse migration or production restore.
- [ ] Retain production claim through completed incident resolution; no automatic expiry or mode-switch bypass.
- [ ] Rollback does not satisfy the queue's previous-release T+15 PASS requirement.

## Mode B emergency promotion (Ron only)

- [ ] Restrict to P0 customer-impacting fix or rollback; record Ron's authorization and prefer rollback.
- [ ] For a new fix, require staging-verified exact SHA; hold repo and `PROD_LOCK`, record rollback version and run `scripts/gate.sh --release` plus deploy wrapper.
- [ ] Ron himself creates a Cloudflare Worker-deploy-only token for `condola-prod`, expiry ≤24h; never put it in the staging bundle or persistent configuration.
- [ ] Use rollback wrapper for `wrangler versions deploy <OLD>@100%`, or recorded dashboard Deployments → rollback.
- [ ] Never run DB migrations from Mac; fix-forward waits for A.
- [ ] A model runs T+0/T+15 checks; missing evidence remains unresolved, never PASS.
- [ ] Revoke token after use, remove local copies and record confirmation.
- [ ] Preserve authorization, deployment/recovery evidence and limitations for post-hoc Class B review on Grok's return.
- [ ] Open (PE/QA): implement and test the emergency wrapper and monitoring before relying on this path (scope approved by Ron 2026-10-27 11:44 PT).

## Close

- [ ] Push sanitized verdicts/logs/manifests and PT STOP POINT to Origin.
- [ ] Update HANDOFF, board, production/rollback records and flags; current holder runs `scripts/mirror-github.sh` after pushes.
- [ ] Release prod claim only after T+15 PASS or documented completed incident resolution.
- [ ] Ring changes need separate CEO GO; legal/paid features go to Ron before GA.
- [ ] Record stable-GA time and release-flag deletion deadline (+14 days).

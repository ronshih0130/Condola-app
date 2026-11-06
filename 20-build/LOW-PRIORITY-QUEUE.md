# Low-priority product iteration queue

| 日期 | B 項 | SHA | 事項 | 來源 |
|---|---|---|---|---|
| 2026-11-04 | B-004 | 9638437 (d565c9b8) | `scripts/write-pr-migrations.mjs` does not pin hashes for the edited 151400/151500; only `src/server/fixtures/b017-pre17-source.json` pins them | qa-verdicts-1103/B-004-9638437-verdict.md L1 |
| 2026-11-04 | B-004 | 9638437 | Timeout wrappers were added to 151400/151500 after they were already applied on staging; the edits were not re-run there. Confirm on the next clean apply | qa-verdicts-1103/B-004-9638437-verdict.md L1 |
| 2026-11-04 | B-004 | 2aaf71d | Staff panel is hidden while the tenant ID check blocks signing (`idBlocked`) (已知差異，延後, Ron 01:25 PT) | BLOCKED.md; B-004-staffpanel-verdict.md |
| 2026-11-04 | B-004 | 2aaf71d | `/t/history/<lease>/signed` serves ended leases only, not active ones (已知差異，延後, Ron 01:25 PT). The pending_signature question stays OPEN | BLOCKED.md; B-004-2aaf71d-verdict.md |
| 2026-11-04 | B-004 | 2aaf71d | During a flags-ON rollback, old code (1c8fd07) writes no staff download audit row (accepted in the checklist) | docs/policy/deploy-checklist.md; claude-classb-91b3a41 #5 |
| 2026-11-04 | B-004 | 2aaf71d | Staging B-004 secrets and the platform row are kept as "false" instead of absent (kept per Ron) | B-004-staffpanel-verdict.md E6 |
| 2026-11-04 | B-004 | 2aaf71d | Staff download Cache-Control/nosniff headers were not captured in staging UI evidence (covered by integration tests) | B-004-staffpanel-verdict.md E3 |
| 2026-11-04 | B-006 | 4a80cea | XLSX reader now rejects, even with the flag OFF, files whose row `r` is malformed, non-increasing or out of range, or whose column is out of range. Old reader accepted them. No sample shows impact; check during the customer-sample run | qa-verdicts-1103/B-006-4a80cea-verdict.md QA-01 |
| 2026-11-04 | B-006 | 4a80cea | With global "true" and the org flag OFF, the page/server still query the org; a query failure hides the wizard or fails the import (not fully inert). Not reachable while global is OFF | B-006-4a80cea-verdict.md QA-02 |
| 2026-11-04 | B-006 | 4a80cea | Archive admission/current-caller checks in import-batch (from 6694f042/177bd35f, archive item) not reviewable from the B-006 diff; cover in that item's QA and the batch E2E | B-006-4a80cea-verdict.md QA-03 |
| 2026-11-04 | B-006 | 4a80cea | Route-level auth/consent, `assertImport`, `tx`/RLS and request normalisation not in the diff; cross-org isolation for the ON path backed by integration tests only | B-006-4a80cea-verdict.md QA-04 |
| 2026-11-04 | B-006 | 4a80cea | Ships flag OFF without verification against a customer sample file (Ron 09:28 PT via PE); do that before any flag ON | Ron decision; handoff |
| 2026-11-04 | B-003 | 4a80cea (3c723b3d) | Migrations 100000/100100/100200 lack lock_timeout/statement_timeout (only 100202 has them); keep staging-applied bytes, verify on next clean apply | qa-verdicts-1103/B-003-4a80cea-verdict.md L1 |
| 2026-11-04 | B-003 | 4a80cea (3c723b3d) | 4th migration 20261031100100_audit_action_select.sql not in PE's applied record — RESOLVED 11-04 (PE: applied 10/30, sha 02495ed7); remaining: write prod apply list 100000→100100→100200→100202 | qa-verdicts-1103/B-003-4a80cea-verdict.md L2 |
| 2026-11-04 | B-003 | 4a80cea | audit_payee_number copies unconstrained app.change_reason/app.request_id into audit_log (100000:89-90); not set by current adapter | qa-verdicts-1103/B-003-4a80cea-verdict.md L3 (llm-route r1) |
| 2026-11-04 | B-003 | 4a80cea | No data-preserving rollback procedure for payee_account_numbers; enum 'select' irreversible | qa-verdicts-1103/B-003-4a80cea-verdict.md L4 (llm-route r2) |
| 2026-11-04 | B-009 | 4a80cea (2dea9016) | b009_direct_write_guard bypasses when effective role = function owner (mig 100209:45-48); verify staging owner + gateway connection role before flag ON | qa-verdicts-1103/B-009-4a80cea-verdict.md L1 (llm-route r1) |
| 2026-11-04 | B-009 | 4a80cea (2dea9016) | No reversal procedure for 100209; drop public-table triggers before functions/private tables | qa-verdicts-1103/B-009-4a80cea-verdict.md L2 (llm-route r1) |
| 2026-11-04 | B-003 | 4a80cea | No migration ledger; 100000/100200/100202 not idempotent (re-apply fails loudly) | claude-classb B-003 #3 |
| 2026-11-04 | B-003 | 4a80cea | migration-100100.md ordering rationale misattributed (chain is 100100→100200→100202); fix before writing prod apply list | claude-classb B-003 #4 |
| 2026-11-04 | B-003 | 4a80cea | validatePayee() tested but unused in save path (gateway SQL validates) | claude-classb B-003 #5 |
| 2026-11-04 | B-003 | 4a80cea | ingress consent denials logged as reason='forbidden'; no distinct consent code | claude-classb B-003 #6 |
| 2026-11-04 | B-003 | 4a80cea | payee_bank_guard does not guard direct show_to_tenants toggles (legacy last5 exposure only) | claude-classb B-003 #7 |
| 2026-11-04 | B-003 | 4a80cea | Add explicit same-org tenant A→tenant B lease adversarial test | claude-classb B-003 #10 |
| 2026-11-04 | B-007 | 4a80cea (a214d402) | With the flag OFF, regional hard_block/override_required deposit rules are still enforced. Pre-existing behaviour, not a regression; no such rule is seeded | qa-verdicts-1103/B-007-4a80cea-verdict.md B007-01 |
| 2026-11-04 | B-007 | 4a80cea (a214d402) | The new resolver strictly rejects malformed or negative `max_months` / non-object rule payloads that the old cast may have accepted. Seeded rules are unaffected | B-007-4a80cea-verdict.md B007-02 |
| 2026-11-04 | B-007 | 4a80cea (a214d402) | The migration's approval to drop `leases_deposit_over_cap_requires_override` covers local/staging only (Ron), but the migration has no environment boundary. Prod needs its own authorisation | B-007-4a80cea-verdict.md B007-06 |
| 2026-11-04 | B-002 | 4a80cea (d8725253) | move-out-notice.ts service flag-OFF early return not visible in diff; confirm direct call returns disabled before SQL | qa-verdicts-1103/B-002-4a80cea-verdict.md L1 (llm-route r1) |
| 2026-11-04 | B-002 | 4a80cea | No post-commit rollback for 100203/100206; Worker rollback alone does not undo gate/origin effects | qa-verdicts-1103/B-002-4a80cea-verdict.md L2 (llm-route r1) |
| 2026-11-04 | B-002 | 4a80cea | 20261029160000_lease_close_end_date (3dae1ffa) absent from staging apply-log though objects present | qa-verdicts-1103/B-002-4a80cea-verdict.md L3 |
| 2026-11-04 | B-002 | 4a80cea (77e11278) | Move-out date has no future/before-start bound | qa-verdicts-1103/B-002-4a80cea-verdict.md L4 (handoff) |
| 2026-11-04 | B-002 | 4a80cea | Purge soft-deleted OR branch outside lease-lock condition (precedence); confirm serialization | qa-verdicts-1103/B-002-4a80cea-verdict.md L5 (handoff) |
| 2026-11-04 | B-005 | 4a80cea (db4a1a8) | Signup resend response is uniform but its timing isn't; account state could be inferred from latency (not verified) | qa-verdicts-1103/B-005-4a80cea-verdict.md B005-L2 |
| 2026-11-04 | B-005 | 4a80cea (56460d5) | The always-on `organizations` settings trigger would return 42501 to any future authenticated whole-settings replacement; none exists today | B-005-4a80cea-verdict.md B005-L3 |
| 2026-11-04 | B-008 | 4a80cea (c7feb92) | Flag-OFF same-choice recapture of existing first_period_basis still allowed (100210:48-50) | qa-verdicts-1103/B-008-4a80cea-verdict.md L1 (llm-route r1) |
| 2026-11-04 | B-008 | 4a80cea | No reverse procedure for 100210; dropping column after adoption loses bases | qa-verdicts-1103/B-008-4a80cea-verdict.md L2 (llm-route r1) |
| 2026-11-04 | B-008 | 4a80cea | inclusiveDays/monthBounds boundary (leap Feb, short lease) not re-reviewed | qa-verdicts-1103/B-008-4a80cea-verdict.md L3 (llm-route r3) |
| 2026-11-04 | B-008 | 4a80cea (5899c96) | Statement math uses Number without explicit safe-integer guard (unchanged from legacy) | qa-verdicts-1103/B-008-4a80cea-verdict.md L4 (handoff) |
| 2026-11-04 | B-008 | 4a80cea (bb45158) | Move-in utility selection: no period filter / equal-amount tie-break | qa-verdicts-1103/B-008-4a80cea-verdict.md L5 (handoff) |
| 2026-11-04 | batch | 4a80cea | During the deploy→Phase 3 window these protections are absent: archived-lease PDF guard (100224), reason CHECKs (100222/100223), esign read-policy tightening (100201), invoices unique index (100216). Keep the window short | batch-prod-apply-list-check-1104.md (old-Worker review) |
| 2026-11-04 | B-011 | 4a80cea | 100214: non-idempotent, do not blind-retry; MIME assertion order-sensitive; silent pass if storage absent | qa batch-prod-apply-list-check-1104 (2) |
| 2026-11-04 | B-003 | 4a80cea | 100000/100200 wrapper (no BEGIN) to be covered by single-transaction condition | qa batch-prod-apply-list-check-1104 (3c) |
| 2026-11-04 | B-010 | 4a80cea (40f30a4) | Cron: local runner error → HTTP 500 skips legacy runDueReminders; verify runner cannot throw with flags OFF | qa-verdicts-1103/B-010-4a80cea-verdict.md L1 (llm-route r1) |
| 2026-11-04 | B-010 | 4a80cea | Confirm payment-context actor init uses auth.uid() (100212:341) and DB guards inside service-only manual/claim functions | qa-verdicts-1103/B-010-4a80cea-verdict.md L2 (llm-route r2) |
| 2026-11-04 | B-010 | 4a80cea | Confirm finish functions/claim tables store no rendered name/email/amount | qa-verdicts-1103/B-010-4a80cea-verdict.md L3 (llm-route r2) |
| 2026-11-04 | B-010 | 4a80cea (7d7047e) | 100217 replacement center CHECK vs existing center rows; app-table triggers inert when OFF | qa-verdicts-1103/B-010-4a80cea-verdict.md L4 (llm-route r2) |
| 2026-11-04 | B-010 | 4a80cea | Capture 100 claims/call, same-day retries only; no cross-day recovery | qa-verdicts-1103/B-010-4a80cea-verdict.md L5 (handoff) |
| 2026-11-04 | B-010 | 4a80cea | New manual request ID can create another reminder event (dup-send risk once provider exists) | qa-verdicts-1103/B-010-4a80cea-verdict.md L6 (handoff) |
| 2026-11-04 | batch | 4a80cea | Runbook: state whether 100223+100224 go as one request; add deploy-failure row; add re-block threshold | qa batch-prod-apply-list-check-1104 (11:15 a1/d2/d3) |
| 2026-11-04 | B-010/B-009 | 4a80cea | Unguarded calls to held objects that fail gracefully or sit on new routes: manual-reminders b010_manual_reminder, request-status b010_payment_command_status, bank-matching b009 (check flag gate) — add to smoke expected-unavailable | qa batch-prod-apply-list-check-1104 (11:15 b2) |
| 2026-11-04 | batch | — | Build and dry-run the 503 zone rule; pre-write the on/off steps; check the cron gap at window end | qa batch-prod-apply-list-check-1104 (11:15 c2/c3) |
| 2026-11-04 | batch window | 4a80cea | c1 entry-point blocking/probing, window length, cron gap (Ron 11:19 downgrade) | QA apply-list check |
| 2026-11-04 | batch | 4a80cea | d1 residue: per-file runner transaction requirement; INVALID CIC index still enforces on writes; skip 100211/100213 if 100201 fails; re-grep evidence after fallback commit | qa batch-prod-apply-list-check-1104 (11:20 d1-r1..r3) |
| 2026-11-04 | batch | c011e91 | Prod Worker 223 commits behind main: check main-only assumptions in the B-items | qa batch-prod-apply-list-check-1104 (11:20 v2) |
| 2026-11-04 | batch | c011e91 | Fix 11:17 "ancestor of main" note (no merge base); reconcile 440 vs 415+9 commit count; verify the 12 differing main migrations are Version-comment only | qa batch-prod-apply-list-check-1104 (11:26 (2)) |
| 2026-11-04 | batch | c011e91 | Annotate B-item verdicts citing 2bedb89 as re-checked vs c011e91; re-check 100205/100212 vs the prod Worker at release | qa batch-prod-apply-list-check-1104 (11:26 (1)) |
| 2026-11-04 | batch | — | Test accounts: confirm signup yields a sandbox org; label the fake lease/payments 內部測試; add vendor/repair + import diagnostics to smoke | qa batch-prod-apply-list-check-1104 (11:26 r6/t1/t2) |
| 2026-11-04 | cutover-smoke | 4a80cea (stg-rehearsal2) | r5.pdf test expects PDF/HTML but /api/pdf/leases returns JSON by design; assert JSON doc fields + footerHash + no-store, keep content-type note | qa-verdicts-1103/cutover-smoke-review-1104.md (4) |
| 2026-11-04 | cutover-smoke | 4a80cea | pageCheck items are 200-only; add a data assertion per route; r4./consent passed on redirect to /t | qa-verdicts-1103/cutover-smoke-review-1104.md (1) |
| 2026-11-04 | cutover-smoke | 4a80cea | Manual items lack pass criteria (r1.login-page ×2, r5.move-out) or are vague (r2.csv, r4.staff-photo); r1.line / degrade.reminder automatable | qa-verdicts-1103/cutover-smoke-review-1104.md (2) |
| 2026-11-04 | cutover-smoke r2 | 4a80cea | r5.pdf: footerHash optional, no lease-identity field asserted (claim "lease fields + footer hash" unmet) | cutover-smoke-review-1104.md R2 |
| 2026-11-04 | cutover-smoke r2 | 4a80cea | Payee no-body POST via context.request bypasses route guard; readonly run writes denial audit rows; payeeDenialArmed dead for this path | cutover-smoke-review-1104.md R2-3 |
| 2026-11-04 | cutover-smoke r2 | 4a80cea | readIdentity body-text regex fallback for org id/env; require testid selectors on prod | cutover-smoke-review-1104.md R2-4 |
| 2026-11-04 | cutover-smoke r2 | 4a80cea | SMOKE_ALLOW_LIVE_ORG=1 global; bind to org UUID | cutover-smoke-review-1104.md R2-5 |
| 2026-11-04 | B-010 r2 | 5631ce2 | OFF→ON enable race: op that read OFF proceeds unprotected; document drain step in rollout runbook (blocking only for ON) | B-010-4a80cea-verdict.md R2 |
| 2026-11-04 | B-007 r2 | d6aea34 | Old Worker gets raw 55P03 after 3×2s bounded retries (no mapping) | B-007-4a80cea-verdict.md R2 |
| 2026-11-04 | B-007 r2 | d6aea34 | Trigger still calls effective_rule for legacy overrides while OFF (rule_id only) | B-007-4a80cea-verdict.md R2 |
| 2026-11-04 | B-007 r2 | d6aea34 | No updateLease/signLease lock-exhaustion tests (Claude optional) | B-007-4a80cea-verdict.md R2 |
| 2026-11-04 | B-002 r2 | cf701e1 | id_photo_gate env=sandbox + NULL org denies sandbox staff (fail-closed) | B-002-4a80cea-verdict.md R2 |
| 2026-11-04 | B-002 r2 | cf701e1 | Backfill UPDATE fires audit/updated_at lease triggers (audit rows; stale updatedAt once) | B-002-4a80cea-verdict.md R2 |
| 2026-11-04 | B-002 r2 | cf701e1 | Terminated/closed origin-unknown leases keep photos hidden; operator path needed before ID_PURGE ON | B-002-4a80cea-verdict.md R2 |
| 2026-11-04 | B-005 r2 | 41d024a | Invitation audit mask trusts '***@' / any '*' / short phone; invitations.email/phone have no CHECK — redact non-matching shapes | B-005-4a80cea-verdict.md R2 |
| 2026-11-04 | B-005 r2 | 41d024a | actor_role=current_user is definer role in SECURITY DEFINER; check fn_audit parity | B-005-4a80cea-verdict.md R2 |
| 2026-11-04 | B-005 r2 | 41d024a | Masking fallback path untested | B-005-4a80cea-verdict.md R2 |
| 2026-11-04 | B-008 r2 | 8fc6de1 | loadRun correctionAvailable ignores record_archive (UI offers correction server rejects) | B-008-4a80cea-verdict.md R2 |
| 2026-11-04 | B-008 r2 | 8fc6de1 | record_archive flag read unlocked (admission-time); document OFF suspends archived corrections | B-008-4a80cea-verdict.md R2 |
| 2026-11-04 | B-009 r2 | 86b68b7 | Unconditional LOCK TABLE platform_settings SHARE before flag check in b009_direct_write_guard (pre-existing 100209:48) | B-009-4a80cea-verdict.md R2 |
| 2026-11-04 | B-009 r2 | 86b68b7 | Owner taken from bank_transactions for 4 guarded tables; no differing-owner test | B-009-4a80cea-verdict.md R2 |
| 2026-11-04 | B-009 r2 | 1d25235 | Existing free-text reasons rewritten to 'other' (staging test rows only) | B-009-4a80cea-verdict.md R2 |
| 2026-11-04 | R1 | c011e91→d6aea34 | session.email null when unconfirmed; confirm email-code/LINE accounts unaffected; owner layout unconditional ownerRepairPolicyEntryIds | batch-prod-apply-list-check-1104.md R1–R5 |
| 2026-11-04 | R2 | c011e91→d6aea34 | Tenant bill keeps residual 沖銷電費 credit row (display change, flags OFF) — owner acceptance | batch-prod-apply-list-check-1104.md R1–R5 |
| 2026-11-04 | R3 | c011e91→d6aea34 | Staff signed PDF now env-gated + admin/manager only (accountant loses access when ON) | batch-prod-apply-list-check-1104.md R1–R5 |
| 2026-11-04 | R3 | c011e91→d6aea34 | Applied migration 20261030151400 rewritten re-run-safe; replay restores older function body | batch-prod-apply-list-check-1104.md R1–R5 |
| 2026-11-04 | R4 | c011e91→d6aea34 | serveSignedPhoto headers/no-store and preferredOrg handling unverified in excerpt | batch-prod-apply-list-check-1104.md R1–R5 |
| 2026-11-04 | R5 | c011e91→d6aea34 | lease-terms-form blocks submit while policy null, no retry; import paths with non-monthly frequency deposit calc | batch-prod-apply-list-check-1104.md R1–R5 |
| 2026-11-04 | apply list | 4a80cea | 12 applied migrations lost '-- Version' line + 151400/151500 rewritten: sha drift vs prod; confirm runner tracks by version | batch-prod-apply-list-check-1104.md R1–R5 |
| 2026-11-04 | batch | — | d1 row 100204 says "TENANT_SIGNED_PDF off"; update to env=true; hub sha inventory for 12 drifted + 151400/151500 files | qa batch-prod-apply-list-check-1104 (14:53 1/5) |
| 2026-11-04 | batch | a801fbb | Optional fresh prod dump for exact rehearsal; list 30 baseline migrations in apply list; conflict-resolved write-pr-migrations.mjs / lease-rules.test.ts not separately reviewed | qa final sign-off 1104 |
| 2026-11-04 | B-010 | 29fa8a67 | NOWAIT doesn't cover implicit relation locks; runbook: no DDL while flags ON | llm-route rc5 r1 #1 |
| 2026-11-04 | B-010 | 29fa8a67 | Polling ~120 subtx under contention; benchmark | llm-route rc5 r1 #3 |
| 2026-11-04 | B-010 | 29fa8a67 | Functional coverage gaps (confirm/reject/revocation/reminder UPDATE/DELETE) | llm-route rc5 r1 #4 |
| 2026-11-04 | B-010 | 29fa8a67 | Brief says NOWAIT removed; actually kept with polling (wording) | QA |
2026-11-04 | B-010 | 4aff923 | deploy branch carries WIP commit 32b70f0 (test-only); retain detailed S1 diagnostics | QA deploy-build check
| 2026-11-05 | B-011 | 8e34075 | Currency/scale/header-child consistency not enforced while inert (verdict #2); money-critical if enabled with inconsistent arithmetic | qa-verdicts-1103/B-011-8e34075-verdict.md #2 |
| 2026-11-05 | B-011 | 8e34075 | Completed-upload ownership / path binding / verified metadata not implemented (verdict #8); inherited hash/MIME only partial | qa-verdicts-1103/B-011-8e34075-verdict.md #8 |
| 2026-11-05 | B-011 | 8e34075 | F4: migration UNIQUE/FK on lease_charges takes ACCESS EXCLUSIVE; record lock time on T0 prod-dump rehearsal before prod apply | qa-verdicts-1103/B-011-8e34075-verdict.md F4 |
| 2026-11-05 | B-011 | 8e34075 | F5: immediate constraint validation assumes empty payments/confirmations; confirm on existing-row baseline before prod apply | qa-verdicts-1103/B-011-8e34075-verdict.md F5 |
| 2026-11-05 | B-011 | 8e34075 | F6: unit tests cover disabled + SQL text only; insufficient for activation (enabled money/auth/concurrency/DB) | qa-verdicts-1103/B-011-8e34075-verdict.md F6 |
| 2026-11-05 | PROP-11 | 5f9cc01 | Composite FKs enforce org but not ticket agreement (allocation/item/document/job can mix tickets in same org) (`20261105160000_prop11_repair_cost_foundation.sql`:25-27,60-62,87-91,110-113) | qa-verdicts-1103/PROP-11-5f9cc01-verdict.md #1 |
| 2026-11-05 | PROP-11 | 5f9cc01 | owner_statement_line_id is soft (no FK); consumer must validate org/source (`20261105160000_prop11_repair_cost_foundation.sql`:94-103) | qa-verdicts-1103/PROP-11-5f9cc01-verdict.md #2 |
| 2026-11-05 | PROP-11 | 5f9cc01 | tenant_period_due_components UNIQUE allows duplicates when source_ref_id IS NULL; aggregation semantics undefined (`20261105160000_prop11_repair_cost_foundation.sql`:146-151) | qa-verdicts-1103/PROP-11-5f9cc01-verdict.md #3 |
| 2026-11-05 | PROP-11 | 5f9cc01 | Currency free text; no ceilings/consistency/aggregate caps (`20261105160000_prop11_repair_cost_foundation.sql`:18-19,141-145) | qa-verdicts-1103/PROP-11-5f9cc01-verdict.md #4 |
| 2026-11-05 | PROP-11 | 5f9cc01 | UPDATEs unaudited, no transition/finalization guard; correction reason may be empty/omitted (`20261105160000_prop11_repair_cost_foundation.sql`:41-46,59,180-188) | qa-verdicts-1103/PROP-11-5f9cc01-verdict.md #5 |
| 2026-11-05 | PROP-11 | 5f9cc01 | Evidence ownership/storage/MIME/hash/photo classification unenforced (`20261105160000_prop11_repair_cost_foundation.sql`:65-86) | qa-verdicts-1103/PROP-11-5f9cc01-verdict.md #6 |
| 2026-11-05 | PROP-11 | 5f9cc01 | service_role not tenant-isolated; visibility rows don't enforce viewer/vendor/accountant-photo rules (`20261105160000_prop11_repair_cost_foundation.sql`:116-188) | qa-verdicts-1103/PROP-11-5f9cc01-verdict.md #7 |
| 2026-11-05 | PROP-11 | 5f9cc01 | Residual: local PG17 repair-cost.rls.test.ts NOT MET (staging privilege readback used instead) | qa-verdicts-1103/PROP-11-5f9cc01-verdict.md #8 |
| 2026-11-05 | PROP-11 | 5f9cc01 | (out of scope) GitHub CI cancelledByParent, same as #19/#21 | qa-verdicts-1103/PROP-11-5f9cc01-verdict.md #8 |
| 2026-11-05 | PROP-11 | 5f9cc01 | Writer-activation conditions W1-W7 recorded for B-013/B-021 (阻塞 at writer activation) | qa-verdicts-1103/PROP-11-5f9cc01-verdict.md "Writer-activation conditions" |
| 2026-11-05 | PROP-08 | 9b29a46 | Locale/timezone validated by truthiness only; invalid non-empty values returned (`localization.ts:67-72`) | qa-verdicts-1103/PROP-08-9b29a46-verdict.md #1 |
| 2026-11-05 | PROP-08 | 9b29a46 | Jurisdiction cycles silently truncated (rule from partial chain may return); not rejected (`localization.ts:105-121`) | qa-verdicts-1103/PROP-08-9b29a46-verdict.md #2 |
| 2026-11-05 | PROP-08 | 9b29a46 | Jurisdiction ancestry traversal has no explicit depth limit (`localization.ts:105-112`) | qa-verdicts-1103/PROP-08-9b29a46-verdict.md #3 |
| 2026-11-05 | PROP-08 | 9b29a46 | Residual: tests are SQL-text only; PG17 localization.rls/jurisdiction integration deferred; CI pending | qa-verdicts-1103/PROP-08-9b29a46-verdict.md #4 |
| 2026-11-05 | PROP-08 | 9b29a46 | B-032 activation conditions A1-A5 recorded (session-derived org; currency match + minorUnit→displayDecimals; locale/tz validation + null jurisdiction; PG17 precedence/isolation tests; separately reviewed rewiring) | qa-verdicts-1103/PROP-08-9b29a46-verdict.md "Activation conditions for B-032" |
| 2026-11-05 | B-013 | b811f80 | Session environment not checked in `b013_actor` (W7 PARTIAL); verify before activation — demonstrated cross-env bypass = 阻塞. B-021 readers bind org/env (addendum); write gateways remain ON-gate | qa-verdicts-1103/B-013-b811f80-verdict.md 低優先 #1 |
| 2026-11-05 | B-013 | b811f80 | Appointment→vendor-job tenant/ticket integrity gateway-only (single-column FK, W1 PARTIAL); B-021 adds BEFORE INSERT guard trigger | qa-verdicts-1103/B-013-b811f80-verdict.md 低優先 #2 |
| 2026-11-05 | B-013 | b811f80 | Photo refs accept extra fields/arbitrary IDs; readers must enforce storage authz + safe projection (B-021/024/028) | qa-verdicts-1103/B-013-b811f80-verdict.md 低優先 #3 |
| 2026-11-05 | B-013 | b811f80 | FK creation may briefly block hot parents; measure parent FK lock time on T0 rehearsal (rehearsal-blockers.md) | qa-verdicts-1103/B-013-b811f80-verdict.md 低優先 #4 |
| 2026-11-05 | B-013 | b811f80 | Security-definer safety conditional on `public`/`app` CREATE privileges restricted to trusted roles (schema ACLs not supplied) | qa-verdicts-1103/B-013-b811f80-verdict.md "Security-definer safety" |
| 2026-11-05 | B-013 | b811f80 | OFF still writes `rejected_disabled` command-ledger rows; replay precedes flag check (may return earlier success while OFF) — confirm intended before activation | qa-verdicts-1103/B-013-b811f80-verdict.md "OFF behavior" |
| 2026-11-05 | B-021 | 3d31326 | POST buffers full body before 20k char limit check (memory before 413); prefer bounded reader / upstream byte limit | qa-verdicts-1103/B-021-3d31326-verdict.md 低優先 |
| 2026-11-05 | B-021 | 3d31326 | Write-side `b013_actor` environment check carried (not cleared by readers) — ON-gate before activation | qa-verdicts-1103/B-021-3d31326-verdict.md B-013 ON-gates |
| 2026-11-05 | B-021 | 3d31326 | OFF `rejected_disabled` ledger write on owner POST carried via B-013 gateway — confirm intended before activation | qa-verdicts-1103/B-021-3d31326-verdict.md B-013 ON-gates |
| 2026-11-05 | B-021 | 3d31326 | Storage photo authorization carried (id-only projection only) — ON-gate | qa-verdicts-1103/B-021-3d31326-verdict.md B-013 ON-gates |

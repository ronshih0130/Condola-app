# Staging DB plan — core89 @ condola-app 4e43104 (PE, 2026-10-30)

Target: STAGING only, Supabase project ref `kodvasnrzprpzcsyjknf` (creds: `/home/box/.secrets/condola_staging.env`, vars SUPABASE_URL / DATABASE_URL_SESSION; mgmt API via `/workspace/sbq.sh`, ref hardcoded to staging). PROD ref `yfijvcgpubzmqrgnapzd` is never touched; every write is preceded by a ref guard.
Handoff: /workspace/mode-b-bootstrap/staging-core89-handoff.md. Analysis via llm-route codex (task `staging-core89-diff`): staging-db-evidence/codex-diff.md.

## Current state (read-only, 05:40–06:00 PT)
- No migration ledger: `supabase_migrations.schema_migrations` absent (also no condola_ops ledger). History only in /workspace/migrations-applied.md (manual mgmt-API applies).
- Direct Postgres (DATABASE_URL_SESSION, pooler :5432) times out from box → all ops via Supabase Management API `database/query` (staging ref).
- Catalog snapshot (schema-only substitute for pg_dump, which cannot connect): staging-db-evidence/{columns,constraints,indexes,functions,triggers,policies,buckets,relations,types,schemas,roles,default_acl}.json; full pre-apply function defs + ACLs: pre-functiondefs.json; row counts: pre-rowcounts.json; identity_documents.delete_after pre-image: pre-iddoc-delete_after.json.
- Key counts pre: properties 208, units 644, leases 883, identity_documents 10, payments 1. Schema `app` has 0 tables (all 25 app.* tables of the b0xx files absent). platform_settings has only go_live_lock, id_documents.max_retention_days_after_close (billing_previews absent).

## Diff (89 files at 4e43104)
- 80 sources verified by git blob SHA (65 from local repos, 15 fetched from Origin); 9 base files (20261018…–20261022170000) not on box → assumed applied (bootstrap), equivalence UNKNOWN.
- Codex classification per file in codex-diff.md: ~60 APPLIED; 29 to apply (26 required + C1/C2/C3, all three resolved to INCLUDE: revokes idempotent, billing_previews absent).
- Known drift not fixed by this plan: function md5 drift on public.condola_set_unit_import_address_key, public.condola_sync_unit_address_keys (fixed by bulk_import replay), app.end_auth_sessions (fixed by 20261030151100).

## Ordered migrations to apply (staging-db-evidence/apply-order.txt)
1 20261024100000_revoke_truncate (C1) · 2 20261026130000_bulk_import · 3 20261030130000_default_function_privileges (C2) · 4 20261030151100_end_auth_sessions_varchar_fix · 5 20261030151200_id_purge_dry_run_guard · 6 20261030151300_partner_agreement_consents · 7 20261030151301_partner_consent_attestation · 8 20261030151400_tenant_signed_pdf_read · 9 20261030151500_paper_lease_versions · 10 20261030151600_esign_retention_lifecycle · 11 20261031090000_id_delete_after_move_out · 12 20261031100000_payee_details · 13 20261031100100_audit_action_select · 14 20261031100200_tenant_payee_read · 15 …100201_b001_esign_internal_helpers · 16 …100202_b003_payee_gateway · 17 …100203_b002_retention_boundary · 18 …100204_b004_paper_delivery_boundary · 19 …100205_b007_deposit_rules · 20 …100206_b002_legacy_open_moveout · 21 …100207_b005_onboarding_progress · 22 …100208_b008_billing_previews (C3) · 23 …100209_b009_bank_match_decisions · 24 …100210_b008_first_period_basis · 25 …100211_b001_esign_activation · 26 …100212_b010_b028_local_events · 27 …100213_b001_zero_first_invoice · 28 …100214_b011_handover_records · 29 …100215_b028_center_foundation

## Pre-checks
- Ref guard before each write: script target ref == kodvasnrzprpzcsyjknf and != yfijvcgpubzmqrgnapzd, else abort.
- Destructive scan: no top-level DROP TABLE/COLUMN, TRUNCATE or DELETE in any of the 29 files; all DELETEs are inside function bodies (runtime purge/disposal, not executed by the migration). Immediate data rewrites: bulk_import (fills NULL address keys), id_purge_dry_run_guard and id_delete_after_move_out (recompute identity_documents.delete_after; pre-image saved). b007_deposit_rules drops an old CHECK + trigger (replaced by function/trigger enforcement; no data loss). b001_esign_activation adds a unique move-in invoice index (fails if duplicates exist → stop).
- Each file applied as one mgmt-API batch, stop on first error (no partial continue).

## Rollback notes
- No down migrations. Pre-apply function defs/ACLs (pre-functiondefs.json) and constraint/trigger/policy snapshots allow manual restore; delete_after pre-image allows restoring dates. New app.* tables/new columns are additive (drop only if unused). Enum label 'select' (audit_action) and 'imported' (esign_status) cannot be dropped simply. DB policy is fix-forward (PRINCIPLES 6).

## Verification queries
- Per-file marker objects present (codex-diff.md "Read-only pre-check and post-apply SQL"); app.* tables count = 25; platform_settings billing_previews present; row counts of properties/units/leases/identity_documents/payments unchanged; function md5 drift for the 3 functions resolved; anon/authenticated have no EXECUTE on new app.* helpers.

## Results (applied 2026-10-30 05:42–05:43 PDT, STAGING kodvasnrzprpzcsyjknf only; prod not touched)
- All 29 files in apply-order applied via Management API, each HTTP 201, ref guard passed before every write. Per-file log with sha256 prefix: staging-db-evidence/apply-log.txt.
- Verification (staging-db-evidence/post-verify.json): app.* tables 25 (was 0); platform_settings.billing_previews present; row counts unchanged (properties 208, units 644, leases 883, identity_documents 10, payments 1); properties with NULL address_key 0; app.end_auth_sessions md5 0b17f0e1… and public.condola_sync_unit_address_keys md5 101bd8f9… = Codex-reconstructed 4e43104 targets (drift resolved); audit_action 'select' label present; handover bucket present; 0 app functions executable by anon; identity_documents.delete_after changed 0/10 vs pre-image.
- Final migration history: staging still has no Supabase ledger (not created, to avoid an out-of-plan write). Authoritative history = /workspace/migrations-applied.md (entry appended) + apply-log.txt. Effective staging state = all 89 core89 files (80 verified by blob SHA; 9 base files assumed present, UNKNOWN equivalence).
- Open items: schema-only pg_dump not possible (pooler :5432 timeout from box) → catalog JSON snapshot used instead; post-apply verification was catalog checks run by PE, a Codex full re-diff via llm-route is recommended before staging deploy; handoff gates (independent Claude Class B, TRAIN/GATE-B, e-sign gates) still outstanding; this is not a staging/release GO.

## Gates (2026-10-30 ~05:50 PDT)
### Claude Class B (llm-route claude, task staging-core89-classB) — **PASS** (0 BLOCKER, 3 MAJOR, 2 MINOR)
- Evidence: staging-db-evidence/claude-classB-r1.md.
- MAJOR 1 (process): applied before this review; handoff required Class B first. Not fixable after the fact. For prod, run Class B before any apply.
- MAJOR 2 (verification gaps) — closed by read-only re-checks (staging-db-evidence/post-verify-security.json, post-default_acl.json): 0 SECURITY DEFINER functions in public/app that anon can execute; 0 app.* tables that anon/authenticated can SELECT; anon has no USAGE on schema app. 24 tables have no RLS (18 app.* b0xx tables + 6 pre-existing public signup/partner tables). This matches the 4e43104 source (no ENABLE RLS in the source; the tables have no client grants). Not changed, so staging stays equal to source. Default function ACL for supabase_admin in public still grants clients: this is a platform limitation that C2 itself catches and skips.
- MAJOR 3: 9 base files have UNKNOWN equivalence (source is not on the box). Open item: needs Origin fetch plus a catalog diff.
- MINOR: b007 DROP CONSTRAINT/TRIGGER without IF EXISTS (fix-forward in repo, not staging); delete_after rewrites changed 0/10 rows.
- QA sign-off and CEO approval for Class B are still required (RULES 2).
### GATE-B — **N/A (not run)**
- /workspace/ops/GATE-B.md and the spec (e2e/results/errors-redact/prod/gate-b-spec.md) define a gate for prod **Worker releases** of a specific SHA (b71fc68): prod deploy, prod personas, Observability. No Worker was deployed here, and the work was staging-DB only. Running it would mean prod operations, which this task forbids. It applies at the later staging/prod Worker deploy of 4e43104, which needs a CEO decision on scope.

### QA SIGN-OFF (2026-10-30 05:52 PT) — GO for staging dev (read-only re-check of this file)
- MAJOR 1 (process): does not block staging. For prod, Class B must run BEFORE any apply.
- MAJOR 2: closed by post-verify-security.json / post-default_acl.json (anon has no SECURITY DEFINER exec, no app.* SELECT, no schema USAGE). The 24 no-RLS tables match source; does not block staging. Before prod/real users, the RLS state must be decided explicitly.
- MAJOR 3 / 9 base files with UNKNOWN equivalence: does not block Codex staging dev (staging only, the 80 verified files cover the core). Prod gate: Origin fetch plus a catalog diff of the 9 files, plus a migration ledger, before any prod migration.
- Conditions: prod ref guard stays; no prod writes from this plan.

## 2026-10-30 10:30 PDT — a4ecf129 gate fix (B-013/B-021)
- The gate failure was a test-rls fixture issue (notification-producer-source.integration.test.ts:37, nondeterministic invoice LIMIT 1). No staging DB change was required or made. Patch: /workspace/mode-b-bootstrap/a4ecf129-gate-fix.patch.

# B-013/B-021 — staging plan (PE, 2026-10-30 11:25 PDT)
Source: condola-app `mode-b-repair-override-prep` @ dc733f30 (gate PASS on test candidate f419aa6). Handoff: /workspace/mode-b-bootstrap/b013-db-handoff.md. Target is STAGING `kodvasnrzprpzcsyjknf` only.

## Current staging state (read-only, 11:20 PDT)
- 89 core89 files are applied (see above). Of the 93 files at dc733f30, 89 have blob SHAs identical to 4e43104. The 4 new ones are all absent on staging: 0 app.b017*/b015*/b013* tables or functions. `b028_center_events_check` is still present. app.b028_center_events = 0 rows, app.b010_source_events = 0 rows, property_owners 205, contacts 1088.
- Pre-apply catalog snapshot: staging-db-evidence/b013/pre-{relations,functions,constraints,triggers,rowcounts,replaced-functiondefs}.json.

## Diff / ordered migrations (SHA-256 matches the handoff; blob SHA matches Origin dc733f30)
1. 20261031100217_b010_b028_source_foundation (e43064d8…) — 3 new app.b017 tables, functions and triggers. Replaces 3 app.b028 functions (OR REPLACE; pre-defs saved). Swaps CHECK `b028_center_events_check` for new constraints on a table with 0 rows.
2. 20261031100218_b015_tenant_directory_edit (6824dbaa…) — app.b015_edit_commands plus gateway functions.
3. 20261031100220_b013_owner_repair_policy (31c127e7…) — 5 app.b013 policy tables, functions and immutability triggers.
4. 20261031100221_b013_owner_repair_override (b6145a01…) — override functions only.
- Destructive scan: no DROP TABLE/COLUMN, TRUNCATE or top-level DELETE/UPDATE. DELETE/UPDATE appear only inside function bodies (runtime). The one DROP CONSTRAINT is on an empty table, and a replacement is added.
- **Not applied (deferred):** the handoff's proposed "closed foundation" SQL (app.b013_estimate_* tables). It is not a repo migration, has no filename, and has no syntax or DB test. The handoff allows deferring it until the gateway and guard are complete. Applying SQL that is not in the repo would create drift between staging and source. Codex must commit it as a migration file and gate it first.

## Rollback
- No down migrations. Before commit, a failing batch rolls back. After commit, fix forward. Pre-images of the replaced app.b028 functions and the dropped CHECK definition are in b013/pre-*.json. New tables are empty and additive.

## Verification
- New tables/functions present; no table grants to PUBLIC/anon/authenticated/service_role on the new app tables. RLS is NOT enabled by the source, same as the core89 precedent, so this is not a fail criterion; 0 new SECURITY DEFINER functions executable by anon; row counts unchanged (property_owners, contacts, leases, invoices); old CHECK gone and new b017_center_* constraints present.

## B-013/B-021 Claude Class B (pre-apply, llm-route claude, task b013-staging-classB) — **PASS** (0 BLOCKER, 1 MAJOR, 2 MINOR)
- Evidence: staging-db-evidence/b013/claude-classB-pre.md.
- MAJOR (plan said "RLS on" but the source does not enable RLS): fixed. The verification text was corrected to require no grants, matching the core89 precedent.
- MINOR: currencies includes TWD (checked: TWD,USD). property_owners.repair_approval_threshold_minor exists (bigint). Both closed by read-only checks.

## B-013/B-021 results (2026-10-30 11:24 PDT, STAGING kodvasnrzprpzcsyjknf; prod not touched) — PARTIAL, STOPPED
- Applied: 1/4. 20261031100217_b010_b028_source_foundation returned HTTP 201. Verification (staging-db-evidence/b013/post-verify.json): 3 app.b017 tables; old CHECK replaced by 15 b017_center_* constraints; 0 anon-executable b017 functions; 0 client SELECT; property_owners 205, contacts 1088, b028_center_events 0 (unchanged).
- FAILED: 20261031100218 returned HTTP 400, `42883 function public.digest(text, unknown) does not exist`. Staging (PG 17.11) has pgcrypto in schema `extensions`; the local PG16 gate has it in `public`. The batch had BEGIN/COMMIT and rolled back fully (0 b015/b013 objects). 100220 and 100221 also call public.digest, so the run stopped before them. Log: staging-db-evidence/b013/apply-log.txt.
- Fix (portable, Codex to commit): /workspace/mode-b-bootstrap/b013-digest-fix.patch (sha256 d9c092bc…1745). It replaces 6 `public.digest(X,'sha256')` calls with built-in `pg_catalog.sha256(convert_to(X,'UTF8'))`, which needs no extension. Equivalence was checked read-only on staging (same hex = true). New file SHA-256s after the patch: 100218 30879e8e…, 100220 3ce9a749…, 100221 06308c09….
- Not applied with the patch, on purpose: the patched SQL is not in the repo. Applying it would make staging differ from source again. Next step: Codex applies the patch, reruns the full gate, and pushes. PE then verifies the blob SHAs and applies 100218, 100220 and 100221 in order (expected no-op for anything already present: none).
- Recorded in /workspace/migrations-applied.md.

## B-013/B-021 patched files (PE local, 2026-10-30 11:40 PDT) — for byte-compare with Codex's later commit
Location: /workspace/mode-b-bootstrap/b013-patched/ (SHA256SUMS). These are the dc733f30 originals (Origin blob SHAs verified) with only b013-digest-fix.patch applied: 8 changed lines, 6 call sites.
- 20261031100218_b015_tenant_directory_edit.sql `30879e8e062bd8a0b771ef15f1c50e76d2ffa825cacb042d926aeec1f04297a5`
- 20261031100220_b013_owner_repair_policy.sql `3ce9a749f9e19f43f761e6aa65c2b8b3f73e64886ae477606d8594a064f4557e`
- 20261031100221_b013_owner_repair_override.sql `06308c09a251960ca7208242fc3b381faae2e23d15a14a4495ced8c7dd20cc00`
Pre-apply snapshot: staging-db-evidence/b013/pre2-{relations,functions,rowcounts,property_owners-md5,contacts-md5}.json. The md5 files contain per-row hashes only, no values.

## Claude Class B on the patched files (llm-route claude, task b013-patched-classB) — **PASS** (2 MAJOR, both closed)
- Evidence: staging-db-evidence/b013/claude-classB-patched.md. The patch touches only the 6 call sites; there are no top-level UPDATE/DELETE statements; the new functions are granted only to service_role, not anon/authenticated.
- MAJOR 1, encoding: closed. Staging server_encoding is UTF8, and the digest vs sha256 output is identical for a CJK payload (checked read-only).
- MAJOR 2, the local baseline repo was not upstream: closed. Comparing against core89-src (blobs verified against Origin dc733f30 at 11:20) gives exactly the patch hunks. Final drift check: once Codex commits, byte-compare against the SHA256SUMS above.

## B-013/B-021 results, part 2 (2026-10-30 11:44:57–11:45:00 PDT, STAGING kodvasnrzprpzcsyjknf; prod not touched) — COMPLETE 4/4
- Applied, all HTTP 201 with the ref guard passed (log: staging-db-evidence/b013/apply-log.txt): 100218, 100220, 100221. These are the patched files with the SHA-256s listed above.
- Verification (staging-db-evidence/b013/post2-verify.json):
  - New tables and functions: 6 app.b015/b013 tables and 24 functions.
  - Access: 0 b013/b015/b017 functions executable by anon or authenticated; 0 table SELECT grants to anon, authenticated or service_role.
  - Seed: app.b013_regional_defaults has 1 row (TW/TWD).
  - Function output: app.b015_contact_snapshot on a contact with a CJK name returns the same hash as the original pgcrypto expression.
  - Data unchanged: per-row md5 aggregate of property_owners (5b634940…) and contacts (46fc8511…) is identical before and after; property_owners 205, contacts 1088, leases 883, invoices 32.
- Open item: staging runs the patched SQL. Codex must commit b013-digest-fix.patch to condola-app. PE then byte-compares against the SHA256SUMS. A mismatch means fix-forward.

# Standing rules for every staging batch (CEO reflection 2026-10-30)
## Rule 1 — Class B PASS before apply (hard rule; target 0 violations)
- No staging apply without `/workspace/condola-hub/20-build/staging-db-evidence/<batch>/classB-PASS.md`, containing the reviewer output whose first line is `VERDICT: PASS` with all BLOCKER/MAJOR findings closed.
- The apply script's first step: `test -s "$E/classB-PASS.md" && head -3 "$E/classB-PASS.md" | grep -q 'VERDICT: PASS' || { echo "ABORT: no Class B PASS"; exit 1; }`.
- Recorded violation: **core89 (2026-10-30 05:42) was applied BEFORE its Class B review** (review ran around 05:50). B-013/B-021 complied (Class B ran before each apply).
## Rule 2 — schema-qualification lint before each batch (target: 0 environment-caused failures)
- Staging: pgcrypto/uuid-ossp live in `extensions`; citext/btree_gist in `public`.
- Before applying, run on each file: `grep -nE "public\.(digest|hmac|gen_random_bytes|crypt|gen_salt|pgp_[a-z_]+|uuid_generate_[a-z0-9_]+)\(" FILE`. Also check, inside functions with `SET search_path=pg_catalog…`, for unqualified `digest(|hmac(|gen_random_bytes(|crypt(|gen_salt(|uuid_generate_`. Any hit means STOP and return it to Codex, or use a reviewed patch (built-in `pg_catalog.sha256(convert_to(x,'UTF8'))`).
- Confirm the extension locations read-only at the start of each batch: `select extname, extnamespace::regnamespace from pg_extension`.

## B-024 results (2026-11-05 21:43–21:48 PT, STAGING kodvasnrzprpzcsyjknf; prod yfijvcgpubzmqrgnapzd NOT touched)
- Migration `20261105190000_b024_vendor_completion_reason.sql` applied via Supabase Management API `/database/query` with ref guard. HTTP **201**. Receipt: `e2e/results/b-024-1105/staging/mgmt-api-apply-receipt.json` (payload_sha256 `f0ecd4e4…`, sql_sha256 `3e0717ac…`).
- Pre/post checks: `staging/pre-apply-check.json`, `staging/post-apply-check.json`. service_role-only grants on new functions; 0 new appointment rows from OFF probes.
- Worker deploy (OpenNext + mandatory `getMiddlewareManifest(){return null}` patch):
  - First deploy `4ecb456b` (unpatched handler) → HTTP 500 → rolled back to `ad811768` (log: staging/rollback.log).
  - Patched redeploy Current Version ID **`fb97c3cf-21b8-40ac-bc24-08ae9929c6df`** @ app `ccb2408` (log: staging/cf-deploy2.log). Preflight warned node_modules symlink→`/tmp/app-b021` (foreign path refs); deploy proceeded after explicit middleware-manifest patch verification.
- OFF probes (`staging/probe-b024-off.mjs` + `off-probes-correct.log`): version sha `ccb2408` PASS; invalid token page PASS; unauth POST `/api/vendor-job-response`→403; unauth POST `/api/vendor-job-completion`→403; DB zero new appointments PASS; **failed=0**. Site `GET /` → 200.
- Flags remain OFF (`vendor_dispatch` / `repair_approvals`). No prod touch. Done ≠ activation.

## B-024 Worker redeploy (2026-11-05 22:16 PT, STAGING kodvasnrzprpzcsyjknf; prod NOT touched)
- No new SQL (fix4 TS/tests only). Prior mig `20261105190000` remains applied.
- Worker Version ID **`779739a9-7c11-4c93-b9ac-0fd8d7b42b25`** @ app tip `cd1cba2` (code `e70380e`). OpenNext `getMiddlewareManifest(){return null}` patch applied post-build.
- OFF probes `probe-b024-off.mjs`: **failed=0** (version sha cd1cba2; invalid token; unauth response/completion 403; DB zero new appointments). Flags OFF. Done ≠ activation.

## 20261106020000_b010_payment_result_events (B-010, 2026-11-06 ~03:10 PT)
- Target: staging `kodvasnrzprpzcsyjknf` only (prod untouched). Applied via Supabase Management API `/database/query`, HTTP 201; idempotent re-run HTTP 201.
- Tracking: staging has no app migration table (only auth/storage/realtime); receipt at `e2e/results/b-010-1106/staging/mgmt-api-apply-receipt.json`.
- Drift vs fresh local PG17.11 build of app `5246d93`: functions 20/20, ACLs 20/20, columns 29/29, indexes 9/9, triggers 7/7, RLS 2/2 — 0 diffs (`staging/drift.json`).
- Flag `payment_results_v2` OFF (platform enabled=false, 0 orgs); confirmations/collectors rows 0.

> QA round 5 after the failure at `b352b6e`. B-004 stays **partial**. `done` still means an exact-SHA staging check plus the required independent verdict. Flags stay OFF. This commit does not change a hosted database or deploy a Worker.

# B-004 staging state

The candidate refuses a new signed PDF on an archived lease. Flags stay OFF. This note does not deploy.

- Applied on staging, 2026-10-30, all three: `20261030151400_tenant_signed_pdf_read.sql`, `20261030151500_paper_lease_versions.sql`, `20261031100204_b004_paper_delivery_boundary.sql`. These are not pending apply.
- Staging Worker at notes commit `3fd94e0` is `efe4a399`. This notes-fix commit does not deploy.
- Flags stay OFF. `PAPER_LEASE_VERSIONS_ENABLED` must be absent or any value other than the string `true`. `platform_settings` key `tenant_signed_pdf` stays absent. Organization flags `paper_lease_versions` and `tenant_signed_pdf` stay unset. `ops/flags.yaml` keeps `PAPER_LEASE_VERSIONS_ENABLED` default false.
- `20261030151400_tenant_signed_pdf_read.sql` and `20261030151500_paper_lease_versions.sql` now set `lock_timeout` and `statement_timeout`, matching the later B-004 files. Neither file is on `main`, so production has not applied them. Staging applied the earlier bytes on 2026-10-30 and will not re-run those filenames.
- Staff cannot upload or replace a signed PDF when the lease property, unit, or target room is archived. The upload action returns `errors.notFound` before insert. Migration `20261031100224_b004_archived_lease_signed_pdf.sql` raises `42501` on `BEFORE INSERT`, so a direct insert also writes no version row and no `paper_lease_replaced` audit.
- The `b888ccd` skip is UNAPPROVED. It is the lost identity-document upgrade of `20261022180000_tenant_id_check.sql`, not a paper-delivery result, and it is not an approved waiver. The raw log `gate-9ce4a168d5482ae1afb3189624ddd1b2c50fbf38-rls.log` keeps the bytes committed at `4da595094dcc53900e6d4e4cfb2b69f33d80cce4`, including the original skip sentence. The correction is [gate-9ce4a168-correction.md](gate-9ce4a168-correction.md). Raw logs are not edited. New runs are new files.
- Staff download route: admin and manager are the only roles that reach the file. A successful download writes `signed_pdf_downloaded` and stores that code in `audit_log.reason`. This is not a closed gap. Route-handler tests cover logged-out, missing consent, another organization, a non-allowed staff role, manager success, admin success, and one audit row. B-004 stays partial.
- Replacement reasons are the codes `corrected_signature`, `wrong_file`, `illegible_scan`, and `other`. The form is a select. The API rejects anything else. `audit_log` for a replacement stores the code only. Migration `20261031100223_b004_reason_codes.sql` stops if a stored reason is not a code. The local disposable table had 0 `lease_signed_pdfs` rows, so the `other` update changes nothing. Hosted staging and production were not queried.
- `TENANT_SIGNED_PDF_ENABLED` is on only when the environment value is exactly `true`. Default is OFF.
- Logged-in old-code compatibility and rollback are still unproven. `e6788e38` is not in this clone. An earlier local run of `1c8fd07bc1fd78e7a86a00daff994f68e734be4f` paper tests is not logged-in staging proof and is not a rollback proof. The independent Class B verdict is still required. Production is out of scope.
- Full gate on `5819e26c5ca90044c7dce7a265c83ddc35ceba09`: unit 654 pass, 0 fail, 0 skip; RLS 483 pass, 0 fail, 1 UNAPPROVED `b888ccd` skip. Raw logs: [unit](gate-5819e26c5ca90044c7dce7a265c83ddc35ceba09-unit.log), [RLS](gate-5819e26c5ca90044c7dce7a265c83ddc35ceba09-rls.log). That RLS file is a new run. Its skip line says UNAPPROVED.
- QA round 4 restores the `9ce4a168` raw log and adds tenant signed-PDF route tests through that route's GET handler: logged-out, consent refused, another organization, own-lease success, and one audit row whose reason is `signed_pdf_downloaded`. B-004 stays partial. Logged-in old-code compatibility and rollback are still unproven.
- Full gate on `f8e8e56b2b1759799500554ec962f48e1ef1bd95`: unit 654 pass, 0 fail, 0 skip; RLS 488 pass, 0 fail, 1 UNAPPROVED `b888ccd` skip. New raw logs: [unit](gate-f8e8e56b2b1759799500554ec962f48e1ef1bd95-unit.log), [RLS](gate-f8e8e56b2b1759799500554ec962f48e1ef1bd95-rls.log).
- QA round 5 formats signed-PDF upload time in Asia/Taipei on the tenant lease page and the tenant history page. The staff panel display is unverified. The history signed route is specified in [history-signed-route.md](history-signed-route.md): pending and active are 404; an own ended lease can succeed. B-004 stays partial.
- The 404 from `wrangler rollback e6788e38` is corrected in [old-code-staff-404.md](old-code-staff-404.md): that rollback restores the version's own secret set, which predates `PAPER_LEASE_VERSIONS_ENABLED`. Redeploying `1c8fd07` with the secrets set (staging Worker `16b745e5`) returned 200 with the same bytes for staff and tenant, and wrote a tenant audit only. The old code writes no staff audit; that is accepted. The rollback steps are in [docs/policy/deploy-checklist.md](../../docs/policy/deploy-checklist.md). Logged-in rollback remains a procedure, not a standing proof that this candidate is done.
- Full gate on `db49503b7b410b6214e62b4f416275ee98f514eb`: unit 655 pass, 0 fail, 0 skip; RLS 492 pass, 0 fail, 1 UNAPPROVED `b888ccd` skip. New raw logs: [unit](gate-db49503b7b410b6214e62b4f416275ee98f514eb-unit.log), [RLS](gate-db49503b7b410b6214e62b4f416275ee98f514eb-rls.log).
- The lost `b888ccd` file is covered by a synthetic upgrade on the current schema: relax `delete_after` and the photo-size cap, seed both violations, run `20261022200000_tenant_id_check_upgrade.sql` twice, and require the same outcome. That test is not skipped.
- Full gate on `d565c9b8491c5b9634e57fad64b9fb4b2af2c612`: unit 655 pass, 0 fail, 0 skip; RLS 496 pass, 0 fail, 0 skip. New raw logs: [unit](gate-d565c9b8491c5b9634e57fad64b9fb4b2af2c612-unit.log), [RLS](gate-d565c9b8491c5b9634e57fad64b9fb4b2af2c612-rls.log).

Functional compare for CAP-M-02 and CAP-T-02: [qa-full-diff.md](qa-full-diff.md).

Local browser evidence remains candidate `ee734857cf04f75d84c5a01eb89d433b9e89bfae`. This note does not rerun that browser.

> 1103交接：**partial / STOPPED**。最後綜合應用候選 `1c8fd07bc1fd78e7a86a00daff994f68e734be4f`；局部驗證SHA保留如下。下一步由Grok Bot（CEO）依 [完整交接](../../20-build/codex-handoff-1103.md) 安排。未驗證或待PE事項不視為done。

> Follow-up 2026-10-30T15:56:54.814861-07:00: the pre-existing parent heading finding below is locally resolved by B001 `41c5b7ff3c3a730308d4e31f3b4508df7a650055`; [proof](../B-001/heading-checkpoint-41c5b7f.md). The original B004 scoped checkpoint and its pending external acceptance are unchanged.

# B-004 private paper-delivery verification checkpoint

Updated 2026-10-30T15:22:12.689041-07:00; candidate`ee734857cf04f75d84c5a01eb89d433b9e89bfae`, branch`mode-b-repair-override-prep`, ModeB Ron/Codex. **Scoped local PASS; wholeB004 pending/INCOMPLETE; no release/activation GO.** Test/privateconfig/runner only; no application, migration, product schema or legal/contract text change.

Clean pinned gate599unitPASS;359RLS total/358PASS/0FAIL/1 UNAPPROVED b888ccd skip. Next17.821s/Cloudflare26.975s, unchanged originalpreflight3.288sPASS, Worker1/1; final fresh browser4/4PASS49.8s with8screens390/1280. [Manifest](http-boundary-ee73485.json), [acceptance](acceptance.md), [source reconciliation](source-reconciliation-c3138fa.md). Existing two named core89/91/92b cases alreadypassed, superseding the old pending note; no app rebuild was needed. No actual runtime failure in this B004 delta; source-review findings were resolved before execution.

Actual manager uploads/replacements preserve current/history/supersedes, required reason, uploader/time and both staff live/sandbox directions. Existing server reason rejection, ordinary-role immutability/concurrency and genuine parent-cascade boundaries are separately covered by executed full-RLS suites; browser empty-reason check is HTML required, not a direct server-bypass attempt. Tenant own download gives private/no-store/nosniff attachment/synthetic bytes and one attributable committed event. Anonymous same-origin login redirect, wrong tenant/org, bound sandbox selection, global/orgOFF deny; new malformed/unknown version404 has no PDF/attachment or current/total download audit increment. Injected owned disposable fault yields503/no attachment/Unavailable/no extra event; fixture function/trigger removed. Staff route is not claimed to write a download audit.

Independent aggregate readback:2versions/1current/1replacementlink/1attributabletenantdownload;0paper/tenantorgoptins, effective globalOFF, faultobjectsabsent. Original globalsetting was **absent** and is restored to absence, matching template. Present-row exact value/description/microsecond restoration is source-reviewed only in this fixture; both captured org flag objects are runtime-restored, while timestamps/audit history/uploads legitimately remain changed. Normal triggers are active during restoration. Local PAPERruntime true is private test-child-only; no operational activation. Temporary fault DDL is test fixture, not product/operational migration. Existing fullRLS ON/synthetic purge is disposable-only; no prod/mainmerge/Mac operationalmigration/backup/externalmessage.

Root viewed manager390/tenant1280/sandbox390/live1280; B004 history/delivery state is consistent, but a **pre-existing B001 heading defect** is visible: unconditional pending h3 above signed timeline. [Recorded follow-up](../B-001/signing-heading-followup-ee73485.md); no blanket parent-page visual PASS. The tenant bound-sandbox negative is live PDF requested under selected own sandbox lease; no sandbox-own tenant HTTP200/both-flags-ON independent guard proof claimed by this browser case. Lower-level integration separately tests such contexts.

Highest-requested source review PASS, requestedAstra/xhigh actualmodel/effortunknown; final native evidence verdict separate, no Claude substitute. Old-code/new-schema/actual approved rollback target, exact staging app/schema/roles/headers and independent Claude/ClassB remain pending. No download-as-signature, confirmed real receipt or indefinite-retention claim.

STOP POINT: local B004 checkpoint verified; next: publish/mirror then revisit now-actionable B001 heading before B005; owner: Ron/Codex. Earlier records below retain dated scopes.

---

> Latest local integration checkpoint (2026-10-30T03:05:16.071480-07:00): candidate `4e43104f45c3acf0dae76e40c7b577bd7ffb8ea6`; see [core89 local verification](../integration/core89-local-verification.md). Whole-feature verdict remains INCOMPLETE/NO-GO; dated records below retain their original scope. This link supplies no staging/Claude/release waiver.

# B-004 paper delivery checkpoint

Updated: 2026-10-29T21:17:19.972187-07:00; branch mode-b-build; Ron/Codex.

New100204 scopes direct tenant PDF reads to organization/environment pins, preserving unpinned live compatibility. Current/history labels follow the authoritative document pointer. Direct ordinary-role version updates/deletions are denied; genuine parent cascades remain. Download audit commits before delivery; failure returns private503 without PDF bytes or attachment. No legal wording changed.

Existing paper-version global control now reads exact runtime string true, with absent/malformed values OFF and the existing strict org opt-in still required. Local browser test process explicitly enables the global controls after validating an opted-in disposable target; product defaults remain OFF. Runtime units4/4 passed both OFF/ON environments, type/lint passed. Native highest-tier scoped runtime review PASS, with two assertion improvements applied.

Actual local core80 HTTP/browser1/1 passed upload/replacement/history/pointer, protected successful download/audit, unauthenticated/wrong-user/cross-org/sandbox denials, global/orgOFF and audit-failure503. Final immutable rerun is pending after stronger anonymous redirect assertion.

STOP POINT: local candidate prepared; next: clean exact-candidate gate and actual HTTP/browser rerun, then authorized staging-side schema handoff; owner: Ron/Codex. Staging and independent Claude ClassB acceptance remain pending.

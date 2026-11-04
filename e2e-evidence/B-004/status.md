> Notes fix after QA failed `3fd94e0`. Paper versions, tenant downloads, and download audit were already on this branch. `done` still means an exact-SHA staging check plus the required independent verdict. Flags stay OFF. This commit does not change the hosted database or deploy a Worker.

# B-004 staging state

No new feature in this note.

- Applied on staging, 2026-10-30, all three: `20261030151400_tenant_signed_pdf_read.sql`, `20261030151500_paper_lease_versions.sql`, `20261031100204_b004_paper_delivery_boundary.sql`. These are not pending apply.
- Staging Worker at notes commit `3fd94e0` is `efe4a399`. This notes-fix commit does not deploy.
- Flags stay OFF. `PAPER_LEASE_VERSIONS_ENABLED` must be absent or any value other than the string `true`. `platform_settings` key `tenant_signed_pdf` stays absent. Organization flags `paper_lease_versions` and `tenant_signed_pdf` stay unset. `ops/flags.yaml` keeps `PAPER_LEASE_VERSIONS_ENABLED` default false.
- The `b888ccd` skip is UNAPPROVED. It is the lost identity-document upgrade of `20261022180000_tenant_id_check.sql`, not a paper-delivery result, and it is not an approved waiver.
- Gate counts are not copied from `3fd94e0` or `75221482`. Full gate on `8c615d368216687faf92d68b7f23d58cd0623205`: unit 651 pass, 0 fail, 0 skip; RLS 476 pass, 0 fail, 1 UNAPPROVED `b888ccd` skip.
- Still blocked: the independent Class B verdict and calling the item `done`. Production is out of scope.

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

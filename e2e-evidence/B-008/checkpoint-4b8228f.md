# B008 local preview checkpoint

Recorded 2026-10-30T17:58:16.504496-07:00. Candidate `4b8228f995a29a56ac89bb86b4a8b2e7e12adfe8` on `mode-b-repair-override-prep`; baseline `b40107b928c0ddbc1248e710d6c2914fcdd2c649`. Class B. **Scoped local PASS; whole B008 remains IN PROGRESS / release NO-GO.**

## Product behavior

The existing first-invoice plan now also supplies a SELECT-only authenticated lease preview: rent, deposit and the existing selected eligible utility, source rent period and formula. The original first-period/PDF-separation summary stays visible. Issued invoices display recorded lines rather than a new estimate; imported/unsupported prospective states do not fabricate a new bill. Expected invalid sources display unavailable; issuance keeps strict validation. Preview is snapshot-time and reserves nothing.

The new `/m/rent/monthly-preview` shows supported full-calendar-month stored rent and separate currency subtotals. Missing historical line periods, partial/move-out dates, unsupported frequency, uncertain coverage and charges/utilities remain explicit. Posted-run status alone cannot prove utility posting. Source digest and cap+1 completeness are bounded; an incomplete result has neither totals nor digest. It is a rent-only review, with no monthly generate action. The entry uses the same current-session/live-membership/consent/global+org authority, with a same-RR authenticated live-parent check and restored selected pin; no new privilege. Explicit month selection removes the newly found Taipei default. Existing form styles and actual mobile44px/non-overlap checks resolve the new bare-form visual finding.

## Exact validation

- Clean exact-SHA `scripts/gate.sh`: npm ci, toolchain, typecheck, lint, copy and flag checks PASS; **611/611 unit; 373/374 RLS PASS, 0 FAIL/0 CANCELLED, 1 sole prior Ron-approved historical b888ccd skip**. No RLS waiver. Lint has seven existing warnings and zero errors.
- Next19.293s, Cloudflare28.456s, unchanged original preflight3.471s PASS with command-local GNU awk; Worker1/1 PASS. No deploy or operational migration. Original script SHA256 `7c4a336fc33172efc8e0b736ac4930923801b776b3bd5d79240613b3b2f195cb`.
- Final real local-browser **6/6 PASS52.1s**, 390/1280,22 PNGs. Existing statement/utility/close, first-period wizard/edit and combined first-invoice $160+$600=$760 → saved $300+$600=$900; monthly OFF/explicit selection/ON/invalid, EN/zh, zero/partial/quarterly/unknown/existing coverage, exact TWD1000(2) and USD123.45(1) →234.56(1) after refresh. No unexpected page/console/HTTP500/off-origin events in those journeys.
- Prior focused13 first-invoice plus6 monthly checks PASS. They are preliminary scoped runs, not extra unique final-gate tests. Historical bb45158 and535c086 runtime passes are retained privately; they preceded the timezone/form corrections and are not the final UI verdict.
- Independent SELECT-only readback compares the final HTTP clone with the same-source seeded build clone: original PRESENT global setting full value/description/microsecond timestamp and org feature flags restored, globalOFF/0 org opt-ins. This restores controls, **not the whole database**. Earlier case fixtures may be removed by subsequent demo resets; no persistent all-case aggregate is inferred.

Commands (from the active worktree):

```sh
python3 ../run-b008-prepared-check.py condola_b008_gate_4b8228f b008-full-gate-4b8228f.log bash scripts/gate.sh 4b8228f995a29a56ac89bb86b4a8b2e7e12adfe8
python3 ../run-b008-prepared-check.py condola_b008_build_4b8228f b008-build-worker-driver-4b8228f.log python3 ../b008-build-worker-final-commands.py
python3 ../run-b008-prepared-check.py condola_b008_http_4b8228f b008-http-4b8228f.log node node_modules/@playwright/test/cli.js test --config e2e/b008-preview-private-playwright.config.ts --output ../b008-http-4b8228f-artifacts
node ../b008-readback.cjs condola_b008_http_4b8228f 4b8228f condola_b008_build_4b8228f
python3 ../make-b008-preview-proof.py 4b8228f995a29a56ac89bb86b4a8b2e7e12adfe8
```

## Independent scope and artifacts

`PASS_SCOPED_B008_CHECKPOINT_EVIDENCE` on this exact candidate. Requested native Astra/xhigh; actual model/effort unknown. Reviewer rehashed49 bindings (27 artifacts+22PNGs), verified24 candidate/current refs+12 baseline-unchanged refs, zero mismatches. Root viewed monthly-choose390/1280, combined-before390, statement1280; independent reviewer inspected the other18, covering all22. No new preview finding remains. This is native independent scoped QA, not Claude sign-off.

Manifest [preview-boundary-4b8228f.json](preview-boundary-4b8228f.json), SHA256 `5eea5320c04a39c6103b9df802da10760dcd4e57b72fe6735d85ba607a848205`. Raw command logs and synthetic PNGs stay private outside repo; retention TODO. Manifest binds exact reviewed22 source blobs,12 unchanged financial/control/template files and the gate summary. Builder SHA256 `7e24acbd164839ab3fb6e5bb0195bf8e6077200f004e47b0ce447400f65c1c73`; reader `3d6ca378419044d7c703a52c7ea91148b1fd715b66feaa22dae288f6df05d0d5`.

Capture limits: edit screenshots are pre-save (old160/760 above pending300 choice; mobile transient deposit-check/disabledSave); later persistence and combined-after are separately asserted. Next development badge overlays some existing labels/navigation/close control in full-page captures. No blanket whole-parent/no-overlay PASS, no fresh complete authority/concurrency matrix for the monthly reader, no post-snapshot revocation guarantee. First-invoice expiry is checked before its short source reads, not at final response.

## Remaining scope and next step

Actual monthly writer, full bill inclusion and preview→monthly-generation parity remain unfinished. [DB research](monthly-db-research.md) and its `.sql.txt` copy are an independently reviewed **non-executable research proposal**, not a closed foundation or PE-apply-ready migration. Downloads originals remain unchanged. Do not apply them. Existing source permits direct/independent writers; a new occurrence key alone is not an all-writer guarantee. Concrete writer/absence-fence/OFF compatibility and supported policy contracts still need source review before a final SQL handoff. This does not make all remaining B008 work DB-blocked: source architecture, shared calculation and eligible non-writing application work continue.

Exact staging/catalog/capture-owner boundary, approved old-code/new-schema/OFF/rollback and independent Claude/ClassB acceptance remain pending. B001 activation/first-bill hooks already exist with separate local evidence; do not repeat the obsolete claim that the hook is absent. No prod, main merge, operational Mac migration, external message, legal copy or persistent flag activation occurred. Disposable QA replay only reused existing approved schema fixtures.

STOP POINT: WORKING; next: `cat ../B008-monthly-writer-contract-v2.md` and source-review its concrete invariant options before any further implementation; owner: Ron modeB session3099AC86 / Codex.

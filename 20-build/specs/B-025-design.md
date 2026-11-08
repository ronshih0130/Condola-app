# B-025 — JIT L2 設計稿：廠商收據開立入口與全額實收閘（slice 1）

> Author: Claude (Mac overnight, 2026-11-06 PT). Layer-2 design for hub `20-build/specs/B-025.md` incl. **PROP-MF-B025 / UC4** and **PROP-US-v03-05 (CAP-V-14)** reserves. Stacked on B-022 (`feat/b-022-owner-replies-title`, receipt-title source). Existing backend reused: `src/server/vendor-receipt.ts` (invite/grant tokens, preview without sequence, idempotent issue, issuer-only void, reissue, PDF bytes + sha256) — it has no routes or UI yet.

**Slice 1 (this PR):** vendor-facing document entry behind `vendor_documents` (OFF) + the full-payment receipt gate + the two receipt paths. **Deferred to slice 2 (logged, not dropped):** onboarding-invitation UI, fixed-data/seal history UI, paper-scan sibling upload, trade quantity/unit field editing.

## Done means

With `vendor_documents` ON for a local test org and a staff-created document invite, the vendor opens `/v/documents/<token>` (the URL staff invitations already generate), sees the job's line items and total, previews a receipt/completion statement (no number consumed), records amounts received for this work order (partial amounts only accumulate), and can issue an electronic **receipt only once the recorded received total covers the document total** (two-step: completion statement first, or one-step on site: record the full amount and issue in one action); the vendor can void (issuer only) and reissue; PDFs download and old PDFs stay unchanged. Flag OFF: routes 404, nothing written.

## Data (additive migration `20261106050000_b025_vendor_document_gate.sql`)

- Seed `platform_settings('vendor_documents', {"enabled":false,"allowed_org_ids":[]})` ON CONFLICT DO NOTHING; `ops/flags.yaml` entry OFF.
- `app.b025_received_marks(id, org_id, ticket_id, vendor_profile_id, grant_id, amount_minor bigint > 0, request_id, created_at; UNIQUE(org_id, request_id))` — append-only vendor statements "received this amount for this work order"; RLS on, REVOKE ALL.
- Gate in the DB: `BEFORE INSERT` trigger on `public.vendor_documents` — when `vendor_documents` is ON for the org and `kind='receipt'`, require `sum(received marks for ticket+profile) >= total_minor` (bigint) else `23514`. **No override parameter** (US v0.3: the full-payment CHECK cannot be overridden). Flag OFF: unchanged (existing tests/paths keep working; no route reaches them).
- RPC `app.b025_record_received(p_grant uuid, p_request uuid, p_amount bigint)` SECURITY DEFINER (pinned search_path), used by the token route via the existing service path; idempotent by request id.

## Routes (token in POST body / header, never in a query string)

- `POST /api/vendor-documents` `{ token, action: 'context'|'preview'|'mark_received'|'issue'|'void'|'reissue', ... }` → flag check first (404 when OFF), then existing `vendor-receipt.ts` functions with the token actor. `issue` with `kind:'receipt'` maps a gate failure to `receipt_requires_full_payment`.
- `POST /api/vendor-documents/pdf` `{ token, documentId }` → PDF bytes (integrity-checked), `Cache-Control: no-store`.

## Money / permission (Class B)

BigInt for received marks and gate (existing `totalMinor` number fields are pre-existing; the gate re-checks in SQL bigint). Token-scoped grant authority (existing `authorize`/`authorizeDocument`); void issuer-only (existing); vendor surfaces never show owner prepay or company internal settlement (only line items, total, own received marks); receipt ≠ tax invoice (copy).

## 驗證

Integration `src/server/b025-vendor-document-gate.integration.test.ts`: flag OFF ⇒ route handlers 404 and zero marks; partial marks block receipt, full marks allow; completion statement allowed before full payment; one-step mark+issue; replayed request ids idempotent; preview consumes no sequence; void/reissue keeps old PDF bytes and never reuses a number; other grant's token cannot mark or read.

## 不做什麼

No ID-document collection, no company-checkbox substitution, no tax/legal claims, no change to numbering rules, no owner prepay/internal settlement exposure.

## Cross-review changes (Codex QA r1 FAIL → fixed)

1. **act on** — Gate bypass via UPDATE: `app.b025_document_identity_immutable` (BEFORE UPDATE) rejects changes to kind, totals, items, buyer, doc number, ticket/profile/org; voiding still works.
2. **act on** — One-step replay: an already-used idempotency key returns its document without appending another payment mark.
3. **act on** — Multi-row work-order pricing has no authoritative per-row names/amounts on the ticket: the token surface fails closed (`itemsUnavailable`, preview/issue 409 `items_unavailable`, page explains) instead of 404.
4. **act on** — Page moved to `/v/documents/[token]`, matching the URL `createVendorDocumentInvite` already returns.
5. **dismissed with reason** — 「買受人統一編號」 on company-buyer receipt PDFs is pre-existing merged code (`vendor-receipt-pdf.ts`, with an explicit test exemption): it labels the *buyer company's* tax ID on a vendor-issued receipt, not Condola showing or claiming its own registration. Raised to CEO (BLK-MAC-05) for a copy decision; unchanged here.

## Slice 2 — document integrity (delegated local implementation, 2026-11-06 PT)

**Done means (this slice):** behind the existing strict dual `vendor_documents` gate, a live document capability can append fixed-data/seal versions, supply exact decimal trade items, attach a paper receipt as a sibling, and read history using each document's immutable snapshot/PDF. The full-payment gate has no override. No flag is added or enabled; no hosted database is changed.

### Model and API

- Reuse `vendor_profiles`, immutable `vendor_profile_versions`, `vendor_documents.vendor_profile_version_id`, and immutable `vendor_document_pdf_bytes`. `update_fixed_data` takes `expectedVersion` plus bounded name/contact/address fields and an optional PNG/JPEG seal. Updates append a version; stale concurrent updates fail. Kind, qualification and tax identity stay on the existing onboarding path. New versions reference private immutable `app.b025_profile_seals` rows by ID and SHA-256 only; seal bytes and MIME never enter the member-readable version snapshot, and seal updates never replace an old storage object. Issuance reads fixed data from the selected version; historical downloads return the original integrity-checked PDF bytes.
- `POST /api/vendor-documents`: adds `history`, `update_fixed_data`, `attach_scan`, and optional `tradeItems` on preview/issue/reissue. The history reader exposes only the scoped issuer's documents, immutable issuer display name, version, original item snapshot and sibling metadata. The minimal vendor view displays these with the existing PDF action and sibling download action. No owner prepay/internal settlement fields are returned.
- Trade quantity is a positive decimal **string**, at most 12 integer digits and six fractional places; unit is nonempty text up to 24 characters. Unit price and computed line amount are decimal strings backed by **BigInt** arithmetic, bounded to signed PostgreSQL bigint. Rounding is nearest minor unit with ties up, **once per line**, then sum. Caller-provided totals are not trusted. The sum must match the ticket cost. Existing receipt whole-unit semantics and safe-integer total ceiling are retained; large exact unit prices can be used with fractional quantities when the resulting total fits. Legacy document rows keep their original amount-authoritative calculation and PDFs. Trade rows never use float multiplication/division.
- `app.b025_paper_scans` stores immutable, bounded (5 MiB) PNG/JPEG/PDF bytes separately from the electronic receipt. Its group is the root receipt plus its reissues. A request UUID prevents duplicate scans; conflicting retries fail. No charge, payment, document sequence or original-delivery record is created. `POST /api/vendor-documents/scan` downloads integrity-checked bytes after the same capability/flag checks.
- One additive migration: `20261106170000_b025_vendor_document_integrity.sql`. New private scan and seal tables: RLS enabled, all raw privileges revoked including service role; only pinned-search-path SECURITY DEFINER RPCs have service-role EXECUTE. RPCs revalidate live grant, org, document and flag scope. New reference guards freeze version/PDF/sequence/reissue links and reject cross-org/profile version links. Migration map, exact migration-list test and seed wipe list are registered.
- New server writes call `requireOrgScope` with capability-derived org/environment and masked `recordAudit`, recording identifiers/version only. `requireOrgScope` accepts the two fields it validates, without fabricating a staff session for token actors. No privacy/terms/consent wording changes; the new scan route is classified alongside the existing token-only routes in the entrypoint guard test.

### Verification

Local disposable PostgreSQL 16 database `condola_b025s2`, stub + all migrations in order, then `npm run db:reset`. Tests use cloned databases and loopback-only asset servers. New `b025-document-integrity.integration.test.ts` is included in `test:rls`; pure trade tests are included in `test:unit`.

Coverage: OFF/malformed flag action matrix and whole-row domain/audit fingerprints; exact quantity/rounding/ticket-total mismatch; non-overridable partial-payment gate; old PDF byte equality after fixed-data/seal updates and reissue; historical version attribution; stale version rejection; sibling grouping/idempotency/download; unchanged electronic rows/payment totals; cross-org and cross-grant denial; revoked/expired capabilities; private ACLs and immutable history. Verification results and remaining acceptance are recorded below after execution.

### Remaining

- Onboarding-invitation UI is explicitly out of scope and remains open.
- Rich fixed-data/seal, trade-row and scan-upload forms remain UI follow-up; the backend actions and minimal read-only history are implemented here.
- Independent Claude QA, browser acceptance, staging/release gates and Ron acceptance remain with the orchestrator. Local tests do not establish whole-B-025 completion or release approval.

### Local verification result — 2026-11-06T05:15:30-08:00 PT

- Stub + all migrations applied in order; `npm run db:reset` PASS on the dedicated localhost database.
- `npm run typecheck`, `npm run lint` (0 errors; 15 pre-existing warnings), `npm run copy:check` (6/6), `npm run test:unit` (984/984) PASS.
- `bash scripts/check-function-privileges.sh` PASS; new private scan ACL/RLS, pinned RPC execution and immutable history are additionally covered by the integrity integration test.
- Requested two B-025 integration files: 15/15 PASS. Additional legacy `vendor-batch.integration.test.ts`: 2/2 PASS; combined final run 17/17 PASS. Legacy fixture teardown now deletes its entire document chain in one statement, instead of mutating the newly immutable reissue reference.
- Final base-database readback: `vendor_documents={enabled:false,allowed_org_ids:[]}`, zero enabled orgs, zero paper scans. ON cases ran only on disposable clones. No claim, commit, push, checkout, branch mutation or hosted operation was performed by this delegate.
- Initial type-union and route-classification failures were fixed. One later full-unit run hit the existing `pack-staging-bundle.sh:86` `printf: Broken pipe` failure; isolated recheck and the subsequent full 984-test run passed without changing that script. Failure evidence remains visible; it is not a clean-run claim for every attempt.
- Logs: `/private/tmp/b025s2-migrations.log`, `b025s2-reset.log`, `b025s2-privileges.log`, `b025s2-integration-final.log`, `b025s2-checks-final.log` (contains the transient packaging failure), `b025s2-staging-recheck.log`, `b025s2-unit-confirm.log` (final PASS), `b025s2-unit.log` and `b025s2-typecheck.log` (initial corrected failures). All filenames after the first share `/private/tmp/`.

STOP POINT: LOCAL_SLICE2_VERIFIED; next: `git status --short` then independent Claude review including the new untracked files; owner: Claude@ron-mac (sole committer). Browser/staging/release and whole-B-025 acceptance remain pending.


### Independent QA r1 → fixes — 2026-11-06

- **BLOCKER:** `/tmp/codex-qa-B-025s2.md` correctly identified raw seal base64 in member-readable `vendor_profile_versions.snapshot`. Replaced it with `{id, sha256}` referring to immutable `app.b025_profile_seals`; its RLS is enabled and all table privileges are revoked from PUBLIC/anon/authenticated/service_role. UPDATE/DELETE/TRUNCATE triggers preserve historical bytes. Service-only, pinned-search-path SECURITY DEFINER store/read gateways recheck global/org flags and live, unrevoked, unexpired grant/profile scope; reads join the exact version reference and digest. The PDF seal loader uses this reader and rejects member-role clients before any storage access. Both private-version and legacy object-backed seals require a document capability, including when an existing staff preview path reaches that loader. Legacy file paths are resolved by `app.b025_legacy_seal_path` from the selected immutable version after the same admission checks.
- Added a validated snapshot CHECK rejecting inline seal bytes and extra seal fields. This unapplied migration does not backfill bytes into public rows or rewrite immutable history. A database containing the rejected local snapshot format fails this CHECK and must be rebuilt locally; this is not an upgrade/cleanup migration for previously deployed bad rows. The authorized fresh rebuild removes the old local seed state. Registered the private seal table in the existing local seed wipe list.
- **LOW:** global OFF/malformed/null/missing/not-allowlisted cases now keep the org flag ON. Separate org OFF/malformed cases use valid global settings. Every case exercises the full action matrix, direct scan/seal RPCs and whole-row zero-write fingerprints including private seals and audit rows.
- Added same-org Accountant/Maintenance/Manager and foreign-org authenticated SQL denials, low-level loader denials even with a supplied real grant, staff preview and tokenless context/history/PDF denials, private ACL/RLS/search-path/immutability checks, cross-profile/org and revoked/expired grant denials, exact seal-reference shape and rejection of inline bytes. Authorized PDF generation reads the private seal; v1 and v2 PDFs stay byte-identical after subsequent seal changes and historical private seal reads return the original bytes.

Independent Claude QA remains pending; these local fixes do not supersede its FAIL verdict until re-review.


### R1 local verification — 2026-11-06T05:27:22-08:00 PT

- Fresh `dropdb`/`createdb` of `condola_b025s2` at localhost:55432, stub + all migrations, then `npm run db:reset`: PASS.
- `typecheck`: PASS. `lint`: PASS, 0 errors and 15 existing warnings. `copy:check`: 6/6 PASS. `test:unit`: 984/984 PASS.
- `bash scripts/check-function-privileges.sh`: PASS. Requested four integration files in one sequential run: 20/20 PASS, 0 skipped.
- Final base DB readback: global `vendor_documents={"enabled":false,"allowed_org_ids":[]}`; 0 enabled orgs, 0 snapshots with `seal.base64`, 0 private seals and 0 paper scans. ON fixtures were confined to disposable clones.
- Supplemental independent native Codex source review found the legacy seal fallback gap; it was fixed with a scoped SECURITY DEFINER path reader and legacy denial/positive-byte tests. Re-review found no remaining findings. This source review is supplemental, not Claude Class B acceptance.
- First migration rehearsal failed on JSONB operator precedence in the new CHECK; parentheses fixed it. Subsequent fresh rebuilds passed. Initial failure retained in `/private/tmp/b025s2-r1-migrations.log`; no deployed database was changed.
- Final logs: `/private/tmp/b025s2-r1-final-{migrations,reset,typecheck,lint,copy,unit,integration,privileges}.log` (eight separate files). Only the existing additive migration was changed for schema work. No claim/git mutation/hosted operation was run by this delegate.

STOP POINT: LOCAL_R1_FIXES_VERIFIED_CLAUDE_QA_PENDING; next: independent Claude QA re-review of R1 diff and the final local evidence, including untracked slice-2 files; owner: Claude@ron-mac (sole committer). Flags OFF; browser/staging/release and whole-B-025 acceptance remain pending.

## Slice 3 — document UIs (delegated local implementation, 2026-11-06 PT)

Completes the document-invitation, fixed-data/seal, paper-scan and trade-item UI follow-ups recorded above. No migration, flag activation, remote database operation, deployment, git mutation or external provider call is added/performed. Claude remains architect and sole committer. This slice does not add a new vendor identity/qualification onboarding flow: it invites the assigned, already-onboarded vendor through the existing document gateway, as delegated.

### Entry points and boundaries

- `/m/tickets/[id]`: a new layout appends `VendorDocumentInvites` only when the existing strict `vendor_documents` global boolean, org allowlist and org boolean all admit the org, and the staff role can update tickets. OFF returns the **same children object**. The existing ticket `page.tsx` remains byte-for-byte unchanged (SHA-256 `8255de8c1c492cffe9c28f9521f0d2611f4b478545ecc40fa5d1161a83901f56`). No staff page markup, old dispatch flow or existing API route is rewritten.
- Staff can create an assigned vendor's document invitation, choose an active property owner or company buyer, see active/expired/revoked status, revoke, and copy the newly issued link. Raw capabilities are held only in transient client state and copied by an explicit clipboard action; they never enter rendered hrefs, input fields, query strings, logs or browser storage. Only safe invitation metadata is reloaded. After leaving/reloading, a replacement invitation is required to obtain another link; creating one revokes the prior invitation for that issuer.
- New server actions await current consent, resolve the real session, call `requireOrgScope`, and invoke `createVendorDocumentInvite` / `revokeVendorDocumentInvite`. A `documentUi` option performs strict admission **inside** those gateways' existing transactions before ticket/profile locks; the existing non-UI call signature/behavior remains compatible. Backend `authorizeVendorStaff` still checks both session permission and live DB membership: admin/manager/maintenance allowed, accountant/portal/foreign-org denied.
- `/v/documents/[token]`: current name/contact/address and business-only business/representative/seal fields use `update_fixed_data` with `expectedVersion`; PNG/JPEG seals are bounded to 5 MiB. Historical details and seal-presence metadata come from `vendorDocumentHistoryOn`'s immutable issued snapshot/version, with original PDF download retained. No seal bytes, tax identity, owner prepay or company internal settlement are added to the context/history projection.
- Each receipt has a PNG/JPEG/PDF paper-scan form (5 MiB), posting to the existing `/api/vendor-documents` `attach_scan` action. The existing `/api/vendor-documents/scan` POST downloads the sibling. Retry request IDs persist for the selected file until successful attachment; no electronic artifact/payment/charge is overwritten or duplicated.
- Quantity/unit/item/category editing feeds the existing preview, issue, one-step receipt and reissue gateways. Quantity and `unit_price_minor` stay strings; the shared slice-2 rules compute BigInt line rounding and total equality. Inputs use text + inputMode, never floating-point parsing/arithmetic. Invalid/incomplete rows cannot enable issuance. Multi-row tickets can now provide explicit trade rows; `itemsUnavailable` copy explains this path.
- Shared UI contracts live in `src/lib/vendor-document-ui.ts` to avoid server dependency traversal from client components. Vendor route flag-OFF behavior stays 404. Receipt-not-tax-invoice wording remains visible even while editing an incomplete trade draft.

**Reserves preserved:** PROP-MF-B025 / UC4 and PROP-US-v03-05 / CAP-V-14 remain unchanged: full-payment gate cannot be overridden; partial vendor marks only accumulate; one-step and completion-statement-first paths remain available; a paper scan is a sibling in the same receipt group, with no original-delivery tracking or duplicate charge. Management payment entry does not substitute for the vendor's own marks. The pre-existing company-buyer PDF label under BLK-MAC-05 is untouched. Flags stay OFF; no default-path or per-org product decision is made here.

### Copy inventory

Existing `src/i18n/vendor-documents.ts` has matching zh-TW + en entries for 45 new keys:

- Invitation: `invites`, `inviteNote`, `inviteNotReady`, `companyName`, `buyerTaxId`, `createInvite`, `revokeInvite`, `copyInvite`, `copied`, `copyFailed`, `copyOnce`, `active`, `expired`, `revoked`.
- Fixed data/history: `fixedData`, `versionNote`, `display_name`, `business_name`, `representative_name`, `phone_e164`, `address`, `sealUpload`, `fileLimit`, `saveFixedData`, `sealPresent`, `sealAbsent`, `historicalDetails`.
- Paper scan: `scanUpload`, `scanNote`, `attachScan`.
- Trade editing: `editTrades`, `tradeItems`, `tradeNote`, `name`, `quantity`, `unit`, `unit_price_minor`, `category`, `service`, `labor`, `material`, `addItem`, `removeItem`, `invalidTrade`, `tradeMismatch`.

Existing `itemsUnavailable` is updated in both languages to describe the now-available trade-entry path. No base dictionaries, legal/consent text or PDF labels changed.

### Local verification

Fresh local PostgreSQL database `condola_b025impl` on `127.0.0.1:55432`: DROP/CREATE, Supabase stub, every existing migration in filename order, then `npm run db:reset`. Integration tests clone that designated disposable database; all asset fetches use loopback servers. No full `test:rls` run.

- `typecheck`: PASS.
- `lint`: PASS; 0 errors, 15 existing warnings.
- `copy:check`: 6/6 PASS.
- `test:unit`: 991/991 PASS, including 7 new UI render/input tests.
- New `b025-document-ui.integration.test.ts`: 11/11 PASS. Real session + consent + server actions (only Next request cookies/headers substituted); strict OFF/malformed gate and unchanged rendered-child checks; allowed/denied staff roles and foreign org; replacement/expiry/revoke; exact decimal and beyond-safe-integer prices; full-payment gate; fixed-data/seal version attribution; sibling upload/download/idempotency; unchanged electronic PDF bytes; actual history rendering without token hrefs/query strings.
- Existing `b025-document-integrity.integration.test.ts`: 12/12 PASS.
- Existing `b025-vendor-document-gate.integration.test.ts`: 8/8 PASS.
- Existing `b022-owner-replies.integration.test.ts`: 12/12 PASS.
- All four integration files executed separately with `--test-concurrency=1`; total 43/43. New tests registered in `test:unit` and `test:rls`.
- Base DB readback: `vendor_documents={enabled:false,allowed_org_ids:[]}`, zero enabled orgs, zero paper scans. ON fixtures stay on disposable clones.

Initial failures retained: wrong disposable-test acknowledgement (`1` instead of required `YES`); a fixture sequence query assumed a nonexistent org column; business fixtures initially omitted the required legacy onboarding seal reference; a new negative-copy test itself triggered the existing source-wide owner-term guard; and the static client graph followed type imports into server-only modules. Fixed the test fixtures/negative assertion and moved UI contracts to a pure shared module. No guard was disabled and no migration/backend business rule was relaxed.

Evidence: `/private/tmp/b025s3-db.log`, `b025s3-typecheck-final.log`, `b025s3-lint-final.log`, `b025s3-copy-final.log`, `b025s3-unit-final.log`, `b025s3-ui-integration-final.log`, `b025s3-integrity.log`, `b025s3-gate.log`, `b025s3-owner-replies.log` (all prefixed `/private/tmp/`). Earlier `b025s3-*` logs retain failed attempts.

STOP POINT: LOCAL_SLICE3_VERIFIED_CLAUDE_QA_PENDING; next: Claude reviews the complete working-tree diff including new files and local evidence, then owns any commit; owner: Claude (architect/sole committer). Browser interaction acceptance, independent Claude QA, staging/release and whole-B-025 acceptance remain pending. No further B item started.

## Slice 3 — fix round 2 (2026-11-06, Mode 2 / local delegated implementation)

All three independent QA findings are addressed in the existing working tree; Claude remains architect and sole git committer.

- **MAJOR — issuance key reuse:** `VendorDocumentsPanel` disables fresh issuance for a kind as soon as any document of that kind exists, including voided documents; corrections use void/reissue. Successful issuance also records a local completion guard before context refresh, so a failed refresh cannot re-enable issuance. A voided predecessor with an existing successor cannot be reissued again. Each issuance/reissue attempt stores a detached, exact request body with its date, UUID and optional payment request ID. Unchanged retries reuse that body; changed trade rows, profile version or payment mode/amount are rejected locally with guidance to restore the original details or refresh and reconcile. This deliberately avoids assigning a new key after an uncertain response, which could create a second document if the first request committed. Preview remains available and does not allocate a number.
- **MINOR — legacy seal metadata:** when the issued document has a null profile-version reference, history derives `sealPresent` from the immutable PDF issuance snapshot's `sealFileId`. Versioned history retains its original version-reference calculation. No current-profile lookup or new query is added. The zero-history legacy receipt regression now checks the seal flag, changes the live profile seal reference, and verifies both historical seal presence and original PDF bytes remain unchanged.
- **MINOR — optional address clearing:** the UI sends `address: null` for an individual's cleared/whitespace-only optional address. The shared contract and existing ON-only update gateway explicitly accept that clear operation only for individuals. Omitting the field would silently retain the old address, so the gateway contract is extended narrowly instead. Business addresses and all other required fields still reject null/empty values. The form validates required values, lengths/control characters and international phone syntax before submission, with localized field-specific errors linked by `aria-describedby`/`aria-invalid`. Clearing an address and editing another field succeeds atomically in a new version; prior versions retain their original address.

### Regression and final local verification

- `npm run typecheck`: PASS.
- `npm run lint`: PASS, 0 errors / 15 existing warnings.
- `npm run copy:check`: 6/6 PASS; matching English/Chinese copy keys.
- `npm run test:unit`: **1000/1000 PASS**. The existing UI test file now also mounts real React components in locally installed headless Chromium with all page network requests intercepted. Eight interaction subtests cover receipt/statement issue-edit-void-reissue, unchanged/changed retries for ordinary receipts/one-step receipts/reissues, refresh failure, individual address clearing with another edit and phone validation, and required business-address validation. No live application or DB is used by these interaction tests. The unit suite now requires the already-installed Playwright Chromium runtime; this Mac requires the browser process to launch outside the filesystem sandbox.
- Fresh local PG16 base `condola_b025impl` at `127.0.0.1:55432`: DROP/CREATE, Supabase stub, every migration in filename order, then `npm run db:reset` using the delegated local environment. Each integration file ran in its own separate command with `--test-concurrency=1`, using its disposable clone:
  - `src/server/b025-document-ui.integration.test.ts`: **12/12 PASS**, including combined optional-address clear/name update, immutable earlier version and rejection/rollback of invalid values/business address clearing.
  - `src/server/b025-document-integrity.integration.test.ts`: **12/12 PASS**, including legacy receipt seal history after a live seal change.
  - `src/server/b025-vendor-document-gate.integration.test.ts`: **8/8 PASS**.
- Integration total: **32/32 PASS**. Full `test:rls` was not run.
- Byte comparison against the start-of-round working tree confirms all `src/app` route/page/layout files, admission/invite/document gates, receipt issuance backend, `ops/flags.yaml` and every migration are unchanged. OFF route output/copy/query sequence is preserved; the existing OFF regression tests pass. This round adds no migration.
- Local logs: `/private/tmp/b025-r2-{typecheck,lint,copy,unit,db,integration-ui,integration-integrity,integration-gate}.log`. Initial failures: sandbox Chromium launch was denied by macOS Mach-port isolation and succeeded with the authorized local launch outside the sandbox; interaction tests exposed validation text changing an input's accessible label, fixed by placing errors outside the label; the new individual DB fixture initially retained a business tax field, corrected to respect the existing individual-profile constraint. Final required commands all pass.

STOP POINT: LOCAL_SLICE3_R2_VERIFIED_CLAUDE_QA_PENDING; next: Claude independently reviews this working-tree diff and regression evidence, then owns any git commit; owner: Claude (architect/sole committer). No git write, external network call, remote DB operation, deployment or further B item. Mocked-transport browser interaction regressions are verified; full application browser acceptance, independent QA, staging/release and whole-B-025 acceptance remain pending.

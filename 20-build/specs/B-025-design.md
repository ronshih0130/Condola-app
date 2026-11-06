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

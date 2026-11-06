# B-027 — JIT L2 設計稿：平台隔離、合作同意與 rollout 控制（slice 1–2：flag policy / denial inventory）

> Author: Claude (Mac overnight, 2026-11-06 PT). Layer-2 design for hub `20-build/specs/B-027.md`; foundation PROP-05 (PR #41: platform_settings override audit + registry guard). Branch cut from #41 (`67e756b`).

## Slices

| Slice | Scope | Status |
|---|---|---|
| **1 (this PR)** | Acceptance "Given registry expiry, when CI runs, then canonical warning/failure policy applies": extract the `scripts/gate.sh` flag-expiry logic into `scripts/flag-expiry-policy.cjs` (shared, unit-tested) and add the **seven-day reminder** warning. | built |
| 2 | Executable cross-org / role denial and seven-table grants inventories; local only, staging/production remain PE/release-side. | inventory built; acceptance #1 incomplete: three Accountant findings retained as opt-in failures; independent Claude QA pending |
| 3 | Partner test configuration: plan/upgrade path hiding/redirect (`PARTNER_PRICING_HIDE*`), unit-lock override (`PARTNER_UNIT_OVERRIDE*`) with term expiry / global kill revert, audited 30-day renewals. | todo |
| 4 | Partner consent gate plumbing on approved agreement paths (`PARTNER_CONSENT_GATE`; records append-only actor/version/full-text hash/time — `partner_agreement_consents` exists). | todo |

## Policy (slice 1)

`evaluateFlags(entries, now)` → `{ failures, warnings }`:
- **fail**: missing/duplicate name, missing owner, both `expires`/`expires_at`, non-PT/offset-wrong timestamp, expired (`expires ≤ now`), `stable_ga_at` in the future, or 14 days after stable GA.
- **warn**: expiry within 7 days ("renew with owner approval or remove").
`scripts/gate.sh` prints warnings and fails on any failure (unchanged failure semantics). Unit tests use a fixed clock so CI does not change behaviour by calendar date.

## Finding for Ron (logged)

All 28 registered flags expire **2026-11-10 18:00 PT**; from then `scripts/gate.sh` fails until owners renew (new `expires_at`) or remove them. No expiry was changed here (owner decision).


## Slice 2 done-means

- `src/server/b027-denial-inventory.integration.test.ts` is appended to `test:rls`; real PostgreSQL authorization is exercised for representative manager loaders, read APIs, ticket/repair photos, signed PDF, ID-photo bytes, company audit, and vendor PDF documents.
- Each denial has a same-fixture authorized positive control. Foreign staff is a real Admin member of the other organization. The actual Staff enum is `maintenance`, alongside `manager` and `accountant`; all three are tested against company-wide audit.
- `e2e-evidence/B-027/denial-inventory.md` is generated from executable case metadata, source anchors, and a complete enumeration of `src/app/**/route.ts`. The ordinary test fails if the checked-in table/source lines or enumerated route set drift. Unselected routes are explicitly marked enumerated-only.
- Seven sensitive public tables pin effective anon/authenticated table and column ACLs, grant options, role bypass flags, RLS state and policy definitions. The chosen tables and sensitivity rationale are in the inventory. Existing seven-table RLS is enabled but **not forced**; this is disclosed, not described as owner isolation. A supplemental vendor PDF bytes table checks the expected **FORCE RLS** state and no client privileges. `platform_settings` authenticated global SELECT is intentional. The grant snapshot does not approve the Accountant gaps below.
- Test fixtures run in an owned clone of the explicitly disposable localhost database; cleanup drops the clone. HTTP routes use real database-backed cookie sessions. Only request context and localhost private-object transport are fixtures. No production code/test seam, migration, or feature-flag change was needed.
- Inventory delivery is complete when the normal checks pass and every confirmed gap remains reproducible and documented. Product acceptance #1 remains incomplete until separately authorized fixes and independent QA cover all three findings.

## Finding — slice 2 Accountant photo denial gaps

Confirmed locally on the slice-1 baseline `bccd18b`, with only the new synthetic test fixtures added. No fix is included. The dedicated `readRepairPhoto` / `openTicketPhoto` guards and photo HTTP endpoint deny Accountant correctly, but the lower-level readers do not consistently enforce that rule:

| Finding | Reproducer (test name suffix) | Actual local result | Relevant source |
|---|---|---|---|
| GAP-01 | `Accountant must not read ticket photo file metadata` | `authenticated` with the real Accountant user can SELECT the fixture's `file_name` and `storage_path` from `files`. | Generic `team_read` policy in `supabase/migrations/20261018120000_schema.sql`; `files` is included in the generic member-read set. |
| GAP-02 | `Accountant must not read legacy ticket attachment bytes` | Same user can SELECT nonempty `ticket_attachments.content`. The fixture deliberately populates the supported legacy inline-content column; current uploads usually store private objects instead. This proves ACL/RLS exposure if legacy content exists, not that hosted legacy rows exist. | Generic member `team_read` for `ticket_attachments`; legacy content introduced in `20261023150000_repair_records.sql`. |
| GAP-03 | `Accountant ticket loader must not return photo metadata` | `ticketDetail(accountant, ticketId).photos` includes the fixture filename, storage path, MIME and attachment metadata. | `src/server/queries.ts` (`ticketDetail`); `src/app/m/tickets/[id]/page.tsx` passes `detail.photos` to `RepairThread` alongside a false `canViewPhotos`. Browser serialization/exposure has not been tested here. |

**GAP-03 fixed by Claude (orchestrator, Mode 1, 2026-11-06):** `ticketDetail` no longer queries photo rows for staff without `tickets.update` (Accountant); it returns `photos: []` plus `hiddenPhotoCount`, which `RepairThread`/`RepairPhotos` use only to keep the existing no-permission notice. The GAP-03 case is now an ordinary (non-opt-in) assertion: no photo name, storage path or attachment id appears anywhere in the Accountant payload; Admin positive control unchanged; new `repair.test.ts` unit case renders the notice from the count with no `<img>`/photo URL. Tenants (`kind !== 'staff'`) are unaffected. GAP-01/GAP-02 are RLS policy gaps (generic `team_read` on `files` / `ticket_attachments`) and need a reviewed migration (hub BLK-MAC-12).

The remaining two assertions (GAP-01/02) require `B027_RUN_KNOWN_GAP=1`; they are **skipped explicitly in the ordinary gate**, and remain failing assertions of desired denial (not assertions blessing leakage). The same-org Admin controls succeed and the normal cross-org tests return no photo rows. A green ordinary gate therefore does **not** mean full B-027 denial acceptance. Fixing these policies/readers requires separate orchestrator scope; flags remain OFF.

## Slice 2 verification and limits

Verification target: dedicated `127.0.0.1:55432/condola_b027s2`, PostgreSQL 16; Node 20.20.2 / npm 10.8.2. Created the database, applied `supabase/stub/supabase_stub.sql` and all existing migrations in filename order with `ON_ERROR_STOP=1`, then ran `npm run db:reset`. No hosted DB, staging or production operation occurred.

Verified 2026-11-06T04:41:17-08:00:

| Check | Local result |
|---|---|
| Stub + all existing migrations + `npm run db:reset` | PASS; fresh dedicated DB seeded |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS; 0 errors, 15 existing warnings, none in the new test |
| `npm run copy:check` | PASS; 6 tests |
| `npm run test:unit` | PASS; 987 tests (988 after the GAP-03 unit case) |
| New inventory, normal mode, generated artifact read-only comparison | PASS; after GAP-03 fix + QA LOW fixes: 28 tests, 26 passed, 2 known-gap skips (GAP-01/02) |
| New inventory with `B027_RUN_KNOWN_GAP=1` | EXPECTED FAIL; 26 passed, exactly GAP-01/02 failed; no skips |
| `git diff --check` | PASS |
| Full `npm run test:rls`, release gate, independent Claude verdict | NOT RUN in this delegated slice |

Raw local logs are under `/private/tmp/b027s2-*.log`; final normal and opt-in results are in `b027s2-inventory-check.log` and `b027s2-known-gaps-final.log`. No production or staging readiness is claimed.

Reproduce with the provided local environment (never print its contents), then:

```sh
export DATABASE_URL=postgres://condola:condola@127.0.0.1:55432/condola_b027s2
export CONDOLA_RLS_DISPOSABLE=YES
npx tsx --test --test-concurrency=1 src/server/b027-denial-inventory.integration.test.ts
# Intentionally nonzero until separately approved fixes:
B027_RUN_KNOWN_GAP=1 npx tsx --test --test-concurrency=1 src/server/b027-denial-inventory.integration.test.ts
# Refresh source-line/route inventory only after reviewing changes:
B027_WRITE_INVENTORY=1 npx tsx --test --test-concurrency=1 src/server/b027-denial-inventory.integration.test.ts
```

Limits: representative loaders and read handlers, not all pages/routes or middleware/browser rendering; local private storage transport, not hosted bucket policy or URL expiry validation; no complete SECURITY DEFINER helper audit; no feature activation, staging, production, full release gate, or independent QA verdict. The seven-table policy hash detects policy changes but does not hash helper-function bodies. Staging grants/RLS validation, hosted storage controls, release evidence and production verification remain PE/release-side. Claude holds ownership and remains sole committer/reviewer; no claims or git mutations were performed by this delegated editor.

Codex QA r1 **PASS** (after the GAP-03 fix) with three LOWs, all fixed by Claude: generated instructions now describe only GAP-01/02 as opt-in failures; the audit screen has a same-fixture Admin positive control; the policy-role hash maps OID 0 to `PUBLIC` (no current policy uses PUBLIC, so pinned hashes are unchanged).

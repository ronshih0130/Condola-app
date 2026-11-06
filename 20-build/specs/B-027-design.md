# B-027 — JIT L2 設計稿：平台隔離、合作同意與 rollout 控制（slice 1–3：flag policy / denial inventory / partner controls）

> Author: Claude (Mac overnight, 2026-11-06 PT). Layer-2 design for hub `20-build/specs/B-027.md`; foundation PROP-05 (PR #41: platform_settings override audit + registry guard). Branch cut from #41 (`67e756b`).

## Slices

| Slice | Scope | Status |
|---|---|---|
| **1 (this PR)** | Acceptance "Given registry expiry, when CI runs, then canonical warning/failure policy applies": extract the `scripts/gate.sh` flag-expiry logic into `scripts/flag-expiry-policy.cjs` (shared, unit-tested) and add the **seven-day reminder** warning. | built |
| 2 | Executable cross-org / role denial and seven-table grants inventories; local only, staging/production remain PE/release-side. | inventory built; acceptance #1 incomplete: three Accountant findings retained as opt-in failures; independent Claude QA pending |
| 3 | Partner test configuration: plan-section hiding and upgrade/pricing redirect (`partner_pricing_hide`), unit allowance override (`partner_unit_override`), term expiry/global kill revert and audited 30-day renewals. | built locally; verification below; independent Claude QA pending |
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


## Slice 3 done-means — 2026-11-06 PT

Baseline: `42aed1a3499e31ba2da3a07576a566a91a530a85`. Claude (`Claude@ron-mac`) holds the repository lock and is sole committer. This delegated edit made no claim, commit, branch, checkout or push. The hub acceptance document was read; the requested hub design copy is absent, so this checkout's existing design is updated.

- `partner_pricing_hide` and `partner_unit_override` are registered with Ron as owner, `default: false`, internal ring and the existing **2026-11-10 18:00 PT** expiry. The new migration seeds exactly `{"enabled":false,"allowed_org_ids":[]}` using `ON CONFLICT DO NOTHING`. It changes no existing allowlist or organization opt-in.
- `20261106180000_b027_partner_controls.sql` adds private `app.b027_partner_overrides` and append-only `app.b027_partner_override_events`. Both enable RLS and revoke all direct API-role table privileges, including service-role privileges. RLS is not forced; the migration owner remains trusted. Event UPDATE/DELETE/TRUNCATE is rejected by triggers. The migration is registered in the migration classifier, exact migration test list and seed wipe list (events before overrides).
- Overrides have one current row per organization/kind, original `created_by`, monotonically increasing revision, revoked state and a half-open `[starts_at, expires_at)` term of at most **720 elapsed hours**. Unit limits are integers **1–10,000**; pricing-hide rows cannot carry a unit limit. Create requires revision 0 and absence; renew/revoke require the exact current revision. Renewal keeps the unit limit and starts a fresh **1–30 day term from server time**, never stacks days onto the previous expiry. Expired, unrevoked terms can renew; revoked terms cannot silently reactivate.
- Pinned-search-path SECURITY DEFINER gateways check the mandatory selected org/environment and current canonical live membership. The read RPC is authenticated staff-only; the admin mutation RPC is **service-role-only** and checks the actor's actual active Admin membership. `changePartnerOverride` calls `requireOrgScope`, pins that scope, then performs mutation plus masked `recordAudit` in one service transaction. There is no new public route, admin UI or authenticated direct writer grant. Setting/org/member locks and a per-org/kind advisory lock serialize admission and revisions. Every successful create/renew/revoke appends a typed event with actor, revision, term and unit limit; arbitrary personal text is never accepted.
- OFF requires no cleanup: missing/malformed settings, malformed UUID allowlists, absent org opt-in, explicit kill, revoked state, future start or exact expiry all return the legacy result. Reads perform no domain writes. OFF commands return unavailable (`null`) after authorization and perform no domain/audit writes. The existing store remains available for historical audit.
- There was **no `upgrade-gate.ts` implementation or unit creation/access cap** on this baseline. The new gate returns the effective unit limit; `billing.ts` and the existing pricing calculator use the term as the free-unit allowance, falling back to the existing code snapshot/default allowance on expiry. Existing seat limits, price rates, billing tiers, unit/lease creation permissions and ledger writers are unchanged. This is not evidence of a new portfolio access-lock mechanism.
- Pricing hide redirects `/pricing` and `/m/upgrade` to the existing `/m` dashboard before price rendering. On `/m/settings` it hides only the plan/sandbox-plan content; mail settings, payee settings, consent history, admin navigation and other settings remain available. `/pricing` evaluates controls against `liveOrgId` in the live environment, matching its prices and usage even when navigation selects a sandbox. OFF keeps the existing `/m/upgrade` → `/m/settings` redirect and existing page trees. Anonymous pricing remains unchanged. No legal, consent, pricing-marketing or zh-TW dictionary text was edited.
- Gate reads are uncached and evaluate fresh database facts at each server invocation; synthetic tests supply an explicit instant. Client calculator terms recheck expiry on calculation. Already-open rendered pages are snapshots, with no push-based kill notification; a new server request observes the kill immediately. The calculator is a display estimate, not financial write authority.

## Slice 3 initial verification (before QA round 1)

Target: owned localhost PostgreSQL 16 database `127.0.0.1:55432/condola_b027s3`; Node 20.20.2/npm 10.8.2. Created fresh, applied `supabase/stub/supabase_stub.sql` and all migrations in filename order with `ON_ERROR_STOP=1`, then `npm run db:reset`. Integration fixtures run in temporary owned clones and drop them afterward; the source database retains both new flags OFF.

| Check | Local result |
|---|---|
| Fresh stub + all migrations + `npm run db:reset` | PASS |
| `npm run typecheck` | PASS; repeated after final edits |
| `npm run lint` | PASS; 0 errors, 15 pre-existing warnings; final changed-file lint also PASS |
| `npm run copy:check` | PASS; 6 tests |
| `npm run test:unit` | PASS; 993 tests; final changed rules rerun 5/5 PASS |
| `bash scripts/check-function-privileges.sh` | PASS; zero anon public-function execute; existing allowlist unchanged |
| Exact flag-expiry Node block extracted from `scripts/gate.sh`, executed on stdin from repository root | PASS; 30 records; seven-day warnings retained for the November 10 expiry |
| Partner controls + denial inventory integration command below | PASS; 38 tests, 36 passed, 2 explicitly retained GAP-01/02 skips |
| `git diff --check` | PASS |
| Full `npm run test:rls`, pinned release gate, browser/staging, independent Claude QA | NOT RUN by this delegated editor |

The ten partner integration cases cover actual server-page redirects; default/malformed/missing/OFF configurations; complete public/app table snapshots with zero domain writes (excluding normal `auth_sessions` touch); unchanged OFF page trees; ON allowance; exact synthetic term boundaries; kill/opt-out; audited renewal and revision conflict; cross-org/non-Admin/forged-role/missing-scope/environment denial; private ACL/RLS and pinned definer configuration; audit-failure atomic rollback; database term/unit bounds; and revoke. These are server-component invocation tests, not browser rendering acceptance. The existing GAP-01/02 Accountant RLS failures remain outside this slice.

```sh
# Source the authorized local environment without printing it first.
export DATABASE_URL=postgres://condola:condola@127.0.0.1:55432/condola_b027s3
export CONDOLA_RLS_DISPOSABLE=YES
npx tsx --test --test-concurrency=1 src/server/b027-partner-controls.integration.test.ts src/server/b027-denial-inventory.integration.test.ts
```

Local logs: `/private/tmp/b027s3-migrations.log`, `b027s3-db-reset.log`, `b027s3-typecheck-final.log`, `b027s3-lint.log`, `b027s3-lint-final.log`, `b027s3-copy.log`, `b027s3-unit.log`, `b027s3-rules-final.log`, `b027s3-privileges.log`, `b027s3-flag-expiry-final.log`, `b027s3-integration-final.log`. Initial test-harness failures are preserved separately: circular React component serialization and unordered UNION snapshots were corrected; the infinity bound probe now expects PostgreSQL's explicit `22008` arithmetic rejection. The first extracted flag check was incorrectly launched as a file under `/tmp` and could not resolve repository dependencies; running the identical block on stdin from the repository passed.

## Slice 3 QA round 1 → fixes (2026-11-06 PT)

Independent QA result `/tmp/codex-qa-B-027s3.md` was **FAIL**. This local fix round addresses all four findings; that verdict is retained and independent re-review remains pending.

| QA finding | Fix and regression evidence |
|---|---|
| BLOCKER: settings-page redirect removes unrelated settings | Removed the page redirect. Only `settings-plan` / `sandbox-plan` content is conditional. ON assertions retain the mail controls, retention settings, and mounted payee/consent-history server components while the plan content disappears. |
| BLOCKER: sandbox controls mixed with live pricing/usage | `/pricing` normalizes the control session to `liveOrgId`, `environment: live`, `needsSandbox: false`. Real database/server-page tests prove sandbox OFF cannot bypass live hiding; sandbox allowance 77 does not affect live usage/prices; live allowance 20 still applies with sandbox selected. |
| LOW: eight SQL commands even when OFF | OFF now reads canonical membership, environment, org flags and both platform flags in a single SELECT / implicit transaction. Query-budget regression records exactly one connection and one query, without role/pin setup or private override RPC. ON still calls the protected RPC and rechecks scope/flags. No cross-request cache or private-table privilege expansion. |
| LOW: legacy reference derived from modified pages | Added explicit expectations derived by reading baseline `42aed1a`: live settings plan and unrelated controls; sandbox plan banner; pricing list labels, sections, live calculator units and settings CTAs; anonymous default 30 units/signup CTAs; OFF upgrade redirect to `/m/settings`. Existing OFF equality/snapshot tests remain additional checks. |

Verification after `npm run db:reset` on localhost `127.0.0.1:55432/condola_b027s3`:

- `typecheck`: PASS, including a final run after the last test addition.
- `lint`: PASS, 0 errors / 15 existing warnings; final changed-file lint PASS with no output.
- `copy:check`: PASS, 6/6.
- `test:unit`: PASS, 993/993, no failures or skips.
- `bash scripts/check-function-privileges.sh`: PASS; anon execute zero, existing seven-function public allowlist unchanged.
- Requested partner-controls + denial-inventory integration command: PASS, 42 tests / 40 passed / 0 failed / 2 existing GAP-01/02 skips. Those unrelated gaps remain unresolved.
- Source database readback: both platform flags OFF with empty allowlists; zero orgs opted into either flag. Integration ON fixtures were confined to disposable clones.
- `git diff --check`: PASS. No migration edits were needed in this fix round; the existing local migration remains the only slice-3 migration.

Logs: `/private/tmp/b027s3-r1-db-reset.log`, `b027s3-r1-typecheck-final.log`, `b027s3-r1-lint.log`, `b027s3-r1-lint-final.log`, `b027s3-r1-copy.log`, `b027s3-r1-unit.log`, `b027s3-r1-privileges.log`, `b027s3-r1-integration-final.log`, `b027s3-r1-flags.log`.

These are local server-component and database checks, not browser/staging or release acceptance. The delegated editor performed no claim operation, commit, push, branch/checkout, hosted access or flag activation. Claude remains the owner and sole committer.

## Remaining slice 4 / handoff

Slice 4 remains **TODO**: partner-consent gate plumbing on approved agreement paths using existing append-only actor/version/full-text-hash consent records. The existing `20261030151300`/`151301` consent migrations were inspected and not altered. No consent activation or legal wording change is included here. Independent Claude review of this uncommitted diff, staging/browser acceptance, complete B-027 denial acceptance and release verification remain outstanding. Local checks do not authorize deployment or flag activation.

STOP POINT: B027_SLICE3_QA_R1_FIXES_LOCAL_VERIFIED; next: Claude reviews the local diff and verification logs, then commits under the existing ownership session; owner: Claude@ron-mac.

Slice 3 QA (orchestrator, 2026-11-06): Codex QA r1 **FAIL** (pricing hide redirected the whole settings page; controls evaluated on the selected sandbox org while prices/usage use the live org) → fixes (only the plan section hidden; controls on the live org; OFF path one query; explicit legacy assertions) → **r2 PASS**. Residual LOW: with both flags OFF the pricing/settings pages still run one extra control SELECT on a separate connection per request (fold into a request-scoped connection later).

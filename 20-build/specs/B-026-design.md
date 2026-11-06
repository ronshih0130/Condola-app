# B-026 — JIT L2 設計稿：廠商估價、帳號／歷史與強化分享（slice plan）

> Author: Claude (Mac overnight, 2026-11-06 PT). Layer-2 design for hub `20-build/specs/B-026.md`, incl. the **inherited ON-blocking conditions** (PROP-01b r2 item B, PROP-10 r2 V-12/V-13 ordering) and the **FR-P0-04 acceptance extension** (V-12 legacy `/v/[token]` keeps working; V-13 login auto-links open jobs with traceable/correctable mis-links). Stacked after B-025.

## Slices

| Slice | Scope | Status |
|---|---|---|
| **1 (this PR)** | Inherited ON-conditions: (a) `vendor-identity.ts` hash uses fully qualified core `pg_catalog.sha256(pg_catalog.convert_to(..,'UTF8'))` instead of pgcrypto `digest()` (no search_path dependency); (b) `planVendorAttribution` runs only after the post-state capability recompute in `loadVendorJob` succeeds (V-13 ordering) — still inert (void, no writes). | built |
| 2 | Vendor-token estimate submission (versioned, photos) reusing B-013 `app.b013_estimate_heads/versions` through a token-scoped SECURITY DEFINER path; above-threshold ⇒ B-013 approval starts and work stays blocked; manager estimate/document comparison (CAP-M-24). Flag `VENDOR_ESTIMATES*` OFF. | todo |
| 3 | Invited vendor account claim (PROP-10 identity link), account settings/history listing only assigned authorized jobs; token-only history request denied; V-13 auto-link of open jobs with correction trail. Flag `VENDOR_ACCOUNT*` OFF. | todo |
| 4 | Enhanced sharing: closed job ⇒ read-only, only approved shared photos (extends existing `vendorLinkSafeView`). `VENDOR_LINK_ENABLED` stays OFF until V-12+V-13 pass. | QA r1 FAIL corrected locally; independent re-review pending |

## Done means (slice 1)

The vendor identity query resolves without pgcrypto on `search_path`, and an enhanced vendor-link load whose capability expires between the first read and the post-state check produces no attribution plan. Flag-OFF paths are byte-for-byte unchanged (the resolver/planner run only when `vendor_link` is enhanced).

## Verification (slice 1)

- Unit `src/server/vendor-identity.test.ts` asserts the exact SQL uses `pg_catalog.sha256` and contains no `digest(`.
- Integration vendor-link/vendor-repair suites unchanged in behaviour.
- **Still required before ON (not provable from the Mac):** run the identity query under the staging and production application roles (hosted; PE).

## Done means (slice 4)

Existing terminal states are `closed` (completed/settled) and `cancelled`; `resolved` remains reportable under the existing model. Enhanced links remain readable until expiry/revocation, but response, completion, report/cost and upload controls are hidden. Enhanced mutation requests reject before approval readers and recheck the token, assignment, sharing approval and writable capability in the same transaction as the appointment gateway, including retries. The gateway guard acquires the exact B-013 actor/request advisory lock before ticket→jobs, matching staff gateways. The existing dispatch-policy query supplies the trusted server-only enhanced branch; no request-body field can select it, and both OFF configurations retain the original SQL and transaction sequence. Closure while waiting for the lock produces no domain, command, event or audit writes. Notification marking holds a ticket SHARE lock in its marking transaction and rejects terminal enhanced jobs before entering the notification gateway; NOWAIT preserves the center busy/retry behavior. Closed notification pages show unread state without a mark control.

Closed enhanced photo lists and the byte-serving route require an explicit `repair_vendor_job_shared_photos` selection plus current non-internal status, matching organization/ticket/assignment and sharing approval. Vendor-origin completion photos no longer bypass the selection after closure. Hidden photo IDs, names and paths never appear in the view and denied downloads do not access storage. Open-job photo behavior and the original OFF SQL/legacy response remain unchanged. The existing `vendorLinkSafeView` field allowlist is retained.

No migration, flags, planner side effects or product/legal copy changes. `VENDOR_LINK_ENABLED` remains false; organization/platform test flags are enabled only inside a disposable local clone, restored exactly and read back before the clone is removed.

## Verification (slice 4, local only)

- `src/server/b026-closed-job-readonly.integration.test.ts`, appended to `test:rls`: both terminal states; HTTP propose/reject/accept-confirm, completion, upload sign/confirm and server report rejection; full relevant table snapshots unchanged; direct gateway/replay closure race with observed PostgreSQL lock wait; approved issue/completion photos and unshared/internal negatives; open report/upload and appointment-gateway positive controls; OFF/org-OFF legacy response bytes and photo redirects.
- `src/app/v/[token]/vendor-job-off.test.ts` (already in `test:unit`): enhanced read-only/unapproved pages bypass mutation-state resolution while legacy/open paths retain it; existing controls tests retained.
- Local PostgreSQL 16: fresh `condola_b026s4`, stub + all migrations in order, `npm run db:reset`; typecheck, lint (0 errors, 15 existing warnings), copy check (6 tests), unit (982 tests) PASS. The four requested integration files PASS (12 tests, 0 failures/skips), including 5 new slice-4 tests. Storage responses are mocked locally; no hosted storage/browser/deploy evidence.
- Earlier new-fixture failures retained in `/private/tmp/b026s4-target.log` and `/private/tmp/b026s4-integration.log`: fixture initially replaced the job token with the storage token and omitted storage-info JSON. Both fixture defects corrected; assertions retained.

## QA round 1 → fixes (2026-11-06, local only)

The independent FAIL in `/tmp/codex-qa-B-026s4.md` is retained; these are fixes awaiting a fresh independent verdict.

- **Request-lock inversion:** enhanced appointment guard now takes the exact `b013_replay` advisory key before any ticket/job row lock. A deterministic two-client regression holds the staff request lock, observes the vendor's advisory wait, obtains ticket/job locks with NOWAIT, executes the real staff gateway and commits; the vendor then returns `rejected_conflict`. The original closure/replay race remains covered.
- **V-12 OFF queries:** removed the standalone pre-reader transaction and redundant organization flag query. `orgVendorDispatchPolicy` reuses the original dispatch SELECT; `mutationScope` passes its server-derived branch into the existing reader transaction and appointment credential. Instrumented client traces require both kill-OFF/org-ON and kill-ON/org-OFF to retain baseline response/completion query counts (16), transaction boundaries (3), gateway query count (5), and identical raw SQL text. Existing legacy view-byte/photo redirect checks remain.
- **Notification marking:** same-transaction ticket SHARE/NOWAIT guard rejects terminal enhanced jobs before marking. A real notification recipient has an open HTTP 200 control, an in-flight closure busy/zero-write control, and closed/cancelled HTTP 404 controls. Rendered notification HTML has no mark button. Zero-write snapshots now include center events, recipients, reads, mark contexts and cursors.
- **Meaningful HTTP negatives:** real current estimates replace fabricated version IDs. Paired open and closed HTTP calls are instrumented: open calls reach the known B-024 permission-failing reader; closed calls reject at locked capability admission and never execute that reader. A forged body `enhanced:false` does not bypass admission. This proves the closed-job boundary without granting additional table access or claiming the pre-existing open HTTP failure is fixed.
- **Verification:** local `condola_b026s4`, authorized local environment, `npm run db:reset` first. Typecheck PASS; lint PASS (0 errors, 15 existing warnings); copy check 6/6; unit 982/982; all six requested integration files 35/35, zero failures/skips. Final focused rerun covers the last trace/body assertions. Logs: `/private/tmp/b026s4-r1-{reset,typecheck-final,lint-final,copy,unit,integration,target-final}.log`. Earlier fixture failures retained in `b026s4-r1-target{,2,3}.log` (missing synthetic notification, missing Host header, JSX React import); none were waived.

No migration, flag-file edit, claim command, git commit/push/branch/checkout, hosted access or deployment. Independent re-review belongs to the orchestrator/Claude lock holder.

## Remaining slices and ON blockers

Slices 2–3 remain TODO: vendor-token estimates/manager comparison and invited account/history/attribution. There is currently no vendor estimate mutation route; staff `submitEstimate` remains session-authorized. Slice 2 must apply the same locked closed-job admission to its future token gateway and add estimate-route rejection tests; no estimate functionality is claimed here.

Existing B-024 open response/completion readers select `app.b013_estimate_heads` / `app.b013_repair_commands` directly although `service_role` lacks SELECT. This slice does not broaden those grants or claim open HTTP response/completion acceptance; positive appointment coverage exercises the existing SECURITY DEFINER gateway. The real-version HTTP pairs explicitly observe the open reader failure and prove closed enhanced routes reject before those readers; the closed page bypasses them. A scoped reader fix and open HTTP/browser acceptance remain required before enablement.

Independent Claude QA, hosted application-role hash verification and V-12/V-13 enablement acceptance remain pending. All enhanced/account/estimate flags stay OFF; planner remains inert.

### QA status (orchestrator, 2026-11-06)

Codex QA r1 FAIL (lock inversion vs `b013_replay`, V-12 extra queries, closed-job notification mark-read writable, vacuous negatives) → fixes → **r2 FAIL** on the notification path only; all r1 fixes verified (request advisory lock now precedes ticket→jobs with a deterministic regression; response/completion OFF paths reuse dispatch policy with no extra queries; closed marks rejected under the ticket lock; real-version negatives with open/closed traces). **Open after the 2-round cap (hub BLK-MAC-13):** (1) kill switch ON + org flag OFF: `centerVendorItems` runs one extra policy query (6 vs 5) — V-12 deviation on the notification path; (2) closed-job notification *reads* still use the existing `app.b028_center_vendor` gateway, which deletes expired and inserts pagination cursors (notification bookkeeping, not vendor domain rows) — needs a write-free closed-job read path. Enhanced vendor links stay OFF (`VENDOR_LINK_ENABLED`) until both close.

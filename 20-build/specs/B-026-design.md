# B-026 — JIT L2 設計稿：廠商估價、帳號／歷史與強化分享（slice plan）

> Author: Claude (Mac overnight, 2026-11-06 PT). Layer-2 design for hub `20-build/specs/B-026.md`, incl. the **inherited ON-blocking conditions** (PROP-01b r2 item B, PROP-10 r2 V-12/V-13 ordering) and the **FR-P0-04 acceptance extension** (V-12 legacy `/v/[token]` keeps working; V-13 login auto-links open jobs with traceable/correctable mis-links). Stacked after B-025.

## Slices

| Slice | Scope | Status |
|---|---|---|
| **1 (this PR)** | Inherited ON-conditions: (a) `vendor-identity.ts` hash uses fully qualified core `pg_catalog.sha256(pg_catalog.convert_to(..,'UTF8'))` instead of pgcrypto `digest()` (no search_path dependency); (b) `planVendorAttribution` runs only after the post-state capability recompute in `loadVendorJob` succeeds (V-13 ordering) — still inert (void, no writes). | built |
| 2 | Vendor-token estimate submission (versioned, photos) reusing B-013 `app.b013_estimate_heads/versions` through a token-scoped SECURITY DEFINER path; above-threshold ⇒ B-013 approval starts and work stays blocked; manager estimate/document comparison (CAP-M-24). Flag `VENDOR_ESTIMATES*` OFF. | todo |
| 3 | Invited vendor account claim (PROP-10 identity link), account settings/history listing only assigned authorized jobs; token-only history request denied; V-13 auto-link of open jobs with correction trail. Flag `VENDOR_ACCOUNT*` OFF. | todo |
| 4 | Enhanced sharing: closed job ⇒ read-only, only approved shared photos (extends existing `vendorLinkSafeView`). `VENDOR_LINK_ENABLED` stays OFF until V-12+V-13 pass. | todo |

## Done means (slice 1)

The vendor identity query resolves without pgcrypto on `search_path`, and an enhanced vendor-link load whose capability expires between the first read and the post-state check produces no attribution plan. Flag-OFF paths are byte-for-byte unchanged (the resolver/planner run only when `vendor_link` is enhanced).

## Verification (slice 1)

- Unit `src/server/vendor-identity.test.ts` asserts the exact SQL uses `pg_catalog.sha256` and contains no `digest(`.
- Integration vendor-link/vendor-repair suites unchanged in behaviour.
- **Still required before ON (not provable from the Mac):** run the identity query under the staging and production application roles (hosted; PE).

## Not in this slice

Everything in slices 2–4; no flag changes; no hosted verification.

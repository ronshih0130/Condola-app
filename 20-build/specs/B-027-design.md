# B-027 — JIT L2 設計稿：平台隔離、合作同意與 rollout 控制（slice 1：flag registry expiry policy）

> Author: Claude (Mac overnight, 2026-11-06 PT). Layer-2 design for hub `20-build/specs/B-027.md`; foundation PROP-05 (PR #41: platform_settings override audit + registry guard). Branch cut from #41 (`67e756b`).

## Slices

| Slice | Scope | Status |
|---|---|---|
| **1 (this PR)** | Acceptance "Given registry expiry, when CI runs, then canonical warning/failure policy applies": extract the `scripts/gate.sh` flag-expiry logic into `scripts/flag-expiry-policy.cjs` (shared, unit-tested) and add the **seven-day reminder** warning. | built |
| 2 | Cross-org / role denial inventory incl. Accountant photos and non-Admin company audit; seven-table grants inventory (local; staging is PE). | todo |
| 3 | Partner test configuration: plan/upgrade path hiding/redirect (`PARTNER_PRICING_HIDE*`), unit-lock override (`PARTNER_UNIT_OVERRIDE*`) with term expiry / global kill revert, audited 30-day renewals. | todo |
| 4 | Partner consent gate plumbing on approved agreement paths (`PARTNER_CONSENT_GATE`; records append-only actor/version/full-text hash/time — `partner_agreement_consents` exists). | todo |

## Policy (slice 1)

`evaluateFlags(entries, now)` → `{ failures, warnings }`:
- **fail**: missing/duplicate name, missing owner, both `expires`/`expires_at`, non-PT/offset-wrong timestamp, expired (`expires ≤ now`), `stable_ga_at` in the future, or 14 days after stable GA.
- **warn**: expiry within 7 days ("renew with owner approval or remove").
`scripts/gate.sh` prints warnings and fails on any failure (unchanged failure semantics). Unit tests use a fixed clock so CI does not change behaviour by calendar date.

## Finding for Ron (logged)

All 28 registered flags expire **2026-11-10 18:00 PT**; from then `scripts/gate.sh` fails until owners renew (new `expires_at`) or remove them. No expiry was changed here (owner decision).

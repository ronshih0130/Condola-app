# ADR-110 — Free-unit threshold: 4 (code) vs 5 (Ron) — one source of truth

| | |
|---|---|
| Status | **ACCEPTED with amendments** — CEO ruling 2026-11-13 PT (box `ops/reviews/ceo-review-1113-phase0-batch.md`, relayed by Ron; hub `11-decisions/DECISIONS.md`) |
| Date | 2026-11-13 PT |
| App SHA | `1e0a8ab` (GitHub `main`) |
| Requirement | hub `20-build/MAC-CLAUDE-HANDOFF-1112.md` §2.4, §5, §8 R7; hub `20-build/specs/B-056.md` "Billing threshold (C4 / C1)" |
| Related | ADR-111 (trial engine), `docs/phase0/domain-model.md` §8 and §11 |

Docs only. This ADR changes no constant, migration, flag or price. Schema statements are from migrations, not a live dump.

## Context

Four places hold a "free units" number, and they disagree.

| # | Where | Value | Used for | Evidence |
|---|---|---|---|---|
| 1 | `FREE_UNITS` | 4 | `monthlyAmount` default allowance; fallback in `resolveCommercialPrice`; argument to `upgradeGate` on three pages | `src/server/billing.ts:6,34,64`; `src/app/m/settings/page.tsx:26`, `src/app/m/upgrade/page.tsx:12`, `src/app/pricing/page.tsx:33` |
| 2 | `FREE_ACTIVE_UNITS` | 4 | `overFree()` only | `src/server/sandbox-data.ts:5,192-195` |
| 3 | `partner_codes.free_units` (default 4), copied to `firm_partner_prices.free_units` | 4 unless a partner code says otherwise | per-org allowance snapshot, wins over list while its lock is in force | `supabase/migrations/20261022120000_self_serve_signup.sql:36,62`; `billing.ts:64` |
| 4 | `INTERIM_FREE_UNITS` | 5 | B-045 display only ("never used to invoice") | `src/server/b045-pricing-interim-rules.ts:139-141,159` |

Other facts:

- Ron's wording is "free up to 5 units"; B-056 ACs say "5 戶" throughout (MGT-97-AC1, MGT-99-AC2/AC4).
- **No server-side unit cap exists today.** `overFree()` has no non-test caller and `errors.planLimit` is defined (`src/i18n/errors.ts:59`) but never thrown (grep over `src`, tests excluded). So 4 vs 5 currently changes **money shown/quoted**, not what a user may do.
- A third allowance source exists: a partner unit override (`unitOverride.unitLimit`, `billing.ts:64`) wins over both the snapshot and `FREE_UNITS`.
- Hard limit: "`FREE_UNITS` stays 4 until a billing GO (C4)" and "Don't change plan tiers" (handoff §5). The `pricing_interim` registry entry repeats "do not change billing.ts FREE_UNITS or LIST_* constants" (`ops/flags.yaml:504`).
- C4 defers the billing-change GO request to the B-056 design note: PE files it to the CEO "with impact scope + internal-org tests" (B-056 spec).
- Which orgs hold a partner snapshot, and with what `free_units`, is **unverified** (no live read; aggregates only when it is read).

## Decision drivers

1. One number must not mean two things silently (invoice allowance vs read-only threshold).
2. No billing change without the C4 GO; the code value 4 must stay until then.
3. B-056 must be designable now against 5 without waiting for the GO.
4. Flag OFF must stay byte-for-byte unchanged.
5. A future change of the number should be a one-line change with a clear blast radius.

## Options

**Option A — Leave three constants; B-056 adds its own "5".**
Consequence: fastest; but a fifth copy appears, and after the GO someone must find and change all of them. Read-only threshold (5) and invoicing allowance (4) can drift apart again without anyone deciding it.

**Option B — Change everything to 5 now.**
Consequence: violates handoff §5 and C4. Changes quotes for orgs with 5+ units before a GO. Rejected.

**Option C — Name two concepts, keep today's values, converge under the C4 GO.**
Define two concepts in one module:
- *invoice allowance* — units not charged. Stays **4** (today's `FREE_UNITS`), still overridable by partner snapshot / unit override exactly as today.
- *Free-plan capacity* — units a Free org may keep editable after trial expiry. **5**, used only behind the `pricing_trial*` flag (ADR-111).

`FREE_ACTIVE_UNITS` and `INTERIM_FREE_UNITS` become references to these two (no value change). The C4 GO then decides whether invoice allowance moves 4 → 5; if it does, the two concepts collapse to one constant in a single small PR.
Consequence: a period where "free" means 4 for money and 5 for capacity. That is already true today between `billing.ts` and the B-045 display; this option makes it explicit and testable instead of accidental.

## Recommended option

**Option C.** It respects the hard limit, lets B-056 design against 5, and turns the eventual billing change into one reviewed line. Constant names are OPEN (proposed: one name for the invoice allowance, one for the Free-plan capacity; final names in the B-056 design note).

Precedence rule to confirm (proposed, matches today's `resolveCommercialPrice`): unit override → partner snapshot in force → list default. Whether partner `free_units` also raises the **read-only** threshold is OPEN (Q3 below); the proposed default is **no** — read-only capacity is the plan's number, not a commercial discount.

## Consequences

- No behaviour change until a PR is approved; the refactor PR is value-neutral and provable by existing unit tests plus a "values unchanged" assertion.
- The billing-change GO request becomes a concrete artefact: list of call sites (table above), count of orgs whose quote changes (aggregate only), and tests on Ron's 4 internal orgs.
- `overFree()` either gets its first real caller in B-056 or is deleted there; it must not stay as dead code with its own constant.
- B-045 display (5) and invoicing (4) remain inconsistent for flag-ON orgs until the GO. This is a known, already-live inconsistency for 2 internal live orgs (handoff §3a); it must be stated in the GO request.

## What this ADR does NOT decide

| # | Open question | Owner |
|---|---|---|
| Q1 | Does the invoice allowance move 4 → 5, and on what date / for which orgs (new only, or existing too)? This is the billing-change GO (C4 / R7) | Ron, via CEO |
| Q2 | Do orgs with an in-force partner snapshot (`free_units` possibly ≠ 4/5) keep their snapshot value after the change? | Ron, via CEO |
| Q3 | Does a partner `free_units` or unit override also raise the read-only capacity after trial expiry? | Ron, via CEO |
| Q4 | Should the default of `partner_codes.free_units` change for **new** codes (a schema default change)? | CEO (schema PR; see below) |
| Q5 | "Unit" for this threshold: per unit, or per room for `by_room` units (today's billable count is `coalesce(target_room_id, target_unit_id)`, `partners.ts:309-314`) | Ron, via CEO (shared with ADR-111 O8) |
| Q6 | Final constant names and module location | CEO, in the B-056 design-note review |
| Q7 | Sandbox orgs: `overFree` returns false for sandbox today — keep? | CEO |

## Implementation sketch

| PR | Content | Gate |
|---|---|---|
| PR-1 (docs) | This ADR + the C4 billing-change GO request filed with the B-056 design note | CEO review |
| PR-2 (code, value-neutral) | Introduce the two named concepts in one module; point `FREE_ACTIVE_UNITS` and `INTERIM_FREE_UNITS` at them; no number changes | hosted CI green + non-author QA on the exact SHA |
| PR-3 (code, behind `pricing_trial*`) | B-056 uses the Free-plan capacity for read-only enforcement (ADR-111) | Class B + security review |
| PR-4 (billing change) | Only after Ron's GO: invoice allowance 4 → 5, collapse to one constant | **billing-change GO (C4)**, non-author QA, CEO exact-SHA GO |
| PR-5 (schema, only if Q4 = yes) | Change the column default for new partner codes; no backfill of existing rows | **schema PR: non-author QA + CEO exact-SHA GO before any staging apply** |

No PR here turns a flag ON or edits `ops/flags.yaml` expiries.

## Verification

Per GLOSSARY "Verify" — observe the result in the real interface with real input; a passing build or test is not evidence.

1. **Flag OFF, staging, synthetic org with 6 billable units:** `/m/settings` and `/m/upgrade` show the same quote before and after PR-2 (screenshots at 390 px and 1280 px, same SHA pair).
2. **After PR-4 only:** the same org's quote drops by exactly one unit's rate; an org with a partner snapshot behaves per the Q2 answer.
3. **Aggregate impact check** (box PE, read-only, counts only): number of live orgs whose monthly quote changes, grouped by delta. No row values printed.
4. **Read-only capacity** is verified under ADR-111 (unit #6 by lease start is not editable through a direct request, not just hidden).

## Amendments (CEO 2026-11-13)
- `FREE_UNITS` = 5 everywhere (shipped as PR #138, Ron 01:30 PT 「9全面改成5」).
- Keep **invoice allowance** and **editable (Free-plan) capacity** as separate named concepts in code and docs, even though both are 5 today.
- Existing partner grants stay unchanged (Ron 11:09: ANJU2026 stays 4); partner codes affect billing only; the post-trial editable cap is 5.

# ADR-113 — Flag registry reconciliation

| | |
|---|---|
| Status | **ACCEPTED** — CEO ruling 2026-11-13 PT (box `ops/reviews/ceo-review-1113-phase0-batch.md`, relayed by Ron; hub `11-decisions/DECISIONS.md`) |
| Date | 2026-11-13 PT |
| App SHA | `1e0a8ab` (GitHub `main`) |
| Requirement | hub `20-build/MAC-CLAUDE-HANDOFF-1112.md` §2.1, §2.4; hub `00-ops/PRINCIPLES.md` 3, 5, 15 (ADR-003, ADR-005) |
| Related | `docs/phase0/architecture-map.md` §7, G6, G14; `docs/phase0/test-infra.md` §5 |

Docs only. **No flag value, registry entry or expiry is changed.** Flag expiries are owned by Ron; the Mac must not edit them. Live flag values on staging/prod are **unverified** here.

## Context

Three layers exist and are not unified.

| Layer | Where | Evidence |
|---|---|---|
| Registry | `ops/flags.yaml` — **56 keys**; **54 expire 2026-11-24 18:00 PT**, 2 (`unit_line_invite`, `pricing_interim`) on 2026-12-10 18:00 PT; owner Ron. Line 1: "older source registry reconciliation remains incomplete" | `ops/flags.yaml` (counted at `1e0a8ab`) |
| Runtime, DB | `platform_settings.<key>` and/or `organizations.feature_flags.<key>`. **Not one universal scheme** — see "Evaluation patterns" below | per-feature readers |
| Runtime, env | Worker vars read via `process.env` (`ESIGN_ENABLED`, `MOVE_OUT_NOTICE_ENABLED`, `TENANT_SIGNED_PDF_ENABLED`, `LINE_PLATFORM_ENABLED`, `BRAND_V2`, …) plus allowlists (`CUSTOM_ROLES_ORG_ALLOWLIST`, `TEAM_INVITES_ORG_ALLOWLIST`) | `wrangler.jsonc`; architecture-map §7 |

**Evaluation patterns (several coexist; the list is not exhaustive).**

| Pattern | Rule | Example |
|---|---|---|
| Strict platform + allowlist + org (**one pattern, not the rule for every flag**) | `{"enabled":true,"allowed_org_ids":[…]}` with the org on the list **and** `feature_flags.<key> === true`; malformed = OFF | `pricingInterimOn`, `src/server/b045-pricing-interim-rules.ts:54-68`; SQL twin `app.b030_enabled` |
| Three-state platform value | `"off" \| "org" \| "on"`; `"on"` admits every org unless the org override is `false`; `"org"` admits only an org override of `true` | partner consent, `src/server/partner-consent-rules.ts:30-36` |
| Env **OR** org opt-in | `BRAND_V2 === "true"` **or** `feature_flags.brand_v2 === true`; the env var is not a kill switch for opted-in orgs | `src/server/brand-v2.ts:25-49` |
| Env switch and/or env allowlist | per feature | `ESIGN_ENABLED`, `CUSTOM_ROLES_ORG_ALLOWLIST`, … |

Problems found:

1. **No central evaluator.** 44 non-test files reference `feature_flags`, 45 reference `platform_settings`; each feature has its own reader. `src/server/flag-registry-sql.ts` is a test-side scanner, not a runtime API.
2. **In code, not in the registry:** `brand_v2`, `vendor_dispatch`, `go_live_lock`, `design_partner_consent_gate`, `esign_disposal_enabled`.
3. **In the registry, referenced only from SQL/tests:** `unit_qr_signup`, `payee_details`, `deposit_rule_hints`, `partner_consent_gate`, seven `line_*` keys, `unit_line_invite`.
4. **Name drift** between env switch and org key: `ESIGN_ENABLED` ↔ `feature_flags.esign`; `TENANT_SIGNED_PDF_ENABLED` ↔ `tenant_signed_pdf`. The registry mixes env-style and snake-case keys.
5. **Planned keys not registered:** `pricing_trial*` (B-056), `nav_six_areas*` (B-043), `four_party_shell*`, `today_dash*`, `owner_home_v1*` and others — names are proposals in hub handoffs ("PE confirms").
6. **Expiry check coverage.** `scripts/gate.sh:224-265` runs step `flag-expiry` using `scripts/flag-expiry-policy.cjs`. **Hosted `.github/workflows/ci.yml` has no flag-expiry step** — the required check does not see expiry at all.
7. **Policy drift.** PRINCIPLES 5: expired flags **warn** first and CI **fails only after 7 days past expiry**. `flag-expiry-policy.cjs` warns in the 7 days **before** expiry and **fails at expiry** (`expires <= now`). On the current registry, `gate.sh` starts warning 2026-11-17 and fails for all 54 keys from 2026-11-24 18:00 PT.
8. Mismatch lists in 2–3 come from the Phase 0 inventory, spot-checked — not a complete audit.
9. **No per-flag record of which evaluation pattern applies.** A shared evaluator built on the strict pattern alone would change behaviour for the exceptions (partner consent `"on"` admits by default; `brand_v2` is OR, not AND). A per-flag pattern inventory must exist **before** any existing reader adopts a shared evaluator.

## Decision drivers

1. One list must answer "does this flag exist, who owns it, how is it killed" (PRINCIPLES 5, ADR-003).
2. Fail closed: missing or malformed setting = OFF (already the convention in registry text).
3. No behaviour change, no mass refactor of ~44 files, no flag flips.
4. The 2026-11-24 expiry must not surprise the release train.
5. New work (B-056 onward) should not add a 45th hand-written reader.

## Options

**Option A — Registry-only reconciliation (docs + CI check).**
Complete the registry (add the 5 missing keys, mark SQL/test-only keys, record env↔org name pairs in an explicit field), and add a static check: every flag key read in `src` or `supabase/migrations` exists in `ops/flags.yaml`, and every registry key is referenced somewhere or marked `reserved`/`remove-by`. Add the expiry step to hosted CI.
Consequence: cheap, no runtime risk, closes "incomplete". Does not stop the next feature copying a reader with a subtle difference (e.g. non-strict boolean).

**Option B — Small shared evaluator, adopted incrementally.**
One server module: given org id, org flags and the platform setting, return ON/OFF with strict-boolean, allowlist and optional env-kill semantics; keys typed from the registry. **New** features use it; existing readers migrate only when their file is touched anyway, and only after the per-flag pattern inventory (problem 9) shows the reader follows the strict pattern — the known exceptions (partner consent, `brand_v2`) keep their own readers unless a separate decision changes their semantics.
Consequence: stops divergence going forward. Two styles coexist for a long time; a subtle mismatch with an existing reader's semantics is possible if migrated carelessly — each migration must prove flag-OFF and flag-ON equality.

**Option C — Both (recommended).**
A first (registry is the contract), then B for new code only, with the registry as the evaluator's key source. No bulk migration.

## Recommended option

**Option C**, in this order: (1) registry reconciliation + static key check; (2) expiry step in hosted CI; (3) evaluator for new flags, first user B-056. Evaluator module/API names OPEN (proposed: one function taking a registry key and the session's org context; final name in its PR).

Explicit non-goals: renaming any live key; changing any `platform_settings` or `organizations.feature_flags` value; editing any `expires_at`; removing a flag (removal follows PRINCIPLES 5 and needs its own PR and GO).

## Consequences

- The registry gains entries for keys that already run in production code; each addition needs an owner and an expiry **set by Ron/CEO**, not by the PR author. Until answered, the PR lists them as `expires_at: OPEN` in its description, not in the file.
- Adding a hosted CI step changes **required-check contents** — needs CEO GO; it overlaps architecture-map G14 ("CI source of truth") and should be decided together.
- If the expiry step is added to hosted CI **before** the 54 expiries are renewed or the flags removed, every PR fails from 2026-11-24 18:00 PT. Sequencing is the main risk of this ADR (Q1).
- Policy drift (item 7) must be resolved one way: change the script to match PRINCIPLES 5, or amend the principle. This ADR does not pick.
- The evaluator adds one more place that must stay in step with SQL twins such as `app.b030_enabled`; SQL-side evaluation is out of scope here.

## What this ADR does NOT decide

| # | Open question | Owner |
|---|---|---|
| Q1 | What happens to the 54 keys expiring 2026-11-24 18:00 PT: renew (to when), or remove which? | **Ron** (owner of every entry); CEO schedules |
| Q2 | Expiry policy: fail at expiry (script today) or warn, then fail 7 days after (PRINCIPLES 5)? | CEO; Ron if the principle changes |
| Q3 | Owner + expiry for the 5 unregistered keys (`brand_v2`, `vendor_dispatch`, `go_live_lock`, `design_partner_consent_gate`, `esign_disposal_enabled`) | Ron / CEO |
| Q4 | Keys referenced only by SQL/tests (e.g. `unit_qr_signup`, which must never be enabled): keep as `reserved`, or schedule removal? | CEO |
| Q5 | Canonical key style for **new** flags (snake_case org key; env kill named how?) and whether existing drift is ever renamed | CEO |
| Q6 | Exact keys for `pricing_trial*`, `nav_six_areas*`, `four_party_shell*`, `today_dash*` etc. | CEO, in each item's design note |
| Q7 | Add flag-expiry and key-consistency steps to hosted `ci.yml` (required check) — yes/no and when | CEO (required-check contents); switch of required checks stays with Ron |
| Q8 | Should Worker-env kill switches be listed in the registry with their own record type? | CEO |
| Q9 | Live values of every flag on staging/prod vs registry `activation` text | box PE (read-only inventory, no values of secrets) |

## Implementation sketch

| PR | Content | Gate |
|---|---|---|
| PR-1 (docs) | This ADR + a generated mismatch report (keys only) attached as evidence | CEO review |
| PR-2 (registry + script) | Add missing keys with Ron/CEO-supplied owner/expiry; `reserved` markers; env↔org pair field; static key-consistency check wired into `gate.sh`. **No expiry edits** | hosted CI green + non-author QA; registry edits approved by CEO |
| PR-3 (CI) | Add flag-expiry + key-consistency steps to hosted `ci.yml` | **after Q1/Q2 are answered**; CEO GO (required-check contents) |
| PR-4 (code) | Shared evaluator + unit tests of strict/fail-closed semantics; no existing reader changed | hosted CI green + non-author QA |
| PR-5… | Per-feature adoption when a file is touched; each proves OFF/ON parity | per item |

No schema or RLS change is needed for this ADR. If a later step wants a registry table in the database, that is a separate schema ADR (non-author QA + CEO exact-SHA GO before staging apply).

## Verification

Per GLOSSARY "Verify":

1. **Static check, negative proof:** on a throwaway branch add a read of an unregistered key → the check fails and names it; add a registry key nobody reads → flagged unless marked `reserved`.
2. **Hosted CI:** the run page for a PR shows the new steps executing and passing on the exact SHA (link in the PR).
3. **Evaluator on staging (synthetic org):** with platform setting ON and org flag missing → feature OFF; both strict `true` and org on the allowlist → ON; malformed JSON in the setting → OFF. Observed in the UI of the first adopting feature, 390 px and 1280 px.
4. **No drift introduced:** before/after read-only inventory by box PE shows identical live flag values (keys and booleans only).

## Notes (CEO 2026-11-13)
- Expiry question Q1 decided: the 54 flag expiries move to 2026-12-31 (PR #137, merged).

# Phase 0 — technical foundation and domain modeling (index)

**Status: DRAFT notes / PROPOSED ADRs — for CEO and Ron review.** App SHA `1e0a8ab` (GitHub `main`), written 2026-11-13 PT on branch `feat/mac/phase0-arch`.

**Review history:** Codex r1 FAIL (5 阻塞/8 低優先) → fix round 1.

**Nothing in this folder changes behaviour.** Docs only: no code, migration, RLS, flag, registry expiry, secret, CI or Worker config is changed, and nothing here authorizes such a change. Schema statements are from migrations and docs, not a live schema dump; items marked "unverified" need a live read by box PE.

Requirement: hub `20-build/MAC-CLAUDE-HANDOFF-1112.md` §2. Read hub `INDEX.md` § "Do NOT build" (`INDEX.md#do-not-build`) before building anything.

## Notes (DRAFT)

| File | What it is |
|---|---|
| [`architecture-map.md`](architecture-map.md) | Runtime, surfaces, data-access paths and when RLS applies, migrations, flags, CI; gaps G1–G16 |
| [`domain-model.md`](domain-model.md) | Ten domains with invariants and where each is enforced; proposed target for plans/trials (§11) |
| [`test-infra.md`](test-infra.md) | Local Mac + disposable PG16; how to run the QA-STANDARD gates; evidence a PR must carry |

## ADRs (PROPOSED)

Numbered after ADR-109, the highest ID in `docs/DECISIONS.md`. That file is **not edited** here; when an ADR is accepted, a one-line row is appended to it in a separate PR (history is never overwritten).

| ADR | Title | Recommended option (one line) |
|---|---|---|
| [ADR-110](adr/ADR-110-free-unit-threshold.md) | Free-unit threshold 4 vs 5 | **Accepted with amendments:** `FREE_UNITS` = 5 everywhere; invoice allowance and editable capacity stay separate concepts; partner grants unchanged |
| [ADR-111](adr/ADR-111-trial-engine-state-machine.md) | Trial engine state machine (B-056) | **Accepted with amendments:** dedicated trial record + lazy effective plan; job `0 16 * * *` UTC; persisted `paused`; per-user dismissal; Standard cap 5 incl. admin |
| [ADR-112](adr/ADR-112-post-inc-rls-1112-new-table-default.md) | Post-INC-RLS-1112 default for new tables | **Accepted with amendments:** RLS on, no client grants, owned by the migration role; FORCE without policies only if staging proves `rolsuper`/`rolbypassrls`, else a named owner policy |
| [ADR-113](adr/ADR-113-flag-registry-reconciliation.md) | Flag registry reconciliation | **Accepted:** reconcile registry (expiries → 12/31); static key check deferred (OQ-006) |
| [ADR-114](adr/ADR-114-four-party-shell-vs-nav.md) | Four-party shell (B-061) vs nav (B-043) | **Accepted:** shell is presentation only; role-filtered nav passed as data |

## Rules that apply to every follow-up PR

- Schema / RLS PRs: non-author QA **and** a CEO exact-SHA GO before any staging apply; box PE orders migrations and owns production.
- Flags default OFF; `FREE_UNITS` stays 4 until the billing-change GO (C4); flag expiries are Ron's.
- 0 real outbound. Aggregates only from shared databases. Secrets by NAME only.
- Each ADR lists its OPEN questions with an owner (Ron or CEO). An ADR being merged as PROPOSED decides none of them.

**Phase 0 closed** — CEO ruling 2026-11-13 PT (relayed by Ron). ADR-113 and ADR-114 accepted; ADR-110, ADR-111, ADR-112 accepted with the amendments recorded in each file.

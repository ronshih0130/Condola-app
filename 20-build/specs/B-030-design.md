# B-030 — Usage summaries, limits/grace and mock subscription lifecycle

Implementation design for Claude's architecture review, 2026-11-06 PT. Sources: hub `20-build/specs/B-030.md`, this checkout's `B-029-design.md` (absent from hub), and hub BLK-MAC-10. Work is delegated to this working tree; Claude retains ownership, commits and independent QA. No network, hosted database, deployment, real provider or price decisions.

## Slices

1. Private schema and gateways (manifest non-add-only because of constraints, privileges and the existing-table assignment trigger): exact half-open period aggregation over immutable PROP-07 events, versioned unpriced plan configuration, org subscription state and append-only mock event receipts. No cached totals can drift from source events.
2. Scoped admin/accountant readers and local HMAC fixture handler. Nullable grace/limits mean not configured. Read-only evaluation reports boundaries; it never mutates state or prevents retained-data reads.
3. BLK-MAC-10: private persisted assignment generation on ticket vendor changes, plus first-dispatch source per generation. The B-029 recorder uses it only with B-030 ON; B-030 OFF follows its original history-based path.
4. Integration/privilege/OFF regression tests, unit tests, registration and local-only verification.

## Flags

`usage_subscriptions` defaults OFF in platform settings and `ops/flags.yaml`. Admission requires global boolean `enabled: true`, an array allowlist containing the org, and org boolean `usage_subscriptions: true`; malformed/missing settings are OFF. SQL writers fence platform and org configuration before writing. OFF performs no B-030 writes. B-029 `usage_events` remains independently gated and unchanged when B-030 is OFF.

Local provider handler additionally requires `B030_MOCK_PROVIDER_ENABLED=true`, a loopback PostgreSQL URL and an environment-only `B030_MOCK_PROVIDER_HMAC_SECRET` (minimum 32 bytes). No provider SDK, checkout, network transport or scheduled job. HTTP route is local-host-only. Fixtures sign `timestamp.rawBody` with HMAC-SHA256; timestamp freshness is five minutes. Exact accepted retries return `duplicate` without mutation; changed payload for the same event ID, repeated sequence under another ID, stale/out-of-order events and forged signatures are rejected.

## Data and gateways

- `app.b030_plan_versions`: immutable `(plan_key, version)`, nullable price/currency (constrained unset), nullable five dimension limits and grace seconds. One `unconfigured` version is a placeholder, not a commercial tier. Restriction rules stay null until Ron approves a separate implementation.
- `app.b030_subscriptions`: one org row, mock-only state (`trialing`, `active`, `grace`, `restricted`, `canceled`), selected immutable plan version, provider sequence/time and grace deadline.
- `app.b030_provider_events`: globally unique mock event ID, exact-body digest, org/sequence and before/after state; unique org/sequence, immutable receipts. Org lock serializes events; retries do not append transitions.
- `app.b030_vendor_assignments`: org/ticket generation and current vendor. The generation is the count of existing business audit inserts/vendor changes for the ticket, including changes with no dispatch; same-vendor retry does not advance it. First-dispatch pointer/time gives a stable source and dedupe key per generation, inside the existing usage savepoint. No backfill rewrites historical B-029 events. Enabling mid-generation reuses a prior matching dispatch source where available to avoid counting an existing intent twice.
- Period totals are computed at read time in `app.b030_usage_summary`, with exact source event IDs, quantities as decimal strings and event counts; exclude event sandbox markers and sandbox organizations, `[from, to)` in supplied timestamptz instants. No implicit billing timezone or calendar cycle. The server accepts only valid ISO calendar instants with `Z` or a known explicit `±HH:MM` offset and zero to six fractional digits. Unknown `-00:00`, timezone-less values, invalid dates, leap seconds and greater precision are rejected. Exact bigint microsecond comparison validates `from < to`; original offset-bearing strings reach PostgreSQL without millisecond rounding. Read-time aggregation includes late arrivals on the next read.
- `app.b030_plan_presentation` returns configuration/state to pinned admin/accountant sessions; `app.b030_apply_mock_event` is service-role-only. Internal helpers/trigger functions have no API-role EXECUTE. `app.b030_vendor_dispatch_source` is service-role-only for the existing trusted recorder.
- All private tables: RLS enabled, all table privileges revoked from PUBLIC/anon/authenticated/service_role. SECURITY DEFINER functions have pinned search paths and explicit least-role EXECUTE. Readers require pinned org/environment and current database admin/accountant membership, in addition to server `requireOrgScope`.

Initial mock state may be trialing or active. Transitions: trialing → active/grace/canceled; active → grace/canceled; grace → active/restricted/canceled; restricted → active/canceled; canceled is terminal. Same-state newer notifications may update provider metadata, but do not represent a state transition. Grace entry computes its deadline only when configured; grace expiry alone never changes state. Limits are descriptive, not enforced. No restriction rules are approved: all operation hooks are inert, including in restricted/canceled state; retained data is always readable by its authorized reader.

## Acceptance mapping

| Requirement | Evidence |
| --- | --- |
| Period totals reconcile, sandbox excluded | Source IDs, sums/counts, half-open boundaries, live/sandbox integration fixtures |
| No fabricated charge | Unpriced plan reader and zh-TW/en `pricingNotConfigured`; no legacy quote helper |
| Grace/limits and retained reads | Null/zero/boundary unit cases; expired grace/restricted integration reads |
| Mock lifecycle exactly once | Repeated/concurrent event, payload conflict, out-of-order, invalid transition, forged/stale signature tests |
| BLK-MAC-10 | Real dispatch A → update assignment B without dispatch → dispatch A; two source events, same-vendor retry remains deduped |
| OFF and isolation | Malformed/global/org/allowlist OFF snapshots, B-029 regression suites, cross-org/role and privilege catalog checks |

## Decisions needed (Ron)

- Prices and plan tiers: no approved prices, currency, estimated charges or commercial tiers.
- Payment provider selection/keys: local signed mock only; no external integration.
- Restriction rules during grace or after expiry: none approved; no operation restrictions, including tenant/billing operations.
- Limit values and grace duration: null means not configured; no default quota or grace policy invented.

These decisions block activation/commercial scope, not this scaffolding. Claude must copy the decision status to the canonical hub BLOCKED during handoff; this delegated implementer edits only this checkout.

## Implementation verification

Local checks and deferred review status: [`e2e/results/B-030/implementation.md`](../../e2e/results/B-030/implementation.md) (from repository root). Global immutable plan configuration survives demo reseed; org-bound state/receipts/assignment pointers are in the seed wipe list. Existing B-029 dispatch history is reconciled on first enable/reenable; missed assignment generations (including OFF intervals) can be reconciled from existing business audit rows on an admitted dispatch, without creating historical events. This scaffolding does not authorize usage billing.

## Fix round 2 — telemetry isolation and period precision

- The dispatch gateway returns an explicit `state=off` row if admission observes B-030 disabled after the server flag read. Only that result falls through to the unchanged B-029 history query; an invalid job/source still returns no row and no event. Stable OFF retains the same application query sequence, output and text. Concurrent global and org toggles run on a second local connection in the regression test.
- Assignment tracking runs in a PL/pgSQL exception subtransaction **after** the existing business audit trigger (`z_b030_assignment_generation`). Tracking/admission failures roll back only telemetry work/locks/settings, leave ticket creation, reassignment and dispatch valid, and emit only a fixed diagnostic plus SQLSTATE. Telemetry lock waits are capped at 250 ms, honoring a shorter caller timeout and restoring the prior timeout. Query cancellation inside the telemetry block is also isolated; connection loss or failure of the business operation/audit itself is outside this guarantee.
- Recovery uses durable business audit rows, not exception payloads or an additional recovery write that could fail with the telemetry store. The next admitted dispatch compares the audit count with the stored generation. A missed A → B → A without B dispatch resets the pointer to the current dispatch; a newer recorded vendor-history segment still reuses its B-029 source to avoid rollout duplicates. First admission with no private state uses the existing B-029 history baseline. If telemetry remains broken, dispatch telemetry stays failed and business work proceeds; retry after repair performs reconciliation. There is no automatic historical usage replay, invented event, or modification of immutable usage. A dispatch missed during a telemetry outage can therefore remain a historical measurement gap; reconciliation restores future dedupe correctness, not a promise of lossless telemetry.
- The manifest marks the migration **non-add-only** and identifies CHECK/foreign-key/uniqueness constraints, RLS/revokes, role-specific EXECUTE grants and the assignment trigger. Its generator regression asserts the produced manifest, not just the classification source.
- Period regression coverage includes equivalent positive/negative offsets, both occurrences of a DST fold, a DST spring-forward boundary, one-microsecond periods, equal instants with different offsets, rejected excess precision and late-arriving immutable events.

Round-2 verification and finding-to-test map: [fix-round-2.md](../../e2e/results/B-030/fix-round-2.md). Independent Claude QA remains pending; these local checks do not supersede that approval.

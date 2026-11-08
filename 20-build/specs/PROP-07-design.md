# PROP-07 — JIT L2 設計稿：計量來源 ID 保留（L1-MTR）

> Author: Claude (Mac overnight, 2026-11-06 PT). L1 foundation per hub `10-product/step4-architecture/architecture-v0.md` §8 (L1-MTR, Wave C) for B-029 (usage events, five hooks). No new flag; no hooks; no callers. Branch cut from #36 (`d374bb6`).

## Done means

There is one append-only place where every future usage event keeps the **source table and source id** it was derived from, the caller's **dedupe key** (retries never double-count) and whether the organization was **sandbox** at record time (sandbox never counts as formal usage); trusted server code can record idempotently, and an org admin can read a formal summary that excludes sandbox. Nothing writes to it until B-029 adds hooks.

## Design

Migration `20261106100000_prop07_usage_source_ids.sql`:
- `app.usage_events(org_id, dimension ∈ {units, signatures, stored_bytes, notifications, vendor_jobs}, quantity bigint > 0, occurred_at, source_table, source_id, dedupe_key, sandbox, recorded_at; UNIQUE(org_id, dimension, dedupe_key))`; RLS on; REVOKE ALL from API roles; UPDATE/DELETE/TRUNCATE rejected (append-only); source indexes kept for traceability.
- `app.prop07_record_usage(...)` SECURITY DEFINER (`search_path = pg_catalog, public, app`), EXECUTE to `service_role` only: advisory lock per (org, dimension, key); identical replay returns the existing id; different payload under the same key ⇒ `23505` conflict; `sandbox` derived from `organizations.environment` (never from the caller).
- `app.prop07_usage_summary(org, from, to)` → `(dimension, quantity text, events)` excluding sandbox; requires `app.has_role(org,'{admin}')` (pinned org/env via `app.is_member`); EXECUTE to `authenticated`.

B-029 contract (for the next row): hooks call the recorder inside a SAVEPOINT so a telemetry failure never fails the business operation, and record a diagnostic instead.

## Verification

`prop07-usage-source-ids.integration.test.ts`: idempotent replay + conflict + source id kept; sandbox marked and excluded; exact bigint sum beyond 2^53; append-only; API roles cannot record or read rows; summary admin-only and org-scoped; unknown dimension rejected.

## Cross-review (Codex QA)

r1 FAIL: summary did not require a pinned org/env (app.is_member admits unpinned live sessions) → fixed (exact app.active_org_id + app.env required); LOWs (vacuous sandbox assertion, untested race) → fixed. r2: blocker closed; remaining LOW (prove contention) fixed with a pg_blocking_pids poll.

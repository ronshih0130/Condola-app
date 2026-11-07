# B-029 — JIT L2 設計稿：用量事件與五個計量掛點

> Author: Claude (Mac overnight, 2026-11-06 PT). Layer-2 design for hub `20-build/specs/B-029.md` on the PROP-07 foundation (`app.usage_events`, `app.prop07_record_usage`, `app.prop07_usage_summary`; PR stacked). Flag `usage_events` (USAGE_EVENTS*) seeded OFF.

## Done means

With `usage_events` ON for a local test org, each of the five operations — (1) unit created, (2) lease signed (e-sign completion **and** paper signed-PDF upload), (3) stored bytes for an uploaded file, (4) notification delivered/captured, (5) vendor job dispatched — records exactly one usage event with its source table/id; a retried operation never double-counts (dedupe key derived from the source row + dimension); if recording fails the business operation still commits and a diagnostic row/log is traceable; sandbox events never appear in the formal summary. Flag OFF: zero usage writes and no change to any operation.

## Design

- `src/server/usage-events.ts`: `recordUsage(client, {orgId, dimension, quantity: bigint, occurredAt, sourceTable, sourceId, dedupeKey})` — checks the flag (strict `=== true`, global allowlist + org flag); runs the recorder inside `SAVEPOINT usage_event` via the service path; on any error rolls back to the savepoint, writes a diagnostic (`logServerError('usage_event', …)` without payload values) and returns `{ state: 'failed' }`; never throws to the caller.
- Hooks (call after the business write, inside the same transaction): unit creation path, e-sign completion (`esign/repo.ts` activation) + `uploadSignedLeasePdf`, file storage finalize (bytes = stored size), notification center/local capture delivery, vendor job creation/dispatch. Dedupe key = `${dimension}:${sourceTable}:${sourceId}` (+ version for signatures).
- Migration `<ts>_b029_usage_events.sql`: flag seed OFF (ON CONFLICT DO NOTHING) only — schema comes from PROP-07.
- No pricing, quotas or blocking (B-030).

## Verification

Integration per hook (flag ON: exactly one row with the source id; replay ⇒ still one; injected recorder failure ⇒ business row committed + diagnostic; sandbox org ⇒ row marked sandbox and excluded from summary; flag OFF ⇒ zero rows).

## Cross-review (Codex QA)

- r1 FAIL (4): paper dedupe used caller UUID spelling; dispatch retry double-counted; handover uploads not metered; payment-center notifications not metered; LOW flag-OFF cost → all fixed (canonical lease id; dispatch-intent dedupe; attachment-keyed stored_bytes; per-recipient notification events; per-transaction flag cache).
- r2: 4/5 closed. **Known limitation (hub BLK-MAC-10):** dispatch A → reassign to B without dispatch → dispatch A again records one vendor_jobs event instead of two (undercount; telemetry only; flag OFF). Fix with a persisted assignment generation before any usage-based billing (B-030).
- Local full `test:rls` on a fresh DB: PASS (646). A `rls.test.ts` PDF-sha failure seen once came from a stale local DB and passes on a fresh one.

# B-019 — JIT L2 設計稿：租客建立對話

> Author: Claude (Mac overnight, 2026-11-06 PT). Layer-2 design for hub `20-build/specs/B-019.md` (CAP-T-12, T-15). Flag `tenant_thread_create` (TENANT_THREAD_CREATE*) seeded OFF. Branch cut from #36 (`d374bb6`), independent.

## Done means

With the flag ON for a local test org, a tenant whose lease has no conversation sees the existing message box on `/t/messages`; sending creates exactly one company/lease thread (existing `message_threads_one_per_lease` index), adds the lease parties as participants and stores the first message; a double submit (same request id) stores one message; two concurrent starts still produce one thread. Another tenant, another organization or a pin mismatch gets nothing. Flag OFF: the page shows the existing empty state and the RPC refuses.

## Design

- Migration `20261106130000_b019_tenant_thread_create.sql`: flag seed OFF; `app.b019_start_tenant_thread(lease, request, body)` SECURITY DEFINER (`search_path = pg_catalog, public, app`), EXECUTE to `authenticated` only: flag rows read `FOR SHARE`; pinned `app.active_org_id` = lease org; caller must be an active (non-archived) tenant party of an active/pending-signature lease; body 1..4000; advisory lock per lease; `INSERT … ON CONFLICT (lease_id) WHERE kind='lease' DO NOTHING`; participants without duplicates; first message id = request id (replay returns the thread; a different body/sender under the same id ⇒ 42501).
- `src/server/tenant-thread.ts` flag mirror + `startTenantThread`; `actionStartTenantThread` (consent-guarded server action); `/t/messages` renders the form (existing `i_message` / `i_send` copy, no new strings) only when no thread exists and the flag is ON.
- Acceptance "arranged repair, cancellation unavailable ⇒ contact guidance" is already met by `/t/repair` (`repair-cancel-locked`); unchanged.

## Verification

`b019-tenant-thread.integration.test.ts` (OFF denial/no writes; create + participants + message; replay/conflict/empty body; concurrent same-request and different-request starts; other tenant / other org pin denied; privileges) and `tenant-thread.test.ts` (flag parsing).

## Cross-review (Codex QA)

r1 FAIL: flag predicate failed open on SQL NULL; env pin unchecked; archived co-parties joined as participants → fixed (`IS NOT TRUE`, exact app.env pin, eligible non-archived tenant parties only) with regression tests → **r2 PASS**.

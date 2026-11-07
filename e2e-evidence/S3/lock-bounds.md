# S3 lock bounds: BLK-MAC-17 (NOWAIT vs autovacuum) and BLK-MAC-24 (unbounded B-013 mutator waits)

LOCAL EVIDENCE ONLY. Disposable local PostgreSQL 16.15 (`deadlock_timeout=1s`), synthetic seed, branch
`fix/s3-lock-bounds` on `08eb990`. Not a hosted measurement.

Migrations: `20261107150000_s3_bounded_share_locks.sql` (BLK-MAC-17) and
`20261107151000_s3_b013_mutator_lock_timeout.sql` (BLK-MAC-24). Test:
`src/server/s3-lock-bounds.integration.test.ts` (8 tests).

## 1. Mechanism

| Concurrent maintenance | Lock it holds | Conflicts with | Yields to a *queued* waiter? |
|---|---|---|---|
| autovacuum / auto-analyze (scan) | SHARE UPDATE EXCLUSIVE | SHARE (and stronger) | Yes: the waiter's deadlock check cancels a non-wraparound autovacuum worker after `deadlock_timeout` |
| vacuum heap truncation (after deletes) | ACCESS EXCLUSIVE, briefly | every mode, incl. ACCESS SHARE / ROW EXCLUSIVE | Yes: truncation checks for waiters every ~20 ms and gives up |
| anti-wraparound autovacuum | SHARE UPDATE EXCLUSIVE | SHARE | **No** (never auto-cancelled) |

`LOCK TABLE ... NOWAIT` never queues, so neither yield could happen: the gateway failed at once with
55P03. That explains both observed flakes: `repair-owner-default` (platform_settings SHARE vs auto-analyze
after the seed's mass DELETE/UPDATE) and `repair-owner-policy` 55P03 on `public.audit_log`. Note that the
B-013 lock on `audit_log` is ACCESS SHARE / ROW EXCLUSIVE, not SHARE: it does **not** conflict with
autovacuum's SHARE UPDATE EXCLUSIVE (test 3 shows the owner view unaffected by that holder pre-fix). The
conflicting actor is vacuum's truncation phase (ACCESS EXCLUSIVE), which the seed's `DELETE FROM` of every
public table makes likely. That is why every single-shot table-level NOWAIT is in scope, not only SHARE.

## 2. Fix

* `app.lock_tables_bounded(p_tables regclass[], p_mode text)` - SECURITY INVOKER (runs as the calling
  SECURITY DEFINER owner, so lock privileges are unchanged), `SET search_path=pg_catalog`,
  `SET lock_timeout='2s'` (raised to `deadlock_timeout+1s` if that is larger; the function SET clause
  restores the caller's own lock_timeout on exit, including on error). Modes accepted: ACCESS SHARE,
  ROW EXCLUSIVE, SHARE. Timeout = native 55P03 "canceling statement due to lock timeout"; a deadlock
  resolved against this waiter is re-raised as 55P03, so every existing 55P03 -> `busy` mapping holds.
  EXECUTE revoked from PUBLIC, anon, authenticated, service_role.
* `app.lock_tables_nowait_retry(p_tables regclass[], p_mode text)` - same privileges/validation, but
  never queues: `LOCK ... NOWAIT`, on 55P03 sleep 20-50 ms (jittered) and retry, ~2 s budget, then
  re-raise the original 55P03 ("could not obtain lock on relation"). No waiting edge, so it cannot close a
  lock cycle; it rides out a short autovacuum/truncation but does not make one yield (L2 decision 2).
* Three categories: (A) bounded wait - 23 functions, 32 statements; (B) bounded NOWAIT retry - the four
  sites that must never wait (`b017_old_source_insert`, `b017_resolution_admit` carry explicit "never wait"
  comments; `b017_occurrence_valid`, `b028_center_recipient_valid` are triggers in the same position, inside
  an arbitrary writer transaction) - 4 statements; (C) unchanged B-010 polling functions - 3.
* 20261107150000 re-creates each (A)/(B) function from `pg_get_functiondef` with only its NOWAIT
  table-lock statements replaced, in place and order, by `PERFORM app.lock_tables_bounded(...)` or
  `PERFORM app.lock_tables_nowait_retry(...)`.
  Fails closed (RAISE) if a signature is missing, a target is not SECURITY DEFINER or its owner cannot
  execute its helper, a per-function count differs, the totals are not 36 (4 retry), or any unlisted
  app/public function still has a table-level NOWAIT.
* 20261107151000: `ALTER FUNCTION ... SET lock_timeout = '3s'` on the six B-013 repair mutators; verifies
  proconfig afterwards (RAISE if missing).
* TS: `repair-approval.ts` unchanged (`FlowError` with `cause.code="55P03"`). Routes (L2 decision 3): the
  only production callers of the six mutators are `owner-repair-decision` (decideEstimate),
  `vendor-job-response` and `vendor-job-completion` (recordVendorAppointment). All three now map
  `55P03`/`57014` (read from `error.code ?? error.cause.code`) to `200 {status:"busy"}`, the existing
  retryable shape of the owner-repair-policy/override routes. The owner route now also reads `FlowError`
  causes, so its 40001 -> 409 and 42501 -> 403 branches work for gateway errors (previously 500). No new copy:
  both clients render existing "try again" copy for a non-recorded status (`repairApprovalCopy.unavailable`,
  `i_generic`) and keep the same requestId, so a resubmit replays/records idempotently.

## 3. Inventory (latest definitions in a fresh DB at 08eb990; 27 converted functions, 36 statements)

| Function (signature) | Latest CREATE in | Statements -> bounded |
|---|---|---|
| `app.b010_manual_reminder(uuid,uuid,text,uuid,uuid,uuid,uuid)` | 20261031100212 | platform_settings SHARE |
| `app.b010_schedule_rent(uuid,uuid,timestamptz)` | 20261031100212 | platform_settings SHARE |
| `app.b010_tenant_due_preference(uuid,uuid,text,uuid,uuid,boolean)` | 20261031100212 | platform_settings SHARE |
| `app.b028_claim_manual(uuid,uuid,text,uuid,uuid,uuid,uuid[])` | 20261031100212 | platform_settings SHARE |
| `app.b028_claim_scheduled(uuid,uuid,uuid[],timestamptz)` | 20261031100212 | platform_settings SHARE |
| `app.b028_finish_manual(uuid,uuid,text,uuid,uuid,uuid,uuid,uuid,text)` | 20261031100212 | platform_settings SHARE |
| `app.b028_center_context(uuid,uuid,text,uuid,text,text)` | 20261031100215 | platform_settings SHARE |
| `app.b028_center_vendor_context(text)` | 20261031100215 | platform_settings SHARE |
| `app.b028_center_recipient_valid()` (trigger) | 20261031100217 | contacts SHARE - **(B) retry** |
| `app.b028_center_session(uuid,uuid,text,uuid,text,text,uuid,uuid)` | 20261031100217 | contacts SHARE |
| `app.b017_occurrence_valid()` (trigger) | 20261031100217 | platform_settings SHARE - **(B) retry** |
| `app.b017_old_source_insert()` (trigger) | 20261031100217 | platform_settings SHARE - **(B) retry** |
| `app.b017_resolution_admit(uuid)` | 20261031100217 | platform_settings SHARE - **(B) retry** |
| `app.b015_edit_context(uuid,uuid,text,uuid)` | 20261031100218 | platform_settings SHARE |
| `app.b013_owner_context(uuid,uuid,text,uuid,uuid)` | 20261031100220 | auth_sessions AS; organizations,contacts,properties,property_owners AS; platform_settings SHARE; audit_log AS |
| `app.b013_owner_view(uuid,uuid,text,uuid,uuid)` | 20261031100220 | default_roots,default_revisions,override_revisions AS; regional_defaults SHARE |
| `app.b013_change_default(...9)` | 20261031100220 | policy_commands RE; default_roots,default_revisions RE; audit_log RE |
| `app.b013_close_default(...6)` | 20261031100220 | policy_commands RE |
| `app.b013_default_status(...6)` | 20261031100220 | policy_commands AS |
| `app.b013_default_result(...5)` | 20261031100220 | policy_commands AS |
| `app.b013_finish_default(...7)` | 20261031100220 | policy_commands AS; default_roots,default_revisions,audit_log AS |
| `app.b013_change_override(...9)` | 20261031100221 | policy_commands RE; property_owners,override_revisions,audit_log RE |
| `app.b013_close_override(...6)` | 20261031100221 | policy_commands RE |
| `app.b013_override_status(...6)` | 20261031100221 | policy_commands AS |
| `app.b013_override_result(...5)` | 20261031100221 | policy_commands AS |
| `app.b013_finish_override(...7)` | 20261031100221 | policy_commands AS; override_revisions,audit_log AS |
| `app.b028_delivery_enabled(uuid)` | 20261106235000 | platform_settings SHARE |

AS = ACCESS SHARE, RE = ROW EXCLUSIVE. Rows not marked (B) are (A) bounded wait. Exact signatures and
strategies are in the migration's `v_targets`.

**Deliberately not converted (3 functions, 4 statements):** `app.b010_fence_legacy_reminders()`
(20261106160000; invoices ROW SHARE + platform_settings SHARE), `app.b010_guard_payment_transition()` and
`app.b010_lock_payment_context(uuid,uuid,text,uuid,uuid,text)` (20261104120300). Their NOWAIT sits inside
documented bounded polling loops (B-010 r3 / BLK-MAC-11: "no waiting edge" so a pre-held child lock cannot
close a deadlock cycle). Their ~2s x 3 polling budget already rides out a short autovacuum on tiny
`platform_settings`. The guard test pins this exact exemption list and that each still has its
`lock_not_available` / `pg_sleep` loop.

**B-013 repair mutators given `lock_timeout=3s`:** `b013_submit_estimate`, `b013_decide_estimate`,
`b013_authorize_emergency`, `b013_record_appointment` (20261107120000 signatures),
`b013_record_vendor_appointment` (20261105190000), `b013_emit_reminder` (20261105170000). Readers
(`b013_owner_pending/history/manager_view`, `b013_dispatch_allowed`) take no row locks.

## 4. Before / after (`s3-lock-bounds.integration.test.ts`, local timings)

| Probe | Before (08eb990) | After |
|---|---|---|
| `b028_delivery_enabled` vs 300 ms SHARE UPDATE EXCLUSIVE on platform_settings | 55P03 after 4-8 ms | waits, ok at 256 ms |
| `ownerRepairPolicyView` vs same | `busy` | `enabled` at 332 ms |
| same, holder 4.5 s (longer than bound) | 55P03 immediately | `delivery_enabled` 55P03 at 2072 ms; view `busy` at 2137 ms |
| owner view vs 300 ms ACCESS EXCLUSIVE on audit_log (vacuum-truncation stand-in) | `busy` at 30-34 ms | `enabled` at 386 ms |
| owner view vs 300 ms SHARE UPDATE EXCLUSIVE on audit_log | `enabled` (no conflict) | `enabled` |
| owner view vs 300 ms SUE on b013_regional_defaults / AE on property_owners | (not run pre-fix) | `enabled` at 320 / 435 ms |
| helper: deadlock with helper as first waiter | function missing | 55P03 at 1025 ms ("deadlock while waiting"); other tx proceeds |
| production `submitEstimate()` (TS, svc) behind a held ticket row | still waiting at 6000 ms (test cancelled it) | FlowError cause 55P03 at 3042 ms; no estimate row written |
| `submitEstimate()` behind a 300 ms holder | (n/a) | `recorded` at 307-330 ms |
| (B) `b017_resolution_admit` vs 300 ms SUE on platform_settings | 55P03 immediately (single NOWAIT) | ok at 260-271 ms, 0 samples queued in pg_locks |
| (B) same, holder 4.5 s | 55P03 immediately | 55P03 "could not obtain lock" at 2003 ms, 0 samples queued |
| `POST /api/owner-repair-decision` behind a held ticket row | waits as long as the holder, then 500 | `200 {status:"busy"}` at 3025 ms; same requestId then `recorded` |
| `POST /api/vendor-job-response` behind a held ticket row | waits as long as the holder; a 55P03 would have been 403 | `200 {status:"busy"}` at 3021 ms; same requestId then `recorded` |

First pre-fix run (5 tests): 0/5 pass. Post-fix: 8/8 pass. The route "before" column is from code reading
(no mapping existed; the owner route rethrew, the vendor routes returned 403 for any FlowError).

## 5. Changed existing assertions (semantics legitimately changed: immediate NOWAIT -> bounded wait)

* `repair-owner-default.integration.test.ts`, test "cold calls authenticate before private DDL admission
  and reject actual relation contention ... in both orders": for each ACCESS EXCLUSIVE-held probe table the
  live-session expectation was `55P03` + message `/could not obtain lock on relation/` + `doesNotMatch(/timeout/)`.
  Now: still `55P03`, message `/canceling statement due to lock timeout/`, elapsed 1800-3500 ms. The
  expired-session `42501` expectation and the reverse-order DDL NOWAIT checks are unchanged. Title updated.
* `repair-owner-override.integration.test.ts`, test "cold private/public DDL and exact write-mode admissions
  deny ... after auth": same single assertion change; title updated ("within the S3 lock bound").
* No retries added anywhere.

## 6. Residual risks

1. **Anti-wraparound autovacuum** is never auto-cancelled: affected gateways return a bounded 55P03 /
   `busy` after ~2 s while one runs on platform_settings, contacts, audit_log or the B-013 tables. A real
   autovacuum test was not added: it is not deterministic on a shared local cluster without changing
   `autovacuum_naptime` (cluster-wide, out of bounds). The deterministic holders above stand in for it.
2. **Waiting edges at (A) sites.** The 23 (A) functions now queue (up to 2 s) instead of failing at once.
   A cycle is resolved by the deadlock detector within `deadlock_timeout`; if the helper side is the victim
   it surfaces as 55P03 (tested), but if the *other* transaction detects first it gets 40P01. The four (B)
   sites never queue. (B) does not make autovacuum yield: a SHARE UPDATE EXCLUSIVE held over ~2 s on
   platform_settings/contacts (e.g. a long vacuum of a large `contacts`) still fails them with 55P03.
3. **Polling exemptions keep NOWAIT**: a SHARE UPDATE EXCLUSIVE / truncation lock held longer than their
   ~6 s polling budget (large `invoices` truncation, wraparound vacuum) still yields their existing bounded
   55P03 'busy' result.
4. **Pre-existing, not fixed (outside S3 bounds): vendor mutation path lacks privileges on a real DB.**
   `vendor-job.ts` (`mutationScope`/`resolveVendorJobState` -> `currentRepairVersionId`, `latestEvent`)
   reads `app.b013_estimate_heads` / `app.b013_repair_appointments` as `service_role`, but 20261105170000
   revokes every B-013 table from `service_role`. With vendor_dispatch + repair_approvals ON, the vendor
   response/completion routes therefore fail with 42501 -> 403 before reaching the gateway. The http-retry
   unit tests mock pg and do not see it. The S3 vendor route test bridges it with a clone-only
   `GRANT SELECT ON app.b013_estimate_heads TO service_role` (revoked in `finally`). Needs a separate fix
   (gateway-side read or explicit grant) and an owner decision.
4a. `vendor-job-completion` got the same busy mapping but has no held-row test (same code path as response).
5. **Per-lock, not per-call bound.** lock_timeout bounds each lock wait (3 s mutators, 2 s helper);
   a mutator acquiring several contended locks in sequence can take a small multiple. No statement_timeout
   was added (none requested).
6. **Out of scope, still unbounded:** `app.b009_direct_write_guard()` takes `LOCK TABLE public.platform_settings
   IN SHARE MODE` without NOWAIT or a timeout (autovacuum yields to it; a long user holder does not).
7. **B-028 package 5** (`b028p5` worktree, `b028-parent-lock-measurement.integration.test.ts`) asserts the
   production path is unbounded and that `b013_submit_estimate` proconfig has no timeout, using the
   pre-package-4 signature. When it lands on this stack its "unbounded" scenario must be inverted to the
   bounded 55P03 (and its signature updated).
8. **Other stacks** that add or redefine functions after `20261107150000` are not covered by the patch.

## 7. Re-running the inventory on an integrated tip

```sql
-- Any table-level NOWAIT left (expect exactly the 3 (C) polling functions + app.lock_tables_nowait_retry):
SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname IN ('app','public') AND p.prosrc ~* 'LOCK\s+TABLE[^;]*NOWAIT' ORDER BY 1;
-- Statements per function:
SELECT p.oid::regprocedure, m[1] FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace,
 regexp_matches(p.prosrc,'(LOCK\s+TABLE\s+[^;]*?\s+IN\s+[A-Z ]+?\s+MODE\s+NOWAIT\s*;)','gi') m
WHERE n.nspname IN ('app','public') ORDER BY 1;
-- B-013 mutators without a lock_timeout:
SELECT p.oid::regprocedure, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='app' AND p.proname ~ '^b013_(submit|decide|authorize|record|emit)'
 AND NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'lock_timeout=%');
```

Or run `tsx --test --test-concurrency=1 src/server/s3-lock-bounds.integration.test.ts`: its catalog test
fails on any new single-shot NOWAIT table lock, any (A)/(B) site using the wrong helper, or any B-013
mutator without `lock_timeout=3s`. A function
redefined by a later migration (`CREATE OR REPLACE` from its old source text) silently reverts to NOWAIT; the
catalog test is the tripwire, and the fix is a follow-up migration listing it.

# B-028 L2 design — local overlap and OFF evidence

## 2026-11-06 slice (delegated local implementation)

Scope: gap-plan package 3 and the integration-test OFF matrix from package 5 in `/tmp/codex-evidence-B-028.md`; acceptance scope follows the [B-028 spec](B-028.md). Claude holds repository ownership and is the sole committer. This slice adds no migration or fence change.

### What this slice exercises

- `reminder-foundation.integration.test.ts` drives `deliverReminders` through the production legacy claim/complete/release SQL and an injected mock transport, alongside the real scheduled producer and capture adapter. `legacyReminderStore` exposes only database execution and transport injection; cron defaults and SQL are unchanged. Distinct PostgreSQL backends share one synthetic org, invoice, local day, email channel and recipient. Separate clones isolate each ordering.
- Legacy-first, new-first, and a committed legacy claim paused before transport across OFF→ON must produce exactly one combined legacy send/new capture. An additional uncommitted legacy claim is held across the transition to expose the in-flight database race. Every case retains the strict combined count ≤1 assertion. Complete legacy rows and capture rows (including timestamps/digest) survive replay; unrelated-org overdue and same-org lease-expiry plans still complete once.
- `notification-off.integration.test.ts` covers manager, tenant, owner and vendor under six controls: absent global row, false global enabled, malformed enabled, malformed allowlist, allowlist without the org, and false org opt-in (24 cases). It invokes the real entry and route functions with only Next request/presentation dependencies supplied by the harness, and uses real SQL gateways. Each case requires hidden entry, route 404 signal, empty reads, no marker after marking an existing recipient, and identical full rows across all `public`/`app` tables, including other organizations and financial/repair outcomes. ON admission/route/read controls prove valid identities and recipients; final ON marks prove OFF did not consume the notification.
- This is server-component/database integration evidence, not browser rendering or an HTTP response test. No repair command is invoked, so the documented B-013 disabled-command record exception is neither changed nor tested away.

### Race defect retained for separate fence work

The uncommitted OFF→ON ordering allows a duplicate combined attempt:

1. Connection A begins a transaction and inserts the real legacy `email_log` claim while the rollout is OFF; it pauses before commit and before transport.
2. Connection B enables the synthetic org rollout. A's claim is invisible to B. The scheduled producer sees no legacy claim, creates the event, and the production capture adapter records one completed local capture.
3. A commits, resumes the legacy delivery loop, performs one mock send, and updates `message_id`/`sent_at`. Both completion records persist.
4. Combined attempts are **1 legacy send + 1 new capture = 2** for the same recipient/occurrence. A subsequent new claim is denied with SQLSTATE `42501` after the legacy row becomes visible; that late denial does not undo either attempt.

The current OFF early return in `app.b010_fence_legacy_reminders` (`20261104120300_b010_flag_first_locks.sql`) avoids rollout locking. Scheduling/capture in `20261031100212_b010_b028_local_events.sql` checks visible `email_log` rows, with no shared ownership arbitration for this uncommitted interleaving. The regression is kept verbatim but excluded from the shared gate: it runs only with `B028_RUN_KNOWN_DEFECT=1` (`npm run test:b028-known-defect`), so the defect stays reproducible without turning `test:rls` red (Claude decision, hub BLK-MAC-11). No weakened count or fence patch. This demonstrates a local capture/mock-send overlap, not two externally delivered emails. Fix design and any additive migration belong to a separately authorized slice.

### Flags and remaining work

Committed rollout configuration is unchanged and OFF. `rent_reminders_v2` and `notification_center_v2` are enabled only inside disposable local clones; no hosted environment, real transport, commit, push, ownership script, or operational flag change is part of this slice. New DB tests are appended to `test:rls`; the overlap file was already registered.

Still pending: package 1 common durable channel ownership/truthful delivery statuses; package 2 seven real event producers and EN/zh-TW template captures (renewal needs a durable operation); package 4 inherited repair actor/environment/photo/appointment integrity evidence and enforcement; and the rest of package 5 (browser OFF matrix, local parent-lock measurements, actual T0 reserve, candidate-bound capture/hash manifest and independent acceptance). Package 3 now has executable evidence but remains blocked by the reproduced race (fix direction for BLK-MAC-11: the new scheduling/capture path should reserve the same `email_log` uniqueness slot as the legacy claim — or both paths take a shared per-occurrence advisory lock — so an in-flight uncommitted legacy claim blocks it; additive migration + review required). Whole B-028 and release/activation acceptance remain incomplete.

### Local verification

Disposable base: `condola_b_028` on `127.0.0.1:55432`; applied the Supabase stub and all existing migrations, then ran `npm run db:reset`. Tests create and remove their own clones. Logs are under `/tmp/b028-*.log` and are local working evidence, not an immutable candidate verdict.

Commands: `npm run typecheck`; `npm run lint`; `npm run copy:check`; `npx tsx --test src/server/reminders.test.ts src/server/reminder-foundation.test.ts`; `npx tsx --test --test-concurrency=1 src/server/reminder-foundation.integration.test.ts src/server/notification-off.integration.test.ts src/server/overdue-schedule.integration.test.ts src/server/notification-center.integration.test.ts src/server/b010-lock-order.integration.test.ts`; `bash scripts/check-function-privileges.sh`.

Results: typecheck PASS; lint PASS (0 errors, 15 warnings in unchanged files); copy check 6/6 PASS; targeted unit suites 9/9 PASS; function-privilege check PASS (zero anon-executable public functions, allowlist matched). The integration run reports 79 tests, 77 PASS and 2 FAIL: one failing uncommitted-race subtest plus its parent aggregate. All 24 OFF matrix cases, the other three overlap orderings, and the existing foundation/schedule/center/lock-order tests passed; zero skipped/todo. Exact failing assertion: `paused-uncommitted-legacy-OFF-to-ON: legacy sends 1 + new captures 1 exceeds one`. Full output: `/tmp/b028-integration.log`. The earlier `/tmp/b028-new-tests.log` retains the initial run where a later replay denial masked that count assertion; the test now checks that denial explicitly before reporting the duplicate.

Independent Claude review and candidate binding remain with the orchestrator. The known-defect ordering is excluded from the registered suite by env gate; the shared gate is green; the defect is open (BLK-MAC-11).

## Post-exclusion run and QA (Claude, 2026-11-06 ~04:25 PT)

- Gate mode (known-defect ordering excluded): `npx tsx --test --test-concurrency=1 src/server/reminder-foundation.integration.test.ts src/server/notification-off.integration.test.ts` on `condola_b_028` → **34 pass / 0 fail**.
- Known-defect mode: `npm run test:b028-known-defect` → 3 pass / 2 fail (the uncommitted OFF→ON duplicate and its parent), as intended.
- Codex QA r1 **PASS**. LOW noted for the fix slice: once the fence blocks the new path, this ordering must start the new path concurrently, verify contention, commit legacy, then await bounded completion (the current sequential `await runNew()` would hang).

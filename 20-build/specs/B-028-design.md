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

Still pending: package 1 common durable channel ownership/truthful delivery statuses; package 2 seven real event producers and EN/zh-TW template captures (renewal needs a durable operation); package 4 inherited repair actor/environment/photo/appointment integrity evidence and enforcement; and the rest of package 5 (browser OFF matrix, local parent-lock measurements, actual T0 reserve, candidate-bound capture/hash manifest and independent acceptance). Package 3 now has executable evidence but remains blocked by the reproduced race — **fixed below** (original fix direction for BLK-MAC-11: the new scheduling/capture path should reserve the same `email_log` uniqueness slot as the legacy claim — or both paths take a shared per-occurrence advisory lock — so an in-flight uncommitted legacy claim blocks it; additive migration + review required). Whole B-028 and release/activation acceptance remain incomplete.

### Local verification

Disposable base: `condola_b_028` on `127.0.0.1:55432`; applied the Supabase stub and all existing migrations, then ran `npm run db:reset`. Tests create and remove their own clones. Logs are under `/tmp/b028-*.log` and are local working evidence, not an immutable candidate verdict.

Commands: `npm run typecheck`; `npm run lint`; `npm run copy:check`; `npx tsx --test src/server/reminders.test.ts src/server/reminder-foundation.test.ts`; `npx tsx --test --test-concurrency=1 src/server/reminder-foundation.integration.test.ts src/server/notification-off.integration.test.ts src/server/overdue-schedule.integration.test.ts src/server/notification-center.integration.test.ts src/server/b010-lock-order.integration.test.ts`; `bash scripts/check-function-privileges.sh`.

Results: typecheck PASS; lint PASS (0 errors, 15 warnings in unchanged files); copy check 6/6 PASS; targeted unit suites 9/9 PASS; function-privilege check PASS (zero anon-executable public functions, allowlist matched). The integration run reports 79 tests, 77 PASS and 2 FAIL: one failing uncommitted-race subtest plus its parent aggregate. All 24 OFF matrix cases, the other three overlap orderings, and the existing foundation/schedule/center/lock-order tests passed; zero skipped/todo. Exact failing assertion: `paused-uncommitted-legacy-OFF-to-ON: legacy sends 1 + new captures 1 exceeds one`. Full output: `/tmp/b028-integration.log`. The earlier `/tmp/b028-new-tests.log` retains the initial run where a later replay denial masked that count assertion; the test now checks that denial explicitly before reporting the duplicate.

Independent Claude review and candidate binding remain with the orchestrator. The known-defect ordering is excluded from the registered suite by env gate; the shared gate is green; the defect is open (BLK-MAC-11).

## Post-exclusion run and QA (Claude, 2026-11-06 ~04:25 PT)

- Gate mode (known-defect ordering excluded): `npx tsx --test --test-concurrency=1 src/server/reminder-foundation.integration.test.ts src/server/notification-off.integration.test.ts` on `condola_b_028` → **34 pass / 0 fail**.
- Known-defect mode: `npm run test:b028-known-defect` → 3 pass / 2 fail (the uncommitted OFF→ON duplicate and its parent), as intended.
- Codex QA r1 **PASS**. LOW noted for the fix slice: once the fence blocks the new path, this ordering must start the new path concurrently, verify contention, commit legacy, then await bounded completion (the current sequential `await runNew()` would hang).

## BLK-MAC-11 fix (Claude, Mode 1, 2026-11-06)

Migration `20261106160000_b028_legacy_claim_invoice_fence.sql` replaces only `app.b010_fence_legacy_reminders` (the `20261104120300` body, otherwise unchanged) with one leading lock: for rent-overdue claims, in **every** rollout state, the trigger takes the target invoice `FOR KEY SHARE NOWAIT` with bounded polling (~6 s, then `55P03 'Legacy reminder claim busy'`, which `legacyReminderStore` already treats as fenced → no send). All five new-owner paths (`b010_schedule_rent`, `b010_manual_reminder`, `b028_claim_manual`, `b028_finish_manual`, `b028_claim_scheduled`) lock the invoice `FOR UPDATE` before their `email_log` check, so an in-flight uncommitted legacy claim now makes them wait and then see the committed claim. No table, column, grant, flag or data change; OFF still writes nothing (a lock only).

- **Lock design.** The legacy side never waits (NOWAIT), matching the B-010 r3 rule; the only waiting edge is new path → legacy, so no cycle can form. Codex QA r1 found that a blocking first version could deadlock a multi-claim legacy transaction against a payment locking invoices in id order; the NOWAIT version turns that into a bounded busy error.
- **Tests (gate, no env opt-in any more).** The uncommitted OFF→ON ordering is now part of `legacy_and_new_same_occurrence_single_owner`: the scheduler is proven blocked (`pg_blocking_pids` = legacy backend, `wait_event_type = Lock`), then after the legacy commit schedules nothing → 1 legacy send + 0 captures. New `legacy claim invoice lock never waits…`: legacy holds B, payment holds A and waits for B, legacy claims A → `55P03` within the bound (not `40P01`), then the payment completes. `test:b028-known-defect` script removed.
- **Negative control.** With the old function restored on a clone, the uncommitted ordering fails ("new scheduler waits for the uncommitted legacy claim").
- **Residual (QA LOW).** A new-path call blocked behind a legacy claim keeps its `platform_settings` SHARE lock while waiting, delaying a concurrent rollout change for as long as the legacy transaction holds its invoice lock — milliseconds for the production cron (`legacyReminderStore(query)` is one autocommit statement per claim), but an explicit caller transaction keeps it until that transaction ends; the six-second bound covers only acquisition. A caller-level `lock_timeout`/`statement_timeout` on the new path aborts scheduling for that run (no capture; retried on the next run). The bound also covers the implicit table lock (`LOCK TABLE invoices IN ROW SHARE MODE NOWAIT` inside the retry block) so DDL cannot make the legacy claim wait. Not proven on hosted roles; staging remains PE.
- **QA.** Codex QA r1 FAIL (blocking-lock deadlock) → NOWAIT fix → **r2 PASS**; its three LOWs (DDL table-lock wait, unproven payment block/hang bound in the regression, lock-lifetime wording) fixed after r2.

## Package 1 — Common durable delivery attempts and truthful statuses (Session 2, Claude L2)

Branch `feat/b-028-delivery-claims` stacked on #58. Flag `notification_delivery_v2` (global `enabled` + org
allowlist + org `feature_flags.notification_delivery_v2 === true`, default OFF; OFF ⇒ zero writes, existing reminder /
report / center paths unchanged).

**Model (additive migration `20261106235000_b028_notification_delivery_claims.sql`).** Private
`app.b028_delivery_attempts(id, org_id, source_kind, source_id, recipient_key, channel, status, attempt, claim_token_hash,
claim_expires_at, provider_ref, failure_code, created_at, updated_at)`, unique `(org_id, source_kind, source_id,
recipient_key, channel)`; `channel ∈ {email, line}`; `status ∈ {queued, claimed, captured, accepted, failed}` — there is
**no `sent`/`delivered` state**: `captured` = prepared locally (no transport), `accepted` = transport accepted the
request (never displayed as delivered). Append-only `app.b028_delivery_attempt_events` keeps each transition.
Service-only SECURITY DEFINER gateways (`search_path` pinned): `b028_delivery_enqueue` (idempotent),
`b028_delivery_claim` (`FOR UPDATE SKIP LOCKED`, fresh token, expiry, attempt+1), `b028_delivery_complete` (matching
unexpired token only; result `captured|accepted|failed`), `b028_delivery_status` (per-source counts by status). Lock order:
`platform_settings` SHARE → organization → attempt rows.

**TS.** `src/server/notification-delivery.ts`: `DeliveryAdapter` interface `{channel; deliver(req) → {result:
"accepted"|"failed"|"captured"; providerRef?; failureCode?}}`; `createCaptureAdapter(channel)` (local, zero network);
`runDeliveryAttempt` = claim → adapter → complete. Status labels via `src/i18n/lanes/notification-center.ts` keys
(`queued/claimed/captured/accepted/failed`) with copy that never claims delivery. Reminder/report adapters are not
rewired in this package (their OFF paths stay byte-identical); LINE (B-033) consumes this contract.

**Tests.** `two_workers_one_attempt_and_truthful_results` (two clients, one owner, one capture; expiry → reclaim; stale
token rejected; failure → retry; completed recipients never repeated); status rendering distinct with no
delivered/sent claim; OFF matrix (absent/false/malformed global, missing allowlist, org false) ⇒ zero rows; cross-org
denial; privilege catalog.

## Package 2 — Event producers and template captures (Session 2, Claude L2, local only)

Branch `feat/b-028-event-producers`, stacked on package 1. Flag `notification_events_v2` (platform setting
`{"enabled":false,"allowed_org_ids":[]}` + `ops/flags.yaml`, default OFF; strict `enabled === true`, allowlist array
containing the org, and org `feature_flags.notification_events_v2 === true`; missing/malformed is OFF).

**Model (additive migration `20261107080000_b028_notification_event_producers.sql`).** Private, RLS-enabled, REVOKE ALL,
statement-level immutable `app.b028_notification_events` (family, kind, `source_table/source_id` = versioned aggregate,
`source_version`, `offset_key`, `source_row_table/source_row_id` = exact committed row, `template_version`, template
`vars`) unique on `(org, source, version, offset)`, and `app.b028_notification_event_recipients` (persona
staff/tenant/owner, `recipient_key`, composite `(org_id, contact_id|member_id)` FKs) unique on
`(org, source, version, recipient, offset)`. Service-only SECURITY DEFINER gateways (search_path
`pg_catalog,public,app,pg_temp`, EXECUTE only to `service_role`): `app.b028_produce_event(org, source_kind, source_row)`
derives family/kind/version/offset/recipients from rows of that org only (returns NULL — no effect — when OFF, for a
pinned different org, or for an ineligible/foreign source; a replay returns the existing event with no new rows), and
writes one package-1 attempt per recipient through `app.b028_attempt_insert` (named outside the `b028_delivery_*` prefix so the package-1 privilege
catalog test, which counts that prefix, passes unchanged) — the single internal, ungranted row
write that `app.b028_delivery_enqueue` now also calls (redefined by CREATE OR REPLACE with its package-1 body unchanged
apart from that call, NOWAIT admission first) — only when `notification_delivery_v2` is also ON and the family is not
bill. **Producer admission is weaker than enqueue's and the fence moves to claim time (review r2 MAJOR):** the
producer reads the delivery flag without locks, so a transaction that read ON may commit its attempt after OFF
committed. Such an attempt stays inert while OFF (`b028_delivery_claim`/`b028_delivery_status` admission return
nothing). Re-ON cannot dispatch it: triggers on `platform_settings` (key `notification_delivery_v2`) and
`organizations.feature_flags` (the org trigger reads the settings row `FOR SHARE`, so a concurrent global/allowlist
change cannot hide the transition; it fires only when the org's delivery key changes) append the org to private `app.b028_delivery_on_transitions` only when its *effective*
control turns OFF→ON (nothing is written while it stays OFF), and `b028_delivery_claim` (redefined; identical apart
from one sweep) first retires every queued or lease-expired `b028_event` attempt whose producer transaction started
(event `admitted_at` = `now()`, never later than the snapshot that read the control — covers REPEATABLE READ callers)
before the org's latest ON transition as terminal `failed`/`stale_admission`. Conservative by design: producer attempts still queued across any
OFF period are retired, never sent late; package-1 attempts of other source kinds are untouched. The remaining
predicate copies are the TS probe (a role-agnostic prefilter; the gateway re-checks authoritatively) and the
lock-free `app.b028_events_flag`; `app.b028_event_message` returns
template inputs (empty while OFF). Locking (review r1 MAJOR): flags are a plain snapshot read
(`app.b028_events_flag`), no LOCK TABLE / row lock / NOWAIT and no function `lock_timeout`, so a concurrent settings
write or org `FOR UPDATE` can never fail the business action with 55P03; FK key-share waits follow the business
transaction's own policy. **Bills (review r1 BLOCKER):** recipient rows link 1:1 to the reminder's existing
`b028_recipient_claims` (`claim_id`, unique, CHECKed for bill only) and get **no** package-1 attempt — the claim path
keeps sole Email ownership, so each reminder recipient is one Email across both paths.

**Producers (`src/server/notification-event-producers.ts`), each on the business transaction's own client, committing
atomically with it:**

| Family | Real operation | Source / version / offset | Intended recipients |
|---|---|---|---|
| invite | `issuePortalInvite` (new invitation) | invitation / `issued` / owner\|tenant | the invited contact (persona = invite kind) |
| bill | `runLocalRentReminders` (`b010_schedule_rent`), `queueManualReminder` | `b010_source_events` / occurrence_key / `day:N` or `manual` | existing `b028_recipient_claims` (tenant contacts, staff members) |
| payment | `confirmPayment`, `rejectPayment`, `reversePayment`, `recordPayment`, legacy `approveMatch`, B-009 `decideBankMatch` (`producePaymentResultEvent`) | payment / committed status / `result` | the payer tenant only (co-tenants excluded) |
| handover | `publishHandover` | handover record / revision / phase | current tenant parties of the lease |
| report | `recordStatementVersion` | owner statement / version_no / `version` | the statement's owner contact |
| repair | `submitEstimate` (owner decision required), `authorizeEmergency` (outbox `emergency_owner_notice`), `decideEstimate` | ticket / `estimate:N`\|`emergency:N`\|`decision:N` / approval\|outbox kind\|decision | designated owner contact+principal; decision → submitting admin/manager |

Not wired: handover attachment versions/replies,
`b013_emit_reminder` (no TS caller), center source/recipient readers (center kinds unchanged). **Renewal is deferred**:
the only renewal code here is the read-only comparison preview; no event is emitted from it. It needs the durable
renewal operation on its own branch; the event `family`/`kind` CHECKs deliberately exclude renewal.

**OFF contract.** Each hook issues exactly one read-only statement (tagged `/* b028:notification_events_v2 probe */`) and
returns; no role switch, no write. The one existing exact-SQL mock (`owner-repair-decision/request-id.test.ts`) now
answers that probe with OFF.

**Templates.** EN/zh-TW rendering reuses existing copy (rent reminder body, center kind labels, invite strings,
handover/report titles; repair labels are verbatim copies asserted equal to the repair decision copy so the guarded
repair-approval import list is unchanged; invite subjects are new strings). Repair decision recipients use the
admin/manager set of `app.b013_submit_estimate`'s submitter check — no SQL helper resolves another user's role
(`app.has_role` reads `auth.uid()`). ON with an unexpected connection role throws (OFF unchanged). New bodies live in `src/i18n/lanes/notification-events.ts` and pass
`copy:check` (屋主 never 房東; 繳款 wording; no 統一編號). Captures: `e2e-evidence/B-028/templates/<family>.<locale>.txt`
(synthetic seed data; written by the integration test; nothing sent).

**Tests.** `notification-event-families.integration.test.ts` (clone + `resetAndSeed`), per family: (1) baseline trace
with hooks uninstalled (`__setNotificationProducersInstalledForTests(false)`, test-only), (2) OFF trace with
`notification_delivery_v2` ON — statements equal the baseline after removing the probes, zero event/recipient/attempt
rows, (3) ON: the real operation, then exactly one event per committed source with exact source/version/offset/row
references, recipient keys equal to the intended set, producer calls inside the still-open business transaction that
then commits, probe count = producer calls, replay → same event and no new rows, wrong org (ORG2 fully enabled) → NULL,
six disabled controls → NULL and no new rows, one package-1 capture per recipient via `createCaptureAdapter`, second
run captures nothing, zero `fetch` calls; bill: every claim captured exactly once and zero package-1 captures. Plus
privilege/config catalog (incl. no NOWAIT/LOCK in the producer), renewal-deferred, a lock test (held settings write;
held org `FOR UPDATE` for 2.5 s → no error, action succeeds after release) and a rollback test (failure injected after
the producer → zero event/recipient/attempt rows and no handover version).
`notification-event-templates.test.ts` (unit) renders every kind in both locales.

## Package 4 — Inherited B-013 repair authorization/integrity (FALLBACK-SUBAGENT, local only)

Branch `feat/b-028-repair-integrity`, stacked on package 2. Gap-plan item 4 / Reserves 1–3. No new table, column,
flag or product behaviour; `repair_approvals` semantics unchanged. Non-additive migration (drops and recreates the four B-013 session mutators with the environment tuple; `addOnly:false`)
`20261107120000_b028_repair_context_integrity.sql` (lock_timeout 5s, statement_timeout 60s, atomic).

- **Reserve 1 — environment/principal binding.** Private SECURITY DEFINER `app.b028_repair_actor(p_org, p_live,
  p_env, p_session)` (no EXECUTE for any API role) applies the exact B-021 reader tuple predicate (`p_env ∈
  {live,sandbox}`; live org is `environment='live' AND live_org_id IS NULL`; live ⇒ `org = live`; sandbox ⇒
  `org.live_org_id = live`), then the unchanged `app.b013_actor`, then requires `auth.uid()` (set by `svc()` from
  `Session.userId`) to equal the session's user. `b013_submit_estimate`, `b013_decide_estimate`,
  `b013_authorize_emergency` and `b013_record_appointment` are DROPped and recreated with `(p_org, p_live, p_env,
  p_session, …)`: CREATE OR REPLACE cannot add parameters, and keeping the old overloads would leave an unbound path
  (B-024 precedent). Bodies are identical apart from the actor call (start and final recheck) and the photo call;
  grants, SECURITY DEFINER and `search_path` (`pg_catalog,app` for record_appointment) preserved. The tuple is a
  function of the org, so replay identity is unchanged. `repair-approval.ts` passes
  `[orgId, liveOrgId, environment, sessionId]` via `sessionContext()` (rejects non live/sandbox before I/O).
  Readers, `b013_record_vendor_appointment` (token capability, no session), `b013_emit_reminder` and
  `b013_dispatch_allowed` are unchanged.
- **OFF.** The context check runs before replay and the flag check, as in the readers. A valid context with
  `repair_approvals` OFF still records exactly one `rejected_disabled` command (documented exception, preserved and
  re-asserted); an invalid context raises `42501` and writes nothing, ON or OFF.
- **Reserve 2 — photos.** Private `app.b028_repair_photo_refs(p_org, p_ticket, p_refs, p_min)` keeps the existing
  shape check, then requires every ref id to be a UUID naming a `ticket_attachments` row of the same org and ticket,
  joined to a `files` row of the same org in `ticket-photos-private`, and `NOT is_internal`; rows are pinned
  `FOR SHARE OF a, f`. Any failing ref rejects the whole command (`rejected_invalid`; no strip — no caller relies on
  stripping). The schema has no revocation/deletion column: deleted = row absent; "revoked" is modelled as
  `is_internal` (hidden from the owner who reads the refs). Readers still project `{id}` only.
- **Reserve 3 — appointment/job.** The B-021 insert guard did not cover parent updates: a referenced job's
  `ticket_id`/`org_id` could be reassigned (the test's negative control drops the new FK and the UPDATE succeeds).
  Added `b028_appointment_job_scope_fkey`: `(org_id, ticket_id, repair_vendor_job_id) → repair_vendor_jobs(org_id,
  ticket_id, id)` on the existing `b028_vendor_job_scope_unique` index, `NOT VALID` then `VALIDATE`. Reassignment now
  fails `23503`; non-scope updates (revocation) still work.

**Tests.** New `b028-repair-integrity.integration.test.ts` (registered in `test:rls`, 8 tests): valid live and sandbox
contexts record all four mutators; 80 denials (4 mutators × live/sandbox × swapped env, unknown env, live-org mismatch,
live = sandbox, wrong principal, missing principal, another user's session, no session, revoked, expired), each `42501`
with full-row snapshots of all seven B-013 tables + repair audit unchanged; replay under a swapped/foreign context
denied; OFF contract; photos (foreign ticket, foreign org, sandbox of the same live org, missing, deleted, internal,
moved out of the private bucket, non-UUID, mixed) rejected for evidence and emergency with zero domain/outbox writes and
only the `rejected_invalid` ledger rows; authorized refs accepted and readers never expose storage keys/URLs; wrong-org
appointment insert/gateway and parent reassignment rejected with references preserved; catalog (old signatures gone,
helpers private, FK validated); real TS wrapper denials (swapped env, live-org, userId mismatch) with zero writes.
Negative control: with both helpers weakened to the old behaviour, 5/8 tests fail. Existing repair suites, the
decision-route mock and the repair family test now pass the tuple/principal and use real photo rows instead of the
synthetic ids `"photo"`, `"evidence"`, `"fixture-photo"`, `"synthetic-photo"`.

**Open.** Readers still use `b013_actor` without the principal (`auth.uid()`) check (tuple already enforced); the
photo `FOR SHARE` pin is not exercised under concurrency; hosted roles/`auth.uid()` behaviour unproven (staging is PE);
Reserve 4 (T0 parent-FK lock timing) untouched.
## Package 5 — OFF matrix, local parent-lock measurement, candidate-bound evidence (Claude L2, FALLBACK-SUBAGENT, no migration)
Branch `feat/b-028-off-matrix-evidence`, stacked on package 2 (`8a388de`). No migration, no flag/config change, no hosted run.
**Browser OFF matrix (`e2e/b028-center-local.spec.ts`, new test next to the existing ON test).** Private config
`e2e/b028-off-private-playwright.config.ts` (Next dev on `localhost:43153`, the origin Next reports, so the strict
same-origin mark check runs unmodified; Supabase/provider/token env stripped); `scripts/run-e2e.ts` now maps this spec
to that config instead of the shared b017 config. Synthetic fixture: one rent-due event (staff + tenant recipients) and
one vendor-job event (owner + vendor-job recipients) on the demo org. One browser context per portal (`/m`, `/t` with
the fixture lease selected, `/o`, `/v/<job token>`). ON positive control first (entry visible, route 200, one unread
item per portal). Then 6 controls × 4 portals = 24 cases: absent global row, `enabled:false`, `enabled:"true"`
(malformed), non-array allowlist (malformed), org missing from allowlist, org `feature_flags.notification_center_v2=false`.
Each case: home 200 with no `notification-center-entry`; notifications route HTTP 404; a well-formed same-origin mark
POST (`/api/notification-center/mark`, vendor: `/vendor-mark` with token) answers 404; zero `b028_center_reads` rows;
every `public`/`app` row across all orgs unchanged (snapshot before/after; only `auth_sessions.last_active_at/expires_at`,
which every authenticated request refreshes, are excluded). Final ON: each recipient is still unread and the identical
mark request now returns 200, proving the OFF 404s came from the control. No non-local browser request (server-side Next/Wrangler telemetry disabled in the config env), console error (other
than the expected route 404) or 5xx. If Chromium is not installed the file skips cleanly (`test.skip`; test-level, so the config's local
webServer still boots first); the same matrix
runs at server-render level in `src/server/notification-off.integration.test.ts` (unchanged, 24 cases). Repair commands
are not invoked, so the documented B-013 disabled-command record exception is untouched.
**Local parent-lock measurement (`src/server/b028-parent-lock-measurement.integration.test.ts`, registered in
`test:rls`).** LOCAL MEASUREMENT ONLY on a disposable clone with synthetic data — not the T0 rehearsal. A holder
backend runs the first statement and keeps its transaction open 400 ms; a waiter runs the second with a
**test-imposed** `lock_timeout=3s`; an observer samples `pg_stat_activity`, `pg_blocking_pids` and `pg_locks` every
20 ms. Both transactions roll back. Pairs (both orders where meaningful): `maintenance_tickets` non-key UPDATE ↔ real
`app.b013_submit_estimate` (ticket `FOR UPDATE`); `properties` and designated owner `contacts` non-key UPDATE → the same
gateway (`properties FOR SHARE`, `FOR SHARE OF po, c`); `property_owners` non-key UPDATE ↔ the gateway;
`repair_vendor_jobs` non-key UPDATE ↔ `b013_repair_appointments` INSERT (job guard `FOR SHARE` + FK); control:
`maintenance_tickets` non-key UPDATE vs bare `b013_estimate_heads` FK insert (key-share; asserts only that it is never
observed blocked, elapsed recorded as data); test-imposed bound: ticket held 1.5 s vs gateway with `lock_timeout=250ms`
→ `55P03`. Blocked cases assert waiting on `Lock/transactionid` with `pg_blocking_pids` = holder only, elapsed ≥
0.75×hold and < the test lock_timeout. **Production path (review r1 MAJOR):** the real call path
`repair-approval.ts submitEstimate → run → svc → svcOn` sets no `lock_timeout`/`statement_timeout`, the gateway's
`proconfig` has only `search_path`, and the local role/database settings carry no timeout override (defaults `0`). The
`production-call-path-unbounded-wait` scenario calls that TS wrapper behind a held ticket row with no test-set timeout:
after a 1.5 s test-side deadline it is still waiting on the holder, and is then cancelled by the test via
`pg_cancel_backend`. So the bounds above exist only in the test; a blocked production repair mutator currently waits
as long as the parent holder's transaction. JSON (`B028_PARENT_LOCK_JSON=<path>` →
`e2e-evidence/B-028/parent-lock-measurement.local.json`) records `callerTimeouts` and a blocker count (no raw pids).
Finding: B-013 parent contention comes from the explicit gateway/guard row locks, not from the FK checks. **Open T0/PE
item: add or verify a caller timeout on B-013 repair mutators.** Hosted roles, settings, data volume and concurrency are
not represented; the T0 reserve stays pending.
**Evidence manifest.** `e2e-evidence/B-028/{acceptance,status,verdict}.md` rewritten as one candidate-bound manifest
(`CANDIDATE_SHA` filled by Claude at commit), linking the six-family template captures with SHA-256, the OFF-matrix JSON
and the parent-lock JSON. Renewal deferred; T0 reserve pending; hosted/staging not run; independent QA pending.

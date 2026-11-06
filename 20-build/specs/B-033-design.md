# B-033 — LINE shared foundation (L2 design)

> Author: Claude (Mac Session 2, 2026-11-06 PT). Hub `20-build/specs/B-033.md` (incl. the PROP-US-v03-02 compatibility
> reserve — preserved below) + hub `05-capabilities/line-tenant-slice-design.md` §3–§9 (adapted from tenant-only to the
> full three portals per Ron). Branch `feat/b-033-line-foundation` on `feat/line-integration-base`
> (#36 + #37 B-018 + #48 PROP-06 + #58/B-028 + B-028 package 1 + #62/B-027 + #66/B-026).

## Hard rules (all slices)

- **Zero live LINE HTTP.** Every LINE call goes through a `LineTransport` interface; the only implementation in this
  repo is a local mock/captured transport (`createCapturedLineTransport`). No fetch to `api.line.me` / `access.line.me`.
- **Flags default OFF.** `LINE_PLATFORM_ENABLED` (global env, strict `=== "true"`) + platform setting `line_platform`
  (`enabled` + `allowed_org_ids`) + org `feature_flags.line_platform === true`; portal flags `line_tenant_portal`,
  `line_vendor_portal`, `line_owner_portal`; push flag `line_push`. OFF ⇒ zero writes, existing routes unchanged.
- **`LINE_PUSH_QUOTA_GUARD` defaults ON whenever LINE is enabled.** Missing / disabled / malformed guard, or an
  unavailable counter ⇒ no push, Email fallback claimed (fail closed). Turning the guard off is not supported in code.
- Never trust legacy `contacts.line_user_id`; legacy columns are preserved, not written.
- Secrets are references only (`*_secret_ref`); never logged, never stored in plaintext rows.

## Slice 1 — schema, quota guard, signed webhook (this slice)

Migration `20261107000000_b033_line_shared_foundation.sql` (additive):
1. `app.b033_line_identities(id, line_channel_id, provider_user_hash, user_id, persona, status, linked_at,
   unlinked_at, friend_state, friend_state_at, last_event_at)` — provider-scoped identity, user id stored only as a
   keyed hash (`provider_user_hash`, HMAC with a server pepper passed in by the caller), unique per channel.
2. `app.b033_line_flows(id, flow_hash, kind, line_channel_id, persona, state_hash, nonce_hash, expires_at,
   consumed_at)` — one-time hashed login/link flows.
3. `app.b033_webhook_events(line_channel_id, webhook_event_id, event_type, event_ts, received_at)` — dedupe by
   (channel, webhookEventId); friendship state only moves forward by `event_ts` (older events never overwrite newer).
4. `public.line_push_usage` retains the channel/month counter (Asia/Taipei month key). Private
   `app.b033_org_push_budgets(line_channel_id, org_id, period_month, budget, used, reserved)` participates in the
   **same transaction** as the channel reservation. Missing/zero/exhausted org budgets return `line_budget` and
   deduplicated Email fallback. Only `b033_org_budget_set` can write budget configuration as service_role; no UI.
5. `app.b033_push_reservations` pins claim → channel/org/notification/original month. It persists
   `reserved → dispatching → settled|released|unknown`, owner token, started/completed timestamps, attempt count,
   retry deadline, notification deadline, unknown history and fallback claim. `b033_push_start` uses
   `FOR UPDATE NOWAIT`: a second dispatcher gets `busy`. Only the owner of a dispatching row can settle/release;
   TypeScript checks the returned boolean before reporting accepted. Unknown history prevents release after a
   later explicit failure. Both channel and org counters settle/release together against the original month.
6. Quota config: absent `LINE_PUSH_MONTHLY_LIMIT` defaults to 180; malformed, zero, negative or >180 makes the
   guard not ready. SQL also rejects limits outside 1..180 (including NULL). All failures send zero LINE calls.
   Eligibility requires selected active OA, `tenant_config_verified_at`, the applicable persona's LIFF id,
   linked trusted identity matching the recipient/user/persona/hash, friendship, explicit consent/opt-in and budget.
   `b033_channel_verify(channel)` is the service-only verification gateway; direct service/client stamp writes are
   rejected by an invoker trigger (no forgeable GUC). Authenticated admins retain configuration CRUD, but every
   configuration change clears the stamp, including all three LIFF ids, login/messaging ids and secret references,
   provider, active state, mode, org and webhook URL. Display name/created/updated/connected-by metadata is excluded.
   Verification must follow validation of the current configuration; per-persona LIFF presence is still checked.
7. `notification_delivery_v2` must be valid and ON for the org, including its platform allowlist. This is an
   activation prerequisite in both `b033_push_enabled` and the dispatcher. Missing/malformed/disabled B-028 returns
   `fallback_unavailable` with no LINE attempt, reservation or delivery writes; existing legacy producers keep ownership.
   Environment/platform/org LINE OFF exits without writes (including audit, budget, fallback and delivery writes).
   Enabled-but-unhealthy guard/quota/budget failures use `b033_push_fallback`: a claim advisory lock serializes
   the channel decision, and private `b033_push_fallbacks` durably pins claim scope, reason and Email claim without
   requiring a healthy counter/budget. Dispatch checks settled and terminal fallback state before health checks.
   Recovery or concurrent replay cannot switch a terminal fallback back to LINE; an active owner blocks competing fallback.
   Explicit provider failure releases both budgets, enqueues Email, records the terminal fallback and writes both
   deliveries in one transaction. An enqueue/delivery fault rolls everything back to the durable dispatching claim;
   its existing deadline remains available to expiry recovery. Unknown history still prevents releasing quota.
8. Transport execution is bounded to 10 seconds (tests may shorten, never extend). Timeout/throw persists unknown
   and keeps both reservations. At most three attempts reuse the same `X-Line-Retry-Key`; retries stop at the earlier
   of the 24-hour retry-key window and the notification deadline (five minutes after created/scheduled time).
   A dispatch abandoned for 15 seconds can be reclaimed as unknown; stale owner tokens cannot settle or release it.
   `b033_push_expire(org)` / `expireLinePushes(org)` persist `expired`, stop retries and enqueue exactly one Email
   marked `line_unknown_possible_duplicate`, retaining uncertain quota. B-028's Email worker invokes expiry before
   draining claims, including when no LINE caller retries. The worker must be scheduled at the SLA cadence before
   activation; this slice does not deploy or activate a scheduler. Disabled LINE/B-028 suspends expiry writes until restored.
   Environment OFF preserves the original B-028 runner query sequence. Enabled maintenance uses a separate transaction,
   at most 25 expired rows per invocation and a 750ms SQL statement timeout; connection setup retains the shared DB
   helper's 8s timeout. On error it rolls back, logs `b033_expiry_retry_pending` with sanitized SQLSTATE only, retains
   the durable deadline for the next invocation, and continues independently eligible B-028 claims. No automatic retry
   of B-028 unknown outcomes or change to its one-claim-per-dispatch behavior.
9. LINE audits use a dedicated whitelist for both `line_account_links` and `line_channels`; generic `fn_audit`
   is detached. Only internal row/org/contact ids, status, consent/friend flags and timestamps are retained. No
   LINE user/provider identifiers, event ids, tokens, secret refs or raw provider payloads enter these audits.
   New private LINE tables have no generic audit trigger. Historical audits are not rewritten by this unapplied migration.
10. TS transport remains **local capture only**. Exported `POST /api/line/webhook` resolves secrets lazily by the
    selected channel's `messaging_channel_secret_ref`, using server-only `LINE_CHANNEL_SECRETS` JSON of the form
    `{ "<secret-ref>": { "secret": "<value>", "identityPepper": "<value>", "destination": "<bot-id>" } }`.
    Missing/malformed entries produce 503 before writes; invalid/missing signatures produce 401 before JSON parsing.
    Valid signatures, destination, duplicate events and monotonic friendship all use the same exported route.
    OFF returns 404. Secrets remain environment-only and are never logged. No live LINE HTTP exists.

Slice 1 regression evidence covers separate-connection quota and org-budget races; mixed accepted/failed/unknown
concurrent dispatch ownership; forged/stale owners and rejected settlements; persisted masked follow/unfollow audits;
invalid limits and unverified configuration with zero transport calls; missing/exhausted budgets and B-028 activation
prerequisites; hanging transport, attempt cap, original retry key, retry/SLA expiry, abandoned-worker recovery and
exactly-one possible-duplicate Email fallback; actual exported POST signature/dedupe handling; original-month settlement,
once-per-month alerts, private RLS/grants and existing PROP-06/B-028 compatibility. All flags remain OFF.

## Fix round 3 — local validation (2026-11-06 PT)

Five QA findings are covered by real local-DB regressions: OFF snapshots include audits, both budgets, fallback and
Email tables; authenticated-admin INSERT/UPDATE forgery and gateway denial plus configuration invalidation;
settled replay and concurrent terminal fallback/recovery; fault injection at Email enqueue and delivery insert proving
release rollback and deadline recovery; delivery-row lock contention proving bounded maintenance, sanitized error
evidence, unrelated Email progress and successful later retry. Unit regression checks env-OFF runner adds no query.
The unapplied migration is edited in place. Local stub + every migration + seed were applied to fresh
`condola_b033impl` on `127.0.0.1:55432`; the three requested integration files run separately with concurrency 1.
No live LINE HTTP, remote database access, deployment, full `test:rls`, git mutation or external network calls.
Final validation: Node 20.20.2 / npm 10.8.2; `npm run typecheck` PASS; `npm run lint` PASS (0 errors,
16 warnings); `npm run copy:check` 6/6 PASS; `npm run test:unit` 1019/1019 PASS. Separate integration runs:
B-033 94/94 PASS, PROP-06 4/4 PASS, B-028 21/21 PASS; zero skipped tests. `git diff --check` PASS.
Initial B-033 run was 92 PASS / 2 FAIL: raw SQLSTATE was transformed by the shared DB wrapper, affecting the
admin-denial assertion and maintenance error classification. The assertion now checks rejection through that wrapper;
maintenance captures sanitized SQLSTATE before transformation. Both regressions passed in the 94/94 rerun.
Independent Claude QA and all git committing remain with the architect; no independent PASS is claimed here.

## Slice 2 — login callback, one-time flows, atomic invite/link, LIFF config (next)

`/api/line/login/callback` (id_token audience/issuer/expiry/state/nonce/flow verification against a mock JWKS/secret),
existing Condola sessions only (no fabricated Supabase JWTs), atomic invite/link (invite unconsumed on abort), three LIFF
configuration fields; routes `/t/liff`, `/v/liff`, `/o/liff`. Compatible with PROP-01b invite tokens and the M-34 unit-QR
reserve below.

## Reserve preserved — PROP-US-v03-02 (Ron 2026-11-05 19:04 PT)

Unit-QR binding (CAP-M-34) must reuse B-033's provider-scoped identity, atomic invite/link service and three LIFF entries;
QR context tokens must not conflict with the one-time flow's audience/issuer/expiry/state/nonce checks; no duplicate
identities/sessions between the LINE entry and the unit-QR signup path; the QR extension never changes the quota guard
(180/month, `Asia/Taipei` key) or webhook idempotency invariants. Merged rows (B-002/B-003/B-007/B-011/PROP-01b/PROP-10/
PROP-11/B-013) are not reopened.

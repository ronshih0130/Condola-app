# B-038 — Repair-state LINE pushes (L2 design)

Sources: hub `20-build/specs/B-038.md`, hub `05-capabilities/line-tenant-slice-design.md` §8–§8.1,
`B-033-design.md` (slices 1–2) and `B-036-design.md`. Branch `feat/b-038-repair-pushes` on B-036.
Local edits and disposable DB tests only; zero live LINE HTTP (captured `LineTransport` only).

## Done means

Committed repair status changes reach the reporting tenant, and committed owner-approval events reach the
designated owner, as one LINE push each through the existing B-033 dispatcher (eligibility, 180/month
reservation, org budget, settle/release/unknown, B-028 Email fallback). Every recipient is re-authorized at
worker time. Flags default OFF; OFF means zero writes and unchanged repair flows.

## Flag

`line_repair_push`: platform setting (`enabled` + `allowed_org_ids`, seeded OFF/empty, `ON CONFLICT DO NOTHING`)
and strict org `feature_flags.line_repair_push === true`, registered in `ops/flags.yaml` (default false).
It is layered on top of `LINE_PLATFORM_ENABLED` (env, strict `"true"`), `line_platform`, `line_push` and
`notification_delivery_v2`: `app.b038_repair_enabled(org)` = `app.b033_push_enabled(org)` AND the B-038 flag.
The TypeScript worker returns before any query when `LINE_PLATFORM_ENABLED` is not `"true"`.

## Events (committed sources only; no producer change)

The worker reads rows that already committed; no trigger or query is added to existing repair, ticket or
B-013 transactions, so OFF and ON leave those flows byte-for-byte unchanged.

| Kind | Source row (version) | Recipient | Authority at enqueue and again at dispatch |
| --- | --- | --- | --- |
| `ticket_status` | `ticket_comments` with `status_to` set and `is_internal=false` (each committed transition is a version) | Reporting tenant contact (`reported_by_contact_id`, else the reporter user's tenant contact) | Contact unarchived + `is_tenant`; still a party of the ticket's lease (`pending_signature/active/ended`) when the ticket has a lease |
| `approval_requested` | `b013_estimate_versions` requiring an owner decision (each estimate version) | Designated owner contact | Designated `property_owners` row still effective in the org time zone (`effective_from <= today < effective_to`, exclusive end), contact unarchived `is_owner` and still the designated principal, property unarchived |
| `approval_reminder_24h`, `emergency_owner_notice` | `b013_repair_event_outbox` (each outbox row) | Designated owner contact | Same as above |

Approval request/reminder notices that are no longer current (newer version, decision recorded or emergency
authorized) are closed as `superseded` without LINE or Email. Emergency notices are informational and remain.

Activation boundary: `app.b038_repair_cursors` pins the first enabled scan per org; only events at or after
`started_at` (first scan − 15 minutes) and within the last 24 hours are considered. No historical backlog.
A scan gap longer than 15 minutes (flag OFF, or the worker down) moves `started_at` to scan − 15 minutes, so
OFF→ON never pushes stale events from the gap. Consequence: events older than 15 minutes at the first scan
after a gap get neither LINE nor Email; the scheduler must run at the five-minute SLA cadence before activation.

Known authority windows (accepted): recipients are filtered by authority at enqueue, so a revocation that
commits between the event and the scan creates no notification and therefore no Email. Estimate versions,
heads and decisions are not locked by the dispatch-time recheck, so an owner decision committing just after
it may still let one now-stale approval request/reminder push (the LIFF view rechecks on open).

## Data (`20261107100000_b038_line_repair_pushes.sql`, additive)

- `app.b038_repair_cursors(org_id PK, started_at, scanned_at)`.
- `app.b038_repair_pushes(notification_id PK → notifications ON DELETE CASCADE, org_id, claim_id UNIQUE,
  source_kind, source_id, ticket_id, version_id, persona, recipient_contact_id, state queued|claimed|done,
  claim token hash + expiry, attempts, outcome accepted|fallback|withheld|superseded, reason, timestamps)`,
  `UNIQUE(org_id, source_kind, source_id, recipient_contact_id)`. No FK to tickets/contacts so existing
  deletes/archives are never blocked.
- `public.notifications` row per (event, recipient) with `dedupe_key = b038:<kind>:<source>:<contact>`
  (existing `UNIQUE(org_id,dedupe_key)`), `event_type='b038_repair'`, `template_key='line_repair.<kind>'`,
  payload `{kind}` only. No title, description, note, amount, scope, photo, LINE id or token is persisted.
- Both tables: RLS enabled, `REVOKE ALL` from PUBLIC/anon/authenticated/service_role, no policies.
  Gateways are `SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp`, executable only by
  `service_role`; authority helpers have no grants.

Gateways: `b038_repair_enabled`, `b038_repair_enqueue(org)` (advisory-locked scan, `ON CONFLICT DO NOTHING`),
`b038_repair_claim(org,limit,ttl)` (`FOR UPDATE SKIP LOCKED`, hashed one-time token, expired claims
reclaimable), `b038_repair_context(org,notification,token)` (rechecks flag, authority and currency; returns
only the summary fields when authorized), `b038_repair_withhold(...)` and `b038_repair_complete(...)`.

## Dispatch (`src/server/line/repair-push.ts`)

`runLineRepairPushes(orgId, { transport, resolveTarget, env, limit })`:
1. Env kill → return immediately (no query, no write, no transport).
2. Enqueue, then claim one row at a time (`b038_repair_claim`, 120s lease > 4 × (5s target + 10s transport)),
   excluding ids already handled in this run so a requeued row never starves later rows. Before claiming,
   B-033 expiry runs; a row past the five-minute SLA (or 8 attempts) is closed by the claim gateway with the
   deduplicated Email fallback after a recheck: superseded approvals close silently, revoked authority uses
   `repair_authority_revoked`, still-current authorized rows use `repair_push_expired` (or B-033's
   `line_unknown_possible_duplicate` for an uncertain reservation). A busy B-033 owner backs the row off
   (`retry_after` +30s) so it cannot refill the claim window; a failing row is isolated in a subtransaction,
   backed off 60s with `repair_fallback_error`, and later rows continue.
3. Resolve the transient target first (bounded to 5s; the LINE user id and pepper are never persisted).
4. Context gateway: `disabled` → requeue and stop; `superseded` → close silently; `revoked` →
   `b038_repair_withhold('repair_authority_revoked')`; no selected channel → withhold `line_unavailable`.
   The shared `app.b038_fallback` uses the claim's pinned B-033 channel or the selected channel and calls
   `app.b033_push_fallback` (LINE `skipped` + one B-028 Email claim/delivery with the same reason); with no
   channel at all it records the LINE `skipped` and Email deliveries directly (a `b033_push_fallbacks` row
   needs a channel, and no B-033 reservation can exist without one). The LINE message is never built.
5. Authorized → message built in memory (recipient locale zh-TW/en): summary + ticket number (+ estimate
   version) + LIFF deep link `https://liff.line.me/<persona LIFF id>?org=<org>`.
6. `dispatchLinePush` gains an optional `authorize` hook (existing callers unchanged). It runs inside the
   B-033 decision transaction after the claim advisory lock and terminal/settled checks, before guard,
   reservation and start. B-038 passes `app.b038_repair_authorize`, which rechecks the B-038 claim token,
   flags and authority with `FOR SHARE NOWAIT` on contacts/tickets/lease_parties/leases or
   property_owners/properties: `deny` → `fallback('repair_authority_revoked')`; lock contention, a lost
   claim or a superseded approval → `skip` (deferred, no writes). A revocation committing after the context
   check is therefore seen here, or waits until this decision commits.
7. `accepted` → done; durable fallback (with Email claim) → done with reason; deferred/busy/unknown → requeue
   with the same claim id. A lost claim (42501) in completion is caught and does not abort the run.

Replay: same source → same dedupe key → no new notification; settled/fallback claims never re-push.
New version (new comment row / estimate version / outbox row) → new notification.

## Copy

`src/i18n/line-repair-push.ts` (zh-TW + en): 修繕進度更新 / 修繕估價待您決定 / 提醒 / 緊急修繕通知 and the
existing ticket status vocabulary. 屋主 never 房東; never 收款/收租/入帳/已收; no 統一編號.

## Acceptance mapping (`src/server/b038-line-repair-pushes.integration.test.ts`)

| Hub acceptance | Tests |
| --- | --- |
| Tenant-visible change → authorized summary/deep link only | Status change with internal note + photo; internal-only notes ignored; message exact-shape and leak checks |
| Owner approval → current property authority checked | Designated owner only; ended/foreign ownership not selected; other owners/staff never receive |
| Replay/version change → dedupe | Repeated enqueue/run, re-dispatch of settled claim, new estimate version and new status transition notify |
| Revoked authority / quota failure → withheld + Email fallback | Owner ownership ended (exclusive end), tenant removed from lease, quota exhausted, guard failure |
| Global kill → no new LINE push | Env OFF, `line_push` OFF, `line_platform` OFF, kill between enqueue and dispatch |
| Additional | Revocation between context check and dispatch (barrier), stuck row ahead of others + SLA closure, no channel, OFF-gap cursor, OFF matrix with write snapshots, cross-org/foreign scope, concurrent workers, private grants/RLS, zero network |

## Out of scope

Live LINE transport, scheduler activation, Email rendering/sending, vendor pushes, new repair states,
hosted activation, full `test:rls`, Git operations. Claude retains independent review and commits.

## Local validation (2026-11-06 PT)

Fresh `condola_b038impl` (stub + every migration + seed), Node via `localenv.sh`: typecheck PASS; lint PASS
(0 errors, 16 existing warnings, none in B-038 files); copy:check 6/6; test:unit 1036/1036. Separate
`--test-concurrency=1` runs on disposable clones: B-038 21/21 (after round-3 fixes), B-033 foundation 94/94, B-036 owner LIFF 57/57,
repair-approval 20/20, B-027 denial inventory 28/28 (no route drift; not regenerated), plus PROP-05 3/3,
repair 1/1, B-028 21/21. Mutations (owner authority always true; dispatch-time authorize always allow) failed the targeted tests as expected.
`globalThis.fetch` is stubbed to throw; zero calls. Known limits: events outside the activation window
(see Events) get neither LINE nor Email; rows queued during a kill close after the SLA with Email fallback. Independent review, Git and
device verification remain with the architect.

# B-039 — Dispatch LINE pushes and local three-portal rehearsal (L2 design)

> Hub `20-build/specs/B-039.md`; hub `05-capabilities/line-tenant-slice-design.md` §7–§8.1; app
> `20-build/specs/B-033-design.md`, `B-035-design.md`. Branch `feat/b-039-dispatch-pushes` on B-035 → B-033 slices 1–2.

## Hard rules

- **Zero live LINE HTTP and zero network.** The only transport is B-033's captured `LineTransport`. Tests replace
  `globalThis.fetch` with a throwing stub and assert it was never called.
- **Flags default OFF, strict.** New `line_dispatch_push` (platform setting `{enabled,allowed_org_ids}` + org
  `feature_flags.line_dispatch_push === true`) sits on top of `LINE_PLATFORM_ENABLED`, `line_platform`, `line_push`,
  `notification_delivery_v2` (via `app.b033_push_enabled`) and `line_vendor_portal` (the deep link is the B-035 entry).
  Any OFF/missing/malformed gate ⇒ zero writes; existing dispatch, sharing and revoke behavior is unchanged.
  Env OFF adds no query at all to the business transactions.
- **LINE identity is never job authority.** The push target is the vendor's trusted, opted-in, friended link (B-033
  eligibility); the job capability is the existing job token behind `/v/<token>`, rechecked by B-035 on every open.
- One shared quota/retry/fallback policy: every push goes through `dispatchLinePush` (B-033 reservation, owner token,
  same `X-Line-Retry-Key`, settle/release/unknown/expiry, deduplicated B-028 Email fallback with reason).

## Events (committed in the business transaction)

| Event | Produced in | Recipient | Deep link |
| --- | --- | --- | --- |
| `dispatch_assigned` | `approveVendorSharing`, first approval of a job whose vendor is the ticket's current assignee | job vendor | `/v/<token>` (B-035 "continue in LINE" entry) |
| `dispatch_rescheduled` | same, when the ticket's immediately previous job had the same vendor and its announcement is pending or delivered (re-dispatch with a new contact window); `depends_on` that announcement | job vendor | new job's `/v/<token>` |
| `dispatch_cancelled` | `revokeVendorJob`, only when this job's announcement is pending, delivered or uncertain and the vendor is the ticket's assignee at revoke time; `depends_on` that announcement | the (possibly) announced vendor, while the contact is active | none (old link is dead) |

The event is produced when the job becomes openable through the B-035 scope (case collaboration + sharing approval);
a job that is only dispatched has no LIFF-openable scope yet, so a push would carry a dead link. Reassignment to a
different vendor produces no push to the old vendor (not the current assignee); its pending events become stale.
Ticket `scheduled_on` edits are not vendor dispatch events in this slice (vendors see the dispatch contact window,
not `scheduled_on`).

Producer `recordVendorDispatchEvent(client, org, ticket, job, "shared"|"revoked")` runs inside the existing
service transaction: env OFF ⇒ return without a query; org `line_dispatch_push` not strict true ⇒ one read, no write;
otherwise a SAVEPOINT-wrapped call to `app.b039_dispatch_event_record`, which re-evaluates every strict gate and the
job/assignment state under the business transaction and inserts one `notifications` row (no lease, related job,
recipient vendor contact, contact locale, `dedupe_key=b039:<kind>:<job>`, empty payload) plus one private event row.
A producer failure rolls back to the savepoint and logs only a sanitized SQLSTATE; it never fails the dispatch.

## Worker (claim/dispatch time)

`runVendorDispatchPushes(org, {transport, origin, resolveRecipient, env?, limit?, timeoutMs?})`:

1. Env OFF ⇒ return, zero queries. `app.b039_dispatch_push_enabled(org)` false ⇒ return, zero writes.
2. For each pending event (oldest first): read the selected OA, the vendor's trusted link and — for assigned/
   rescheduled — the job secret, then build a minimal zh-TW/en message (no ticket title, address, cost or tenant data).
   The raw LINE `to` comes from the injected server-only `resolveRecipient` (identities store only a keyed hash);
   absence follows the B-033 guard path (`line_guard` Email).
3. Call `dispatchLinePush(..., {authorize})` with the event's persistent `claim_id` (stable retry key). The new
   optional `authorize` hook runs **inside the dispatcher's decision transaction**, after settled/fallback replay checks
   and before guard/reservation: it rechecks all gates (`off` ⇒ no writes), locks ticket→jobs and requires the event
   still pending and, for assigned/rescheduled, the B-035 `vendorScopeOn` write scope for exactly this job token with
   job vendor = ticket assignee = event recipient; for cancelled, the job revoked, the vendor contact active and no
   newer active job for that same vendor (no "still assigned" requirement: the cancel follows the announced party).
   Otherwise `stale` ⇒ `{status:"superseded"}` with no reservation, delivery or Email, and the worker passes the
   claim to `app.b039_dispatch_close_stale` (below) instead of closing it directly.
   Announcement dependency (review fix): a rescheduled/cancelled event waits (`defer`, no writes) while the
   announcement it depends on is pending. A cancellation whose announcement was superseded (never sent) closes
   silently (`superseded/never_announced`, no LINE, no Email). A reschedule whose announcement was superseded is
   the vendor's first notice of an active job, so it is delivered with the *assigned* copy
   (`sent/announced_as_assigned`) rather than dropped. The cancelled recheck requires the job revoked, the vendor
   contact active and no newer active job for that same vendor; it targets the (possibly) announced party.
   Shared replay classifier (review rounds 2–3): `app.b039_dispatch_replay` (internal, no EXECUTE grant) is used by
   both `b039_dispatch_close_stale` and `b039_dispatch_no_channel`, so neither can close a claim that may already
   have reached the vendor as "never announced", nor queue an Email on top of a delivery:

   | Claim state | Result (no new Email in any row) |
   | --- | --- |
   | B-033 terminal fallback row | `fallback` with its reason |
   | reservation `settled` | `sent/replayed_settled` |
   | `expired`, unattempted, B-033 expiry Email already queued | `fallback/line_unknown_possible_duplicate` (Email delivered) |
   | `expired` otherwise (B-033 expiry always records `has_unknown`) | `uncertain/expired_after_unknown` |
   | open `reserved`(attempted)/`dispatching`(>15 s)/`unknown` | close_stale: reservation closed as `expired` **without** Email, LINE row `failed/line_unknown_suppressed`, `uncertain/stale_after_unknown`, quota kept counted; no_channel: `wait` (B-033 expiry owns its single possible-duplicate Email), backed off |
   | `dispatching` within 15 s | `busy`, backed off |
   | never started (no row, released without fallback, unattempted reservation released) | close_stale: `superseded/stale_authority`; no_channel: exactly one `line_unavailable` Email |

   `uncertain` counts as announced: a following cancel still goes out and a following reschedule keeps the
   "updated" wording. Other `dispatchLinePush` callers are unchanged. If B-033 expiry already queued its single
   possible-duplicate Email before the dispatch worker saw a revoke (expired claim), no further Email is added.
   Authorize errors: a throwing hook sets `authorizeFailed` and `dispatchLinePush` returns `unknown` without the
   generic `line_guard` Email; the worker backs the row off (`attempts`, `next_attempt_at`, ≤300 s exponential).
   Any per-row exception is caught, logged as a sanitized SQLSTATE and backed off, so one row never blocks the queue.
   LINE unavailable for the claim — no selected OA, **or** the claim's B-033 reservation/fallback rows belong to a
   different OA than the one now selected (review round 4: B-033 would reject the claim scope and the event would
   otherwise be re-polled forever) — takes the channel-independent path: the same recheck, `close_stale` if stale,
   otherwise `app.b039_dispatch_no_channel` with the replay classifier, which queues exactly one Email (reason
   `line_unavailable`, hub §6 error vocabulary) only for a never-started claim. Dependent reschedules/cancels then
   proceed on the new OA (or fall back to Email under the shared policy). `quota.ts` is unchanged.
   Every `unknown` or `busy` dispatch outcome is backed off (same claim, retry key and reservation when due).
   Revoke between the decision commit and the provider call (accepted residual risk): the push may still go out,
   but the link is rechecked by B-035 on open and the cancellation is sent once the announcement is `sent`.
4. Outcome → `app.b039_dispatch_finish`: accepted ⇒ `sent`; fallback with Email claim ⇒ `fallback` + reason;
   superseded ⇒ `superseded`; unknown/busy/disabled/fallback_unavailable ⇒ stays pending (next run reuses the same
   claim, retry key and reservation; B-033 expiry yields exactly one `line_unknown_possible_duplicate` Email).
   An event that turns stale after an unknown attempt is closed through the replay classifier above (`uncertain`,
   no Email), never superseded. A worker that first runs after the
   five-minute notification SLA follows the existing B-033 expired path (Email, no LINE attempt).

## Data — `supabase/migrations/20261107105000_b039_line_dispatch_pushes.sql` (additive)

- `platform_settings.line_dispatch_push` default `{"enabled":false,"allowed_org_ids":[]}`.
- `notifications_b039_vendor_dispatch_ck` (NOT VALID + VALIDATE): the hub event types `dispatch_assigned|rescheduled|cancelled` require no lease,
  a recipient contact and `related_table='repair_vendor_jobs'` with an id. Tenant-lease constraints are untouched.
- Private `app.b039_dispatch_events` (notification PK, org, ticket, job, vendor contact, kind, `depends_on`, unique claim,
  status `pending|sent|fallback|superseded`, sanitized reason, `attempts`/`next_attempt_at`, timestamps; one assigned/rescheduled and one
  cancelled per job). RLS enabled, `REVOKE ALL` from PUBLIC/anon/authenticated/service_role, `SELECT` to service_role.
- `SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp` service-only functions:
  `b039_dispatch_push_enabled`, `b039_dispatch_event_record`, `b039_dispatch_finish`, `b039_dispatch_backoff`,
  `b039_dispatch_no_channel`, `b039_dispatch_close_stale`; internal `b039_dispatch_replay` has no EXECUTE grant.
  Active-org GUC mismatch fails closed.

### L2 architect decision — schema beyond the hub's `_b039_line_dispatch_event_types.sql` (Class B review)

The hub proposed only an additive event-type constraint migration. This slice additionally adds, for Class B review
(the parent records it in BLOCKED; nothing is activated):

1. **Private outbox `app.b039_dispatch_events`.** The B-033 dispatcher needs a durable per-event claim id (its retry
   key and reservation key), an authority snapshot (ticket/job/vendor) to recheck at claim time, the announcement
   dependency and backoff state. `notifications` has no claim column and tenant/portal readers; private state there
   would widen exposure. RLS on, `REVOKE ALL`, service-role `SELECT` only; writes only through definers.
2. **Definer gateways** (`SECURITY DEFINER`, `search_path=pg_catalog,public,app,pg_temp`, service-only EXECUTE):
   `b039_dispatch_push_enabled` (strict flag stack), `b039_dispatch_event_record` (in-transaction producer),
   `b039_dispatch_finish` (claim-matched terminal outcome) — plus the review-fix helpers `b039_dispatch_backoff`
   and `b039_dispatch_no_channel`, `b039_dispatch_close_stale` and the internal `b039_dispatch_replay` (bounded retry;
   replay classification; deduplicated `line_unavailable` Email only for never-started claims).
3. **New platform flag `line_dispatch_push`** (default OFF, strict, registered in `ops/flags.yaml`), layered on
   `line_platform`/`line_push`/`notification_delivery_v2`/`line_vendor_portal` so dispatch pushes can be killed
   independently of tenant/owner pushes.

Rollback: flags OFF stop all reads/writes of these objects; the Down note in the migration drops them.

## Email fallback template rule

`vendorDispatchEmailTemplate` / `vendorDispatchEmailContent` pin the content a B-028 Email renderer must use for
`source_kind='line_notification'` dispatch notifications (the adapter is capture-only in this repo):

| Event (dependency) | Template key | Job link |
| --- | --- | --- |
| `dispatch_assigned` | `line_dispatch_assigned` | current `/v/<token>`, only while the job is open; otherwise suppressed |
| `dispatch_rescheduled` (previous announcement sent/fallback/uncertain) | `line_dispatch_rescheduled` | new job link, only while open; otherwise suppressed |
| `dispatch_rescheduled` (previous announcement superseded) | `line_dispatch_assigned` (first notice) | new job link, only while open |
| `dispatch_cancelled` | `line_dispatch_cancelled` | never |

Wording and locale (contact locale, zh-TW default) are identical to the LINE message. Email goes only to the
verified address B-028 resolves; it is never sent for a superseded or uncertain-closed event.

## Webhook under full quota

Unchanged B-033 contract: message/postback replies use only the event `replyToken` through `transport.reply`; the
webhook handler receives no push capability. Tests fill the channel counter and assert a reply, zero push calls and
no reservation/fallback/delivery writes.

## Copy

New zh-TW/en keys `line_dispatch_assigned|rescheduled|cancelled`. 屋主 (never 房東); no 收款/收租/入帳/已收; no 統一編號.

## Acceptance mapping (`src/server/b039-line-dispatch-pushes.integration.test.ts`)

| Hub Given/When/Then | Regression |
| --- | --- |
| Assignment change + claim ⇒ current vendor and job authority checked | re-dispatch to another vendor, direct ticket reassignment, revoked and sharing-withdrawn jobs before claim ⇒ superseded, zero push/reservation/Email; new vendor alone receives its own job link |
| Revoked/reassigned job + old recipient opens link ⇒ denied | link taken from the captured push; after re-dispatch/revoke the B-035 entry proof, flow creation and an existing job claim read/report are 404 |
| Prior announcement not delivered ⇒ no confusing follow-up | share→revoke before claim closes the cancel silently; reschedule after a superseded announcement is sent with the assigned copy; pending announcement defers |
| Authorize error ⇒ no Email | synthetic 57014 in `open_vendor_job` (authorize path only): no LINE/Email/reservation, backed off, later row still sent, retried once due |
| Retries/quota-full/unfollow ⇒ shared policy | timeout then accepted reuses claim, retry key and reservation and settles once; quota-full ⇒ `line_quota` skipped + one Email; signed unfollow webhook ⇒ `line_guard` Email; provider failure ⇒ `line_failed`; replays add nothing |
| Full quota + message/postback ⇒ Reply API only | signed webhook with filled counter ⇒ reply with token, zero push, no counter/delivery/fallback writes |
| OFF ⇒ zero writes / unchanged dispatch | env, line_platform, line_push, line_vendor_portal, notification_delivery_v2, platform and org `line_dispatch_push` (missing/malformed) |
| Stale after possible delivery | timeout → revoke → worker → expiry: assigned `uncertain`, exactly one cancel, zero Email/possible-duplicate, uncertain quota counted; timeout → same-vendor re-dispatch keeps "updated" wording |
| Email template rule | per-event key/link matrix incl. reschedule-as-assigned; DB-backed open link, revoked ⇒ suppressed, cancel without link, foreign org ⇒ null |
| Replay classifier | expiry between decision and close ⇒ `uncertain`, cancel still sent, no extra Email; settled/fallback claims replay; no OA after a settled push ⇒ no Email, revoke still cancels by Email; no OA after an expired attempt ⇒ `uncertain`, only B-033's notice; open unknown ⇒ `wait` |
| OA switch | unknown on X → switch to Y → revoke: assigned `uncertain`, cancel delivered once (Email via shared policy), no possible-duplicate; without revoke: `wait` with backoff, then B-033's single notice and terminal `uncertain`; unattempted claim with expiry Email ⇒ `fallback` |
| Gaps and concurrency | no selected OA (never-started claim) ⇒ one `line_unavailable` Email; revoke in the commit→provider gap; concurrent workers ⇒ one push/settle; rolled-back business transaction ⇒ no event; archived vendor supersedes cancel; Taipei month boundary (`2026-11-30 16:00Z → 2026-12-01`, retry settles the reservation's original month while the current month is full) |
| Cross-org | foreign org/job/ticket record calls and active-org mismatch write nothing; foreign worker never claims; privilege catalog |

## Local three-portal rehearsal (`src/server/b039-three-portal-rehearsal.integration.test.ts`)

All LINE flags ON in a disposable clone only. Exported handlers drive J1 (bootstrap `/t/liff` `/v/liff` `/o/liff`,
tenant invite accept, owner and vendor bind, scope denials, list/unlink/global revoke), J3 (tenant rent push and owner
push through the captured transport; quota-full Email fallback captured by the B-028 Email worker) and J5 (dispatch →
share → vendor push → B-035 claim/read/report from the pushed link → reschedule/cancel pushes → old link denied),
asserting no 5xx and zero network. **Hosted staging rehearsal is pending** (activation, real devices, external delivery
evidence and combined-SHA CI/Playwright remain Ron/QA steps; nothing here activates a flag).

## Out of scope

Live LINE/Email providers, scheduler deployment, hosted/staging activation, production rollout, ticket `scheduled_on`
pushes, tenant/owner feature expansion, git operations and full `test:rls`.

## Local validation — review fix rounds 1–4 (2026-11-06 PT)

Fresh `condola_b039impl` (stub, every migration, `db:reset`), Node 20.20.2. typecheck PASS; lint PASS (0 errors,
16 existing warnings); copy:check 6/6; test:unit 1034/1034. Separately with `--test-concurrency=1`: B-039 dispatch
pushes 49/49 (round 4), rehearsal 5/5, B-035 48/48, B-033 foundation 94/94, B-027 inventory 28/28. Covered locally: month
boundary, OFF matrix, concurrency, authorize-error retry. Evidence (redacted payloads, OFF matrix, rehearsal summary):
`e2e/results/B-039/`. **Not run:** full `test:rls`, hosted staging rehearsal, real devices, external delivery,
provider month-end reconciliation, remote databases, deployment, git mutations. All flags remain default OFF.

## Local validation — initial (superseded)

Fresh `condola_b039impl` on `127.0.0.1:55432` (stub, every migration including B-039, `db:reset`), Node 20.20.2.
`npm run typecheck` PASS; `npm run lint` PASS (0 errors, 16 existing warnings); `npm run copy:check` 6/6;
`npm run test:unit` 1034/1034. Separately with `npx tsx --test --test-concurrency=1`: B-039 dispatch pushes 30/30,
B-039 three-portal rehearsal 5/5, B-035 vendor LIFF 48/48, B-033 foundation 94/94, B-027 denial inventory 28/28
(no regeneration needed). Zero failures/skips; `git diff --check` PASS. Both B-039 files stub `globalThis.fetch` to
throw and assert zero calls. Not run: full `test:rls`, hosted staging rehearsal, real devices, external delivery,
remote databases, deployment or git mutations. All flags remain default OFF.

# B-037 — Rent and payment-result LINE pushes (L2 design)

> Hub `20-build/specs/B-037.md`; hub `05-capabilities/line-tenant-slice-design.md` §8/§8.1; builds on
> B-033 (shared foundation, quota, Email fallback) and B-034 (tenant LIFF). Branch `feat/b-037-rent-payment-pushes`.

## Hard rules

- **Zero live LINE HTTP.** All pushes go through `dispatchLinePush` with the B-033 captured `LineTransport`.
  The LINE recipient address is a transient, injected trusted input (`LineRecipientResolver`) that is
  hash-checked by B-033 against the verified identity; it is never persisted, logged or rendered.
- **Default OFF.** New flag `line_rent_push`: platform setting `{"enabled":false,"allowed_org_ids":[]}` +
  strict `organizations.feature_flags.line_rent_push === true`, layered on `LINE_PLATFORM_ENABLED`,
  `line_platform`, `line_push` and B-028 `notification_delivery_v2` (`app.b033_push_enabled`). Any layer
  missing/malformed/OFF ⇒ the runner exits before writes (no notification, claim, reservation, delivery,
  fallback or audit rows) and existing B-010 / legacy reminders are unchanged.
- `LINE_PUSH_QUOTA_GUARD` stays fail-closed (B-033 `readLineConfig`); this slice adds no bypass.
- Events are limited to `rent_due`, `rent_overdue`, `payment_confirmed`, `payment_rejected`.
  `rent_manual` and `payment_reversed` are never pushed.

## Source events (committed only)

The producer is unchanged: B-010 `app.b010_source_events` rows written by `b010_schedule_rent`
(rent) and `b010_emit_payment_event` (payment results, inside the committed payment transition).
B-037 never changes payment decisions. The claim gateway refuses an event inserted by its own
transaction (`xmin` equals the current transaction id), and the runner reads only through a
separate service transaction, so uncommitted or rolled-back events are never claimed.
Rent events additionally require `rent_reminders_v2` and payment events `payment_results_v2` to
still be ON for the live org (B-010 remains the source owner; legacy reminders own it otherwise).

## Data — migration `20261107090000_b037_line_rent_pushes.sql` (additive)

- Seeds `line_rent_push` (disabled, empty allowlist, `ON CONFLICT DO NOTHING`); registered in `ops/flags.yaml`.
- Private `app.b037_rent_push_claims`: `claim_id` (the stable B-033 claim / `X-Line-Retry-Key`), org, event,
  kind, `version` (=1, message contract), recipient contact, `reminder_offset`, lease, notification,
  `state` (`claimed|suppressed|sent|fallback`) and reason. UNIQUE `(org, event, version, recipient, offset)`
  ⇒ exactly one claim per occurrence/recipient; the `notifications.dedupe_key`
  `b037:<event>:v1:<contact>:<offset>` gives the same guarantee for the business row. Composite FKs pin every
  reference to the same org. RLS enabled, `REVOKE ALL` from PUBLIC/anon/authenticated/service_role; only
  definer gateways touch it.
- Claims also record `email_owner` (`b010_claim` | `line_fallback`) and `email_claim_id` for a fallback.
- Private `app.b037_event_marks(org, event, reason)`: an event that yielded no claim (ineligible or no eligible
  recipient) is evaluated once and skipped by discovery afterwards (no repeated `FOR UPDATE`, no starvation).
- Gateways (SECURITY DEFINER, `SET search_path=pg_catalog,public,app,pg_temp`, `lock_timeout 2s`,
  EXECUTE for `service_role` only): `b037_enabled`, `b037_pending(instant, limit)`, `b037_open`, `b037_claim`,
  `b037_prepare`, `b037_push_fallback`, `b037_mark`; private helpers without grants: `b037_event_reason`,
  `b037_recipient_reason`, `b037_email_owner`. `app.b033_push_expire` is replaced (same body and grants) to apply
  the B-037 single-Email and suppression rules below.

### Scope beyond the spec's migration (L2 architect decision, for Class B review)

Hub B-037 proposes a migration only for additive event constraints. That is insufficient here: (1) the hub
§8 requires one claim per (event, version, recipient, offset) plus a durable retry identity, which needs a
private claim table; (2) recheck-at-dispatch, single-Email ownership and forgery-proof terminal state must run
under the same locks as B-010 (lease → invoice `FOR UPDATE`), which only definer gateways on the private
B-010/B-033 tables can do; (3) a flag seed is required for `line_rent_push`; (4) the evaluated-event marker
prevents discovery starvation. The table + marker and the SECURITY DEFINER gateways (7 granted to
`service_role`, 4 ungranted helpers incl. `b037_resolve`, one same-body replacement of `b033_push_expire`) are therefore an L2
decision recorded here for Class B review; `write-pr-migrations.mjs` marks the file `addOnly: false`.

## Claim (business transaction after commit)

`app.b037_claim(org, event, instant)`: flags → lock lease `FOR SHARE` and invoice `FOR UPDATE` (rent;
same order as B-010, closing the BLK-MAC-11 legacy race: an uncommitted legacy `email_log` claim holds
`FOR KEY SHARE`, so the claim waits and then observes it) or payment `FOR SHARE` → event advisory lock →
eligibility → recipients → `notifications` (org, recipient, lease context, dedupe key) and claim rows in
the same transaction. Recipients mirror B-010 tenant rules: active, unarchived tenant contacts on the lease
(`primary`/`co_tenant`); `rent_due` honours the tenant due preference; tenant `rent_overdue` only at day 1
and when `email_tenant_rent_overdue` is not disabled; payment results go to the payer contact when present.

## Reminder and recipient eligibility (claim and again at dispatch)

`b037_event_reason` returns `eligible` or a suppression reason: `source_disabled`, `terminated` (lease not
active / terminated), `paid` (invoice not open/partially paid or zero balance), `timezone` (invalid org
timezone), `stale_day` (instant's company-local date ≠ event local date, or due date moved),
`legacy_owner` (legacy `email_log` overdue row for the same invoice/threshold), `payment_changed`.
`b037_recipient_reason` adds `recipient_lease` (no longer a tenant party / archived / due reminder off).
`b037_prepare` rechecks both under the same locks immediately before dispatch. A retry is a dispatch: any
ineligible claim becomes `suppressed` (notification `cancelled`) with no LINE call and no Email, including one
that holds a reservation after a timeout. Such a reservation is moved `unknown → expired` with its quota kept
(never settled or released), its LINE delivery records `line_unknown_suppressed`, and expiry never sends a
`line_unknown_possible_duplicate` Email for it. An actively dispatching owner is left to the same expiry rule.

## Dispatch (B-033 §8 eligibility and quota)

`runLineRentPushes(at, transport, resolveRecipient, env)` = claim pending committed events, then dispatch each
`claimed` row. `b037_prepare` classifies the recipient link: none ⇒ `line_unlinked`; not friend ⇒
`line_unfollowed`; no explicit opt-in ⇒ `line_opt_out`. These go straight to `app.b037_push_fallback` (same
signature and serialization as `b033_push_fallback`) with the precise reason; `dispatchLinePush` uses the same
gateway for quota/budget/guard/failure via its fixed `fallbackGateway: "b037"` option. Otherwise the
resolver supplies the transient address and `dispatchLinePush` applies B-033 eligibility (global + org flags,
active selected OA, verified tenant config + LIFF id, trusted unrevoked identity hash, linked, opt-in, friend,
contact persona) and the atomic reservation; guard not ready / ineligible ⇒ `line_guard`, counter full ⇒
`line_quota`, org budget ⇒ `line_budget`, all with deduped Email fallback. Timeout/unknown leaves the claim
`claimed`; the next run reuses the same claim id, therefore the same `X-Line-Retry-Key` and reservation
(`attempt_count` ≤ 3, 5-minute SLA, expiry ⇒ one `line_unknown_possible_duplicate` Email). Concurrent
dispatchers get `busy` from B-033 ownership. `b037_mark` records `sent` only when the reservation is `settled`,
and `fallback` only when B-033 holds a terminal fallback/expiry, so claim state cannot be forged.

## Message (zh-TW + en)

Only the necessary reminder (company, amount, due date) plus `https://liff.line.me/<tenant LIFF id>?org=<org>`.
No invite/flow/session tokens, contact/claim ids or payment reasons. Opening it goes through B-034 `/t/liff`
login and the tenant portal guards, which recheck bill/lease permission. Copy rules: 屋主 never 房東; never
收款/收租/入帳/已收 (uses 繳款/應繳/對帳/匯款); no 統一編號; Condola is not presented as processing payments.

## Status display

`lineRentPushStatus` maps provider acceptance (`deliveries.status='sent'`) to `sent` / 「已送出」/"Sent".
`delivered`/`read` are never produced or displayed; fallback shows the Email reason.

## Single ownership with legacy reminders

Legacy `reminders.ts` writes `email_log` (`rent_overdue_tenant` threshold 1, `rent_overdue_admin` 1/7) and is
already fenced (`b010_fence_legacy_reminders`, BLK-MAC-11) whenever `rent_reminders_v2` is ON. B-037 consumes
only B-010 events (which exist only on the new path) and additionally refuses/suppresses an occurrence for which
a legacy `email_log` row exists, under the invoice lock. So any one occurrence is owned by exactly one path.
**Single Email per recipient per occurrence.** B-010 `b010_schedule_rent` already creates the tenant's Email
claim in `app.b028_recipient_claims` (unchanged rule, hub §8 既定必寄 Email 維持原規則). When that claim exists for
(event, contact), `b037_push_fallback` records the terminal skipped LINE delivery with its reason, stores the
B-010 claim id in `b033_push_fallbacks.email_claim_id` / `email_claim_id` (`email_owner='b010_claim'`), and
creates no new Email; the replaced `b033_push_expire` does the same for unknown results. Only when no B-010
Email claim exists (payment results) does it delegate to `b033_push_fallback`, which queues exactly one
deduplicated B-028 `line_notification` Email (`email_owner='line_fallback'`).

## Discovery cursor

Rent events are discovered on their company-local day. Payment results use a bounded 7-day look-back (claims
and evaluated marks are the cursor), so a missed run is caught up; older results are not pushed. Discovery is
ordered by event time and limited (default 200, test-only smaller limits).

## Acceptance → tests (`src/server/b037-line-rent-pushes.integration.test.ts`)

| Given / When / Then | Evidence |
| --- | --- |
| Unpaid eligible lease / scheduled event commits / one recipient-version-offset claim | Real `b010_schedule_rent` commit, uncommitted event invisible, own-transaction refusal, concurrent claimers ⇒ one claim/notification, captured push and payload checks. |
| Paid / terminated lease / reevaluated / suppressed | Paid and terminated between claim and dispatch, company-timezone day change, recipient removed; zero transport calls and no Email. |
| Unlinked / unfollowed / quota-full / guard-unavailable / deduped Email with reason | `line_unlinked`, `line_unfollowed`, `line_opt_out`, `line_quota` (179/180/181), `line_guard`; ALL Emails per recipient per event across B-010 + fallback = 1 (with and without a B-010 claim, and after unknown-result expiry). |
| Timeout / retried / same retry key + reservation | Timeout then accepted/duplicateAccepted; same `X-Line-Retry-Key`, one reservation, counter 1; concurrent retry ⇒ `busy`; held retry that became paid/terminated/recipient-removed ⇒ suppressed, no push/Email, quota kept. |
| Starvation / look-back | 5 ineligible events ahead of an eligible one with limit 2 ⇒ eligible sent on run 3; 3-day-old payment result caught up, 8-day-old skipped. |
| Provider acceptance / displayed / sent not delivered/read | `deliveries.status='sent'`, label 已送出 / Sent, no delivered/read. |
| OFF matrix, cross-org, legacy overlap, zero network | Snapshots for each flag layer; ORG2 untouched and pinned-org denial; legacy `email_log` overlap and in-flight legacy race; `globalThis.fetch` throws. |

## Out of scope / open items

No real transport, LINE address vault, scheduler/cron wiring, UI surface, deployment or flag activation.
Open: production `LineRecipientResolver`; a dispatch already in flight when the occurrence becomes paid may
still complete (TOCTOU between recheck and provider call). Independent QA and commits remain with the architect.
Evidence: `e2e/results/B-037/`.

## Local validation (2026-11-06 PT, Node 20.20.2 / npm 10.8.2)

Fresh `condola_b037impl` on `127.0.0.1:55432` (stub, every migration including this one, then `db:reset`).
`typecheck` PASS; `lint` PASS (0 errors, 16 existing warnings); `copy:check` 6/6; `test:unit` 1035/1035.
Separate `--test-concurrency=1` runs: B-037 33/33, B-033 foundation 94/94, B-034 tenant LIFF 41/41,
reminder foundation 11/11, B-028 delivery claims 21/21, B-027 denial inventory 28/28 (no regeneration needed).
Zero failures/skips; `git diff --check` PASS. Quota boundaries 179/180/181 are covered. `globalThis.fetch` is
stubbed to throw and asserted unused. Initial B-037 run was 20/30: pg `date` decoding in the message renderer
(gateway now returns text), a generated `balance_minor` column in test setup, and an over-broad test regex;
all fixed. No live LINE HTTP, remote DB, deployment, full `test:rls`, git mutation or flag activation.

## Review fix round 1 (2026-11-06 PT)

Independent review FAIL addressed in place (unpushed migration edited): single Email per recipient/occurrence
(`b037_push_fallback`, `b033_push_expire` replacement); held retries suppressed with quota kept and no Email;
evaluated-event marks + limit/ordering against starvation; 7-day payment look-back; BigInt-only amounts;
scope rationale above; evidence in `e2e/results/B-037/`. Initial rerun was 43/44: the new marks table was
missing from the seed wipe list (fixed). Final: typecheck PASS; lint 0 errors (16 existing warnings);
copy:check 6/6; test:unit 1035/1035; B-037 44/44, B-033 foundation 94/94, B-034 41/41, reminder-foundation
11/11, B-028 21/21, B-027 28/28 (no inventory regeneration); `git diff --check` PASS.

## Review fix round 2 (2026-11-06 PT)

- `b037_open(instant, limit)` orders least-recently-attempted first (`attempted_at NULLS FIRST, created_at,
  org_id, claim_id`); `b037_prepare` stamps `attempted_at`, so stuck/retrying claims in one org cannot starve
  another org (test: 3 stuck claims in org A, limit 2, org B sent on run 2).
- No usable OA (`b033_selected_channel` NULL, no reservation) is terminal `line_unavailable`: a B-010-owned
  recipient keeps its existing Email claim (skipped LINE delivery only); otherwise exactly one B-028 Email
  fallback is queued with the reason (no channel row). A reservation-held claim keeps its original channel.
- `b037_push_fallback` reads the claim `FOR SHARE NOWAIT` first: suppressed ⇒ returns `suppressed` and writes
  nothing (an in-flight worker failing after a concurrent suppression sends no Email); a held lock ⇒ `busy`.
- New ungranted helper `app.b037_resolve` (shared by prepare and mark) resolves settled reservations and
  terminal fallbacks/expiry before any eligibility recheck, so a crash between a B-033 commit and mark
  reports the real outcome (sent / Email fallback), never 未送出.
Tests 44 → 50; the granted gateway count is unchanged (7) and ungranted helpers are now 4.

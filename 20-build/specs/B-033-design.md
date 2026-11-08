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

## Slice 2 — local implementation: login, one-time flows and atomic linking

Migration: `20261107050000_b033_line_login_link.sql`. This adds flow scope/browser/CSRF/PKCE/verification
columns, private session provenance, explicit step-up evidence and admission counters, link persona, three default-OFF platform settings,
and service-only gateways. No legacy identity backfill; the slice-1 migration is unchanged. Existing LIFF fields
are retained, with direct client/service-role changes rejected by `b033_liff_config_guard` and controlled changes
through `app.b033_liff_configure(uuid,text,text,text)`. Changes invalidate slice-1 configuration verification.

### Identity, flows and transactions

- ID tokens are verified **locally with HS256**, never discovery/JWKS or provider HTTP: pinned algorithm, exact
  issuer `https://access.line.me`, Login channel audience, integer exp/iat (30-second skew), optional nbf, and
  OAuth nonce. The lazy slice-1 resolver loads the Login secret by reference. Only the verified `sub` enters
  the provider-scoped keyed hash; name/email/legacy `contacts.line_user_id` grant no authority.
- Five-minute opaque flows store hashes of handles, browser proof, CSRF, OAuth state/nonce and PKCE verifier.
  Browser cookies are Secure, SameSite=Lax, Path=/; browser proof is HttpOnly. LIFF uses same-origin CSRF and
  browser proof, not an assumed SDK nonce. OAuth binds state, PKCE and nonce; local code exchange is injected.
  Only exact portal return paths are accepted. Private headers apply on success and failure.
- Admission counters persist outside failed business transactions, gated before writes; five exchanges per
  flow/invite, account and browser/org budgets, and the existing invitation/password lockout checks apply.
  No identity/session/link is committed on invalid proof, credentials, expiry or conflict. Failed admission
  can increment a private counter; it does not consume the invitation.
- Acceptance locks invitation -> flow -> account/contact -> identity/link, rechecks current scope and expiry,
  uses existing `provisionAcceptedLogin`, accepts the invitation, writes masked audit, creates an
  existing Condola session and consumes the flow in one transaction. Late session faults roll back provisioning,
  invitation status, identity and link together. LINE binding consent never records terms/privacy acceptance. `app.b033_link(uuid,text,uuid,text)` independently
  rechecks scope and serializes the channel/provider hash. Two connections cannot accept one invitation twice.
- Existing accounts require Condola password and configured/required 2FA; another logged-in account is rejected.
  New accounts require an existing pinned invitation email and an acceptable password, following current portal
  provisioning. An arbitrary collected email or LINE email claim is insufficient; email-less invitations must
  use the existing recovery/verification path before LINE linking. No GoTrue tokens are fabricated.
- Password/MFA step-up is explicit: `POST /api/line/reauth` verifies the current session's password and actual
  TOTP when configured or required (no demo-code bypass), then records private `app.b033_line_stepups` evidence.
  Evidence is bound to the exact session, expires after 10 minutes, and fingerprints the current password/MFA
  configuration. Bind creation/completion, self-unlink and global revoke require that record; signup/confirmation
  session age or absent LINE provenance never qualifies. New MFA policy/enrollment, password changes and session
  revocation invalidate insufficient evidence. Failed password attempts consume a durable account budget.
- Legal consent is independent of `line.binding.v1`. Invite acceptance and LINE login read the latest existing
  consent row without writing legal acceptance or metadata. Missing/stale consent redirects to the existing
  `/consent/portal?next=...` (tenant/owner) or `/consent?next=...` (vendor); current evidence proceeds unchanged.
- Session insertion is factored into transaction-aware `createSessionOn`; ordinary `createSession` retains its
  audit behavior. LINE sessions have private provenance for revocation. A valid same-user browser session is
  reused across LIFF and invite/QR entry; separate browser cookie jars still require separate authentication.
  Unknown LINE-first identities return `account_required`, with no account/session/link creation.

### Portal scope, routes and configuration

Invitation kind fixes tenant/owner persona and scope regardless of client hints. Bind requests must match the
contact's actual role and authenticated user. Vendor linking requires an already-established B-026 vendor account;
it creates no job assignment. Push eligibility uses the link's persona and `app.b033_contact_user`, the same
authoritative account mapping used by binding: B-026 for vendors (including contacts with NULL `user_id`),
contact ownership for tenants/owners. A provider identity can therefore serve multiple link personas without
its first-binding `identity.persona` restricting later links. Requests must match the link persona, and removed,
reassigned or disabled account mappings fail closed. Existing slice-1 trusted links without a link persona retain
their original contact-user/identity-persona checks; no legacy identifier becomes identity proof.
Vendor login returns `/vendor-account` (the existing authenticated account entry);
`/v` is rejected, while `/v/liff` remains the bootstrap route. Owner linking creates no property authorization. B-035 job scope and B-036 property
scope remain with their existing guards and future slices. The original invitations table has tenant/owner kinds;
this migration does not introduce vendor invitation provisioning or reuse vendor job tokens as identity proof.

Every API requires global `LINE_PLATFORM_ENABLED`, platform/org `line_platform` and the applicable platform/org
`line_{tenant,vendor,owner}_portal` flags. Default/missing/malformed/OFF gives 404 with zero database writes.
Bootstrap OFF is the specified exception: 200 existing Email login entry, no flow/cookie/database writes.

| Route | Local behavior |
|---|---|
| GET `/t/liff`, `/v/liff`, `/o/liff` | Public route-group bootstrap outside protected layouts; existing localized login copy; reads verified persona LIFF config. |
| POST `/api/line/flows` | 201 opaque flow, expiresAt and portal liffUrl; invitation-derived scope or explicit recent step-up/contact validation. |
| GET `/api/line/login/start` | 302 authorization URL with state/nonce/S256 PKCE; browser-bound cookies. Constructing the URL sends no HTTP. |
| GET `/api/line/login/callback` | Local injected code exchange, state/PKCE/nonce verification; 303 internal portal/confirmation, session only for authorized identity. |
| POST `/api/line/session` | Verified token plus browser flow; existing cookie session or `account_required`; one-time login consumption. |
| POST `/api/line/reauth` | Explicit password plus required TOTP; session-bound 10-minute evidence, portal gates, browser/CSRF and durable admission. |
| POST `/api/line/bind` | Explicit recent password/MFA step-up record, verified flow and explicit `line.binding.v1` consent; returns linked linkId. |
| POST `/api/line/invites/accept` | Atomic existing invitation/account validation and linking; returns next/linkId and Condola session cookie. |
| GET `/api/line/links` | Authenticated identity owner's links, including history after account reassignment; per-link portal gates, no foreign identifiers. |
| DELETE `/api/line/links/[id]` | Explicit recent self step-up or same-org Admin/Manager; disables this link's notifications, preserves other links/history. |
| DELETE `/api/line/identity` | Explicit recent self password/MFA step-up and usable confirmed Email/password; revokes selected identity, its links and LINE sessions. |

Shared errors use the §6 codes: invalid_request, reauth_required, invalid_line_token, csrf, consent_required,
not_found, identity_conflict, already_consumed, account_mismatch, flow_expired, invite_expired, rate_limited,
line_unavailable. Foreign unlink authorization precedes channel-health evaluation to avoid configuration leakage.
Management endpoints also honor portal OFF. If multiple identities belong to a user, revoke requires identityId
rather than arbitrarily selecting one. Historical link deactivation after B-026 reassignment preserves the original
identity/org/contact/channel/persona and disables notifications; it does not require the deleted current mapping.
Listing likewise uses identity ownership rather than today's account mapping, so the user can discover the link
ID and then unlink it. Historical visibility never restores login, push, job or property authorization.
The SQL exception cannot insert, retarget or reactivate links, and the original service-only guard still applies.
Global revoke continues through historical links to invalidate all LINE-issued sessions. Reasons are limited to user_request/staff_request for masked audit.

`public/line-bootstrap.js` waits for SDK init before URL normalization, preserves an existing opaque invite flow
through login redirect, posts ID tokens only to same-origin session API, and never persists tokens in storage.
**Local-only boundary:** no SDK/CDN is downloaded; a reviewed host-provided `window.liff` adapter is required.
The shipped OAuth code exchanger returns 503 until a reviewed transport is supplied. Tests inject local exchanges
and mock the SDK; real LINE configuration, live login, device/WebView cookie acceptance and full invite-confirmation
UI are not claimed by this shared-service/bootstrap slice. Email remains available. No flags are activated.

### Slice 2 validation

Fresh `condola_b033s2impl` at `127.0.0.1:55432`: stub, every migration, then seeded locally. Test processes block
external sockets/HTTP; integration files run separately with `--test-concurrency=1`, using disposable clones where
implemented. Coverage includes invalid JWT/state/nonce/PKCE/browser proof; invite/flow expiry and replay; existing
password/2FA; late-fault rollback; same-flow and separate-flow concurrent accept; provider/account conflict;
LIFF/invite session reuse; authorized mocked callback; bind/unlink/revoke and recovery denial; foreign/cross-org
404; all three portals' OFF matrices; private headers/Origin/CSRF; service-only privilege catalog and verification
stamp invalidation. Browser-adapter unit tests cover redirect order/flow preservation and same-origin exchange.

Previous round results (superseded by QA round 2 below; 2026-11-06 PT, Node 20.20.2 / npm 10.8.2): typecheck PASS; lint PASS (0 errors,
16 existing warnings); copy:check 6/6; test:unit 1034/1034; B-033 login/link 56/56; B-033 foundation 94/94;
portal-invite 16/16; auth 18/18; signup 1/1. All test files have zero failures/skips; `git diff --check` PASS.
Logs: `/private/tmp/b033s2-{typecheck-final,lint-final,copy-final,unit-final,login-final,foundation,portal,auth,signup}.log`;
fresh-database setup: `/private/tmp/b033s2-db-build.log`. The continuation preserved earlier changes and added
regressions for separate-flow invitation races, provider-account conflicts, foreign unhealthy-channel denial,
authorized callback replay, all-mutation CSRF/Origin denial, and LIFF redirect context preservation.
Independent Claude QA, git commit and any release remain with the architect. Full `test:rls`, remote databases,
deployment, git mutations and live LINE calls were not run. All flags remain default OFF.

### QA fix round 2 (2026-11-06 PT)

All four MAJOR findings are addressed locally: explicit password/MFA step-up evidence, independent legal consent
flow, historical vendor-link deactivation/revocation, and the real `/vendor-account` landing route. Regression tests
exercise fresh confirmation-style sessions, missing/incorrect MFA, expired/changed evidence, missing/stale/current
consent and newly provisioned users, real B-026 staff reassignment followed by self/staff unlink and global revoke,
and the actual vendor account API's session, consent and job-scope checks. No flag-OFF product text or legacy
entrypoint/query path was edited. The new reauth endpoint has its own OFF/CSRF/admission regressions.

Final local validation (Node 20.20.2 / npm 10.8.2): typecheck PASS; lint PASS (0 errors, 16 existing warnings);
copy:check 6/6; test:unit 1034/1034; login/link 73/73; foundation 94/94; portal-invite 16/16; auth 18/18.
Every integration file ran separately with `--test-concurrency=1`, on the fresh local migration/seed database
(or its isolated disposable clone). All final tests have zero failures/skips; `git diff --check` PASS.
Evidence: `/private/tmp/b033s2-r2-{db,typecheck-final,lint-final,copy-final,unit-final,login-complete,foundation,portal,auth}.log`.
The initial unit failure was the new auth endpoint's missing consent-entrypoint classification (fixed). Initial regression fixture failures were
append-only consent seed removal and missing B-026 staff JWT context (fixed only in disposable test setup).
Independent Claude re-review and the sole git commit remain with the architect. No live LINE HTTP, external
network calls, remote DB access, deployment, full `test:rls`, or git mutations were performed.

### QA fix round 3 (2026-11-06 PT)

MAJOR: `src/server/line/quota.ts` now resolves slice-2 eligibility through the link persona and the existing
`app.b033_contact_user` helper. The uncommitted migration already defines the correct authoritative mapping;
no migration change or backfill is needed. Five bind-to-captured-dispatch regressions cover a vendor with NULL
contact user, shared tenant/vendor identity in both binding orders, rejection of the identity's original persona
on a different-persona link, and rejection after real B-026 reassignment even with a stale matching contact user.

MINOR: `listLineLinks` retains authenticated identity ownership and portal gates while removing the current
contact-mapping restriction. The regression lists a reassigned vendor's historical link, confirms portal-OFF
denial and foreign-user isolation, unlinks using the returned ID, and reads the disabled historical record
without restoring any B-026 account mapping. Product copy, OFF responses and OFF query call order are unchanged;
the fixes change predicates inside existing SELECTs and add no queries.

Validation on a freshly recreated local `condola_b033s2impl` (stub, every migration, then seed), Node 20.20.2 /
npm 10.8.2: typecheck PASS; lint PASS (0 errors, 16 existing warnings); copy:check 6/6; test:unit 1034/1034;
login/link 79/79; foundation 94/94. Integration files ran separately with `--test-concurrency=1`, each using its
own disposable clone. All final tests have zero failures/skips; `git diff --check` PASS. A local-only socket guard
was loaded in all Node validation processes; transports were captured locally, with no live LINE HTTP.

Evidence: `/private/tmp/b033s2-r3-{db,typecheck-final,lint-final,copy,unit,login-final,foundation}.log`.
The initial typecheck exposed a widened test persona literal (fixed). The initial login/link run was 77/79:
one fixture violated the existing tenant-user unique constraint; another expected 404 rather than the existing
empty-list response for an unrelated authenticated user. Both test setup/assertion issues were corrected;
the rerun passed 79/79. Initial logs remain at `b033s2-r3-typecheck.log` and `b033s2-r3-login.log` in the same directory.
Independent Claude re-review and the sole git commit remain with the architect. Full `test:rls`, remote DBs,
deployment, external network calls and git mutations were not performed; no flags were activated.

## Reserve preserved — PROP-US-v03-02 (Ron 2026-11-05 19:04 PT)

Unit-QR binding (CAP-M-34) must reuse B-033's provider-scoped identity, atomic invite/link service and three LIFF entries;
QR context tokens must not conflict with the one-time flow's audience/issuer/expiry/state/nonce checks; no duplicate
identities/sessions between the LINE entry and the unit-QR signup path; the QR extension never changes the quota guard
(180/month, `Asia/Taipei` key) or webhook idempotency invariants. Merged rows (B-002/B-003/B-007/B-011/PROP-01b/PROP-10/
PROP-11/B-013) are not reopened.

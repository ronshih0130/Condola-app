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
4. `public.line_push_usage` exactly per slice design §8.1 (PK channel+period_month, Asia/Taipei month key, RLS on, no
   client grants, service_role only) + `app.b033_push_reservations(id, claim_id, line_channel_id, period_month,
   status reserved|settled|released|unknown)`.
5. Service-only SECURITY DEFINER gateways (`search_path` pinned): `b033_line_enabled(org)`,
   `b033_push_reserve(channel, claim, limit=180)` (single atomic UPDATE per §8.1; month key from `now()`), `b033_push_settle`
   (accepted ⇒ reserved−1, pushed+1, once per claim), `b033_push_release` (explicit unaccepted failure only),
   `b033_push_unknown` (keeps reservation), `b033_quota_alert_once` (UPDATE … WHERE alert_sent_at IS NULL RETURNING),
   `b033_webhook_record(channel, event_id, type, ts)` (dedupe + monotonic friendship), `b033_identity_*` helpers.
6. TS: `src/server/line/transport.ts` (interface + captured mock: records push/reply calls, configurable
   accepted/failed/timeout), `src/server/line/webhook.ts` (HMAC-SHA256 `x-line-signature` over the raw body with the
   channel secret resolved by ref; reject before parsing; reply only via Reply API; expired reply token never pushes),
   `src/server/line/quota.ts` (reserve → transport → settle/release/unknown; on no reservation ⇒ skipped `line_quota`
   + deduped Email fallback through the B-028 delivery claims `enqueueDelivery(..., channel:"email")`),
   route `src/app/api/line/webhook/route.ts` (flag-gated 404 when OFF).

Acceptance covered in slice 1 (hub B-033): webhook duplicate/out-of-order idempotency; Reply-only; quota 179-used
concurrent reservation grants exactly one, 180/181 blocked; missing/disabled/invalid guard or unavailable counter ⇒ no
push + Email fallback; `2026-11-30T16:00:00Z` month boundary (key `2026-12-01`); cross-month settlement updates the
original key; alert once per channel/month.

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

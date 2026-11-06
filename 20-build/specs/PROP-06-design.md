# PROP-06 — JIT L2 設計稿：通知＋三端 LINE 入口基礎（L1-NOTI）

> Author: Claude (Mac overnight, 2026-11-06 PT). L1 foundation per hub `10-product/step4-architecture/architecture-v0.md` §8 (L1-NOTI; deps L1-ID/L1-ORG done) for B-028 and B-033..B-039. No new flag, no writes, no callers. Branch cut from #36 (`d374bb6`).

## Done means

Delivery code has one trusted answer to "how can I reach this contact **as this persona**, and which portal do they enter?": the caller passes the event's persona (tenant / owner / vendor — contacts can hold several roles) and gets that portal only if the contact holds the role, whether e-mail, in-app (portal user) and LINE are usable — LINE only on the organization's **selected OA** (its active `organizations.line_channel_id` — own org_owned OA or the platform default — else the active platform default) when the contact has a **live link** on that channel (`status='linked'`, user id, not unlinked) **and** is still a friend of the OA — plus the web and reserved LIFF entry per portal (`/t|/o|/v` and `/t/liff|/o/liff|/v/liff`). It never returns addresses, phone numbers or LINE user ids.

## Design

- Migration `20261106120000_prop06_recipient_channels.sql`: `app.prop06_recipient_channels(org, contact)` SECURITY DEFINER (`search_path = pg_catalog, public, app`), EXECUTE to `authenticated` only, requires an exact `app.active_org_id`/`app.env` pin and `app.is_member(org)`; archived contacts return nothing.
- `src/server/recipient-channels-rules.ts` (pure): `planChannels` orders in_app → line → email, reports each requested-but-unusable channel with a reason (`no_portal`, `no_portal_user`, `not_bound`, `not_friend`, `no_email`); `PORTAL_ENTRY` constants.
- `src/server/recipient-channels.ts`: staff-only reader over the RPC.
- Quota guard (`LINE_PUSH_QUOTA_GUARD`) and binding flows stay in B-033..B-036.

## Verification

Unit `recipient-channels-rules.test.ts`; integration `prop06-recipient-channels.integration.test.ts` (booleans only, link lifecycle linked/not-friend/unlinked, pin + membership + cross-org denial, privileges).

## Not covered (explicit)

Token-only vendor recipients (job-token access without a principal user, e.g. B-028 vendor center recipients) are **not** modelled: they report `no_portal_user` for in-app. B-028/B-035 must plan those from the job context.

## Cross-review

Codex QA r1 FAIL: LINE accepted links on any channel; persona was guessed tenant-first → fixed (selected-OA resolution; explicit validated persona). LOWs: vendor token-only limitation documented; sandbox membership/isolation test added.

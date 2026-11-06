# B-020 — JIT L2 設計稿：租客帳號、登入裝置與資料請求（slice 1）

> Author: Claude (Mac overnight, 2026-11-06 PT). Layer-2 design for hub `20-build/specs/B-020.md` (CAP-T-13). Flag `tenant_account_settings` (TENANT_ACCOUNT_SETTINGS*) seeded OFF. Branch cut from #36 (`d374bb6`), independent (notification preferences reuse the existing `/t/reminders` B-010 preferences; B-028 integration comes later).

## Done means (slice 1)

With the flag ON for a local test org, a tenant opens `/t/account`, sees their own signed-in sessions and signs out another device — that session is immediately unusable (`session.ts` already rejects revoked sessions). The current session cannot be revoked there, and another user's session never can. A data request (export / correction / deletion) is one trackable row per kind while open; a retry returns the same row. Forged user/org identifiers are ignored: every RPC derives the user from `auth.uid()` and the organization from the exact org/env pin plus the caller's own active tenant contact. Flag OFF: `/t/account` 404s and every RPC refuses.

## Design

Migration `20261106140000_b020_tenant_account.sql`: flag seed OFF; private `app.b020_data_requests` (RLS on, REVOKE ALL; partial unique open request per (org, user, kind)); internal `app.b020_admit` (flag `IS NOT TRUE` ⇒ OFF, pin, tenant contact); RPCs `app.b020_my_sessions`, `app.b020_revoke_session(org, session, current)`, `app.b020_submit_data_request(org, request, kind)`, `app.b020_my_data_requests(org)` — all SECURITY DEFINER with pinned search_path, EXECUTE to `authenticated` only. Server `src/server/tenant-account.ts`, consent-guarded action, page `/t/account` with new non-legal copy (`src/i18n/tenant-account.ts`).

## Not in this slice (logged)

- **Data-request UI**: labels and explanations for export/correction/deletion are privacy wording; AGENTS.md forbids privacy/terms/consent text edits without approved copy → backend only; UI waits for approved copy (hub BLK-MAC-09).
- Profile edits and password change UI; optional-event preference evaluation beyond the existing reminder preferences (needs B-028).

## Cross-review (Codex QA)

r1 FAIL: reused open request did not bind the new request id → fixed with private `app.b020_request_ids` (every accepted id bound inside the locked transaction); LOW concurrency test added → **r2 PASS**.

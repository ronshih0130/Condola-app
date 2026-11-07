# B-023 — JIT L2 設計稿（slice 1）：屋主文件中心與報修進度

> Author: Claude FALLBACK-SUBAGENT implementer (Codex unavailable), 2026-11-06 PT. Layer-2 design for hub `20-build/specs/B-023.md`, slice 1 only. Base `feat/b-012-durable-replacement` @ 74de464. Flag `owner_portal_extensions` (default OFF).

## 使用者故事／能力 ID

- Covered (slice 1): OWN-05 / CAP-O-09 document center (authorized lease documents only; current vs replaced versions distinguishable; opening is not consent); CAP-O-11 repair visibility (only repairs on the owner's own authorized properties, read-only progress).
- Later slices (not built here): CAP-O-10 / OWN-07–09 lifecycle replies (renewal intent, move-out arrangement, settlement replies — owner, tenant and company responses kept separate); CAP-O-11 company messaging (owner ↔ company threads); profile / security / sessions (recent-auth controls, reuse B-020 session patterns); notification preferences (reuse B-028 / tenant preference services); e-sign executed documents and management-agreement files in the document center; owner-safe repair photos.

## Done means

With `owner_portal_extensions` ON for a local test org, an owner opens `/o/files` and sees only paper-signed lease PDFs for leases on properties where they hold (current) or held (history) authority, each marked 現行版本／已被取代的版本 and, for ended authority, 「授權期間已結束（僅顯示當時內容）」; opening or downloading one goes through `/o/files/<id>` and writes exactly one access row, with no consent/signature/confirmation change. `/o/repairs` and `/o/repairs/<id>` show status and status history of repairs on those properties, without descriptions, comment bodies, internal entries, people or costs. Flag OFF: the routes 404, no nav entries, zero B-023 writes, existing owner pages unchanged.

## 端到端 tracer bullets

1. **List documents**: `/o/files` → `ownerDocuments(session)` (TS strict flag check first; OFF ⇒ `null` ⇒ `notFound()`) → `app.b023_owner_documents(org)`: owner contact (`contacts.user_id = auth.uid() AND is_owner AND archived_at IS NULL`, exactly one, org/env pinned, not staff) → authority windows from `property_owners` → leases (`pending_signature|active|ended|terminated`) whose term overlaps a window → `lease_signed_pdfs` metadata. Read-only, no audit on list (same as tenant signed-PDF list).
2. **Open/download**: `/o/files/<id>[?view=1]` GET route (HEAD is explicit: 404 when OFF, otherwise 405, never opens or audits) → `requireCurrentConsent(api)` → `openOwnerDocument(session,id,kind,requestId)` (flag + live `auth_sessions` row) → `app.b023_open_owner_document(org,id,request,kind)`: flag (locked), owner contact, re-admission through `b023_owner_documents`, one append-only row in `app.b023_owner_document_access_events` (exact replay = no second row; reuse for another document = denied), bytes returned. Response `private, no-store`, `nosniff`, `Content-Security-Policy: sandbox`, `X-Frame-Options: DENY`, inline vs attachment.
3. **Repairs**: `/o/repairs` → `app.b023_owner_repairs(org)`; `/o/repairs/<id>` → `app.b023_owner_repair_detail(org,ticket)` with timeline = non-internal `ticket_comments` status entries (`from`, `to`, `at` only).

## Authority rule (reuses `property_owners`; no new model)

- Window = `[effective_from, effective_to)` — **exclusive end**; only windows started by the property-local today; empty windows ignored; overlapping windows merged (`range_agg`).
- Item span: lease `[start_date, least(end_date, terminated_on)]`; repair `[created local date, closing local date or open]`.
- In scope iff the span overlaps a window. `current` iff it overlaps the window containing today; otherwise `history`.
- Strict dating (all items, current and history): document versions and repair status entries are returned only when their property-local date lies **inside** one of the caller's merged windows (`windows @> local_date`) — never before the first window start, in a gap between windows (re-acquired ownership), or on/after a window end. A successor owner therefore does not see the predecessor's uploads or status entries, and a re-acquiring owner does not see the gap owner's. History repair status = last visible status entry (fallback `open`); current repair status = live ticket status.
- Another owner's period, another property, another org, staff logins, foreign ids ⇒ empty / 42501 ⇒ 404.
- Co-owners of the same property each see it (both hold authority).

## 資料表與 RLS (additive migration `20261107110000_b023_owner_portal_access.sql`)

- Seeds `platform_settings.owner_portal_extensions = {"enabled":false,"allowed_org_ids":[]}` ON CONFLICT DO NOTHING; `ops/flags.yaml` entry default false (same shape/expiry as other owner flags).
- `app.b023_owner_document_access_events(id, org_id, owner_contact_id, actor_user_id, source_kind='lease_signed_pdf', document_id, lease_id, property_id, access_kind view|download, access_basis current|history, request_id, created_at; UNIQUE(org_id,request_id))`, RLS on, REVOKE ALL from PUBLIC/anon/authenticated/service_role, UPDATE/DELETE/TRUNCATE triggers raise 55000.
- Functions `SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp`, all REVOKEd from PUBLIC/anon/authenticated/service_role; only `b023_owner_documents`, `b023_open_owner_document`, `b023_owner_repairs`, `b023_owner_repair_detail` are granted EXECUTE to `authenticated`. Helpers (`flag_on`, `flag_locked`, `owner_contact`, `owner_authority`, `owner_repair_scope`, `owner_repair_events`) are private.
- No existing table, column, policy or function is changed.

## 權限風險（Class B）

Permission / PII boundary. Review points: owner identity still trusts `contacts.user_id` (BLK-MAC-04; PROP-13 `#67` hardens binding and is not in this base); staff-as-owner rejected; repair fields minimized (no description, preferred times, comment bodies, internal entries, reporter/assignee/vendor, costs, photos); exclusive end date at property-local day; zero consent inference (test hashes consents, partner consents, lease signatures/events, e-sign signers/audit, thread participants, notifications, audit_log, deposit confirmations, B-022 replies, B-012 responses, B-013 decisions, B-028 reads/markers, B-010 confirmations, lease e-sign/sign state and PDFs before/after open).

## 驗證方式

`src/server/b023-owner-portal-access.integration.test.ts` (disposable PG clone): owner A (current P1, ended P3), owner B (P2), owner C (current P3 after A), owner D (org 2). Plus owner E (P5 2019 and again from 2023) and gap owner G (2020–2023). Asserts exact document/repair id sets per owner, gap-period / re-acquisition / successor clipping of uploads and status entries, HEAD 405/404 with no access row, document security headers, exclusive-end edge (upload at local 2022-01-01 hidden from A), draft lease excluded, version labels, history clipping of documents and repair timeline/status, field allowlists, cross-org/sandbox/staff/foreign-id/revoked-session denial with no access row, one row per view/download with exact replay, immutability, consent snapshot unchanged, private helpers not executable by API roles, and the OFF matrix (absent, false, string, non-array allowlist, non-object JSON, org not allowed, org flag false/string/absent) ⇒ null/404, no `app.b023_` call from the app, raw RPC 42501, zero rows. Unit `src/server/owner-portal-access.test.ts`: strict flag parser, HTTP 404/inline/attachment/503, copy keys and banned words, migration grant/revoke shape.

## 不做什麼

No lifecycle replies, messaging, profile/security/session or notification-preference changes (later slices). No consent, signature, acknowledgement or read-receipt writes. No changes to tenant/staff document routes, e-sign, privacy/terms/consent text. No hosted activation.

## Assumptions

1. Document center slice 1 = paper-signed lease PDFs (`lease_signed_pdfs`, bytes in DB). E-sign executed PDFs and management-agreement files (Storage objects) are a later slice.
2. Version label reflects today's state (`現行版本` = lease pointer, else newest), even for history owners. Consequence of strict dating: an owner who acquires a property mid-lease does not see that lease's PDF uploaded before their window start (fail-closed; CEO may later choose to admit the in-force lease document).
3. Listing writes no audit (tenant list precedent); only open/download are audited.
4. Repair status shown to a current owner is the live ticket status (which may reflect an internal-entry change), while internal entries are never listed.
5. `/o/files` naming chosen to match `/o/statements`, `/o/approvals`.

---

# Slice 2：屋主租約回覆與公司訊息

> Author: Claude FALLBACK-SUBAGENT implementer (Codex unavailable), 2026-11-06 PT. Branch `feat/b-023-owner-replies-messages` on slice 1 @ 674d826. Same flag `owner_portal_extensions` (default OFF). Migration `20261107113000_b023_owner_replies_messages.sql` (additive; slice 1's migration untouched).

## 能力 ID

- Covered: CAP-O-10 / OWN-07–08 lifecycle replies (owner text reply to B-012 renewal-intent / non-renewal / early-termination notices; owner, tenant and company responses kept separate); CAP-O-11 company messaging (one owner ↔ company thread per property per owner, text only).
- Slice 3 (below) covers profile / security / sessions and notification preferences. Not built: staff inbox listing of owner threads, notifications on new owner messages, attachments, settlement replies (OWN-09).

## Done means

With `owner_portal_extensions` ON (and `lease_renewal` ON for lifecycle items), an owner with **current** authority opens `/o/lifecycle`, sees the latest version of each B-012 notice on non-draft leases of their current properties (kind, who filed it — 租客／公司／屋主, dates, term; no notice text, actors or other parties' responses), opens `/o/lifecycle/<recordId>` and sends a text reply that is stored only in `app.b023_owner_lifecycle_replies`. `/o/messages` lists one row per currently authorized property; `/o/messages/<propertyId>` shows that owner's own thread (their messages + company messages) and sends text. Flag OFF: all four routes 404, actions return `unavailable`, no nav entries, zero writes.

## Reuse decisions

- **Lifecycle model = B-012** (`app.b012_notice_versions`). B-012 already has an explicit owner response action (`b012_respond_notice`, party `owner`, agree/disagree/undecided). Per the rule, it is **not changed and not invoked**. A B-023 reply is a separate append-only record referencing `(record_id, notice_version)`; it carries no stance, so no consent, signature, confirmation, approval or decision can be inferred. B-012 tenant/management/owner responses are never read into, merged with or replaced by owner replies; the owner page shows only the caller's own replies (co-owners each see only their own).
- **Thread model = `public.message_threads` / `public.messages`**. Additive enum value `thread_kind = 'owner_company'` (lease_id NULL) and a private link `app.b023_owner_threads(thread_id, property_id, owner_contact_id)` (UNIQUE per property/owner). Owners are **not** `thread_participants`, so existing portal RLS (`app.in_thread`) never admits them or tenants; owners read/write only via definer gateways. Staff read through existing `team_read`; company replies use the existing staff `postMessage` path and `messages.send` permission (no staff permission or policy changes). Existing staff/tenant queries filter `kind = 'lease'` or join leases, so owner threads do not appear in tenant views.
- **Authority = slice 1** (`b023_owner_contact`, `b023_owner_authority`), current window only (property-local today, exclusive end). Lifecycle items additionally require the lease term to overlap the current window (successor owners do not get predecessor-period leases).

## Writes, idempotency, locks

- `app.b023_reply_owner_lifecycle(org, session, record, notice_version, request, body)` and `app.b023_post_owner_message(org, session, property, request, body)`: `jsonb {state}` = `recorded | replayed | conflict | stale | invalid`; every denial (flag OFF, revoked session, ended/no authority, foreign/draft/cross-org id, staff, borrowed session id) raises 42501 with zero writes. Exact replay ⇒ `replayed` with the same id (also after the notice changes); reuse with another payload ⇒ `conflict`. Lifecycle replies to an older notice version ⇒ `stale`.
- Recent authority recheck at submit, under locks: platform_settings rows (`lease_renewal`, `owner_portal_extensions` by key) SHARE → organization SHARE → `auth_sessions` row SHARE → owner contact SHARE → caller's `property_owners` rows SHARE → (lifecycle) lease SHARE (B-012 notice writers take it FOR UPDATE) → request / thread advisory locks → re-admission through the same scope the reader uses.
- Message idempotency ledger `app.b023_owner_message_requests` stores a SHA-256 body digest (not the body). New tables: RLS on, REVOKE ALL from PUBLIC/anon/authenticated/service_role, immutable triggers (thread link: no UPDATE; deletable only by cascade when staff delete the thread).
- POST convention = B-022: Next server actions (`owner-replies-messages-actions.ts`, same-origin enforced by Next), `requireCurrentConsent()` first; the client keeps one request id per text and reuses it on retry.

## 驗證方式

`src/server/b023-owner-replies-messages.integration.test.ts` (9 tests after review r1): owners A (current P1, ended P3), A2 (co-owner P1), B (P2), C (P3 successor), D (org 2), tenant T on P1. Separation (tenant + company responses created through B-012; owner reply leaves `b012_*` tables, tenant/staff B-012 views and consent snapshot byte-identical), projection allowlists and secret-string absence, idempotent replay/conflict/invalid/stale with zero extra rows, ended authority (exclusive end today) and revoked session ⇒ denied, zero writes, foreign/cross-org/draft/staff/borrowed-session ids ⇒ 42501, private helpers not executable, thread per property/owner on `message_threads`, co-owner thread isolation, staff reply via existing path visible as 公司, no owner/tenant RLS read of owner threads, deleted messages hidden, OFF matrix (9 global/org cases + `lease_renewal` OFF) ⇒ null/unavailable, no `app.b023_` call, raw RPC 42501, zero writes. Unit `src/server/owner-replies-messages.test.ts` + `owner-nav.test.ts`. Evidence: `e2e/results/B-023/{integration-b023-owner-replies-messages.tap, unit-owner-replies-messages.tap, slice2-gates.json}`.

## Assumptions / open items

1. Lifecycle replies require both `owner_portal_extensions` and `lease_renewal`; B-012 items are never surfaced while B-012 is OFF.
2. Owner pages show no notice body (may contain tenant text); kind/party/dates only. CEO may choose to show owner-filed or company-filed text later.
3. Ended-authority owners lose read access to their past threads and replies (fail-closed; history view could be a later decision).
4. Staff replies through the existing `postMessage` path are not request-id idempotent (existing behaviour, unchanged). Notifying staff of new owner messages is out of scope (slice 3 preferences).
5. Text length: the client (`ownerText`, textarea `maxLength`) counts UTF-16 code units, SQL `length()` counts characters, so an astral character (e.g. emoji) counts 2 in JS and 1 in SQL. The JS check is therefore never looser than SQL: text the client accepts always fits; a few near-limit emoji-heavy texts are rejected client-side (`invalid`) although SQL would accept them.

## Review r1 fixes (company visibility and message hygiene)

- **Staff surfaces (read-only, existing roles only).** `app.b023_staff_owner_threads(org)` lists owner ↔ company threads (property, owner display name, last activity, preview) and is shown as a separate 屋主訊息 section on `/m/messages` (role gate `messages.send` = admin/manager, same as the inbox route); the lease-thread `listThreads` query is untouched. Staff open the thread at the existing `/m/messages/<id>` and reply through the existing `postMessage`. `app.b023_staff_owner_lifecycle_replies(org, lease)` lists owner replies (notice kind/version, owner name, text, time) on the staff lease page summary tab (`leases.edit` = admin/manager, the B-012 management roles), labelled as separate from tenant/company responses and never agreement/confirmation/approval. Both require `owner_portal_extensions` (replies also `lease_renewal`), `app.has_role(org, admin|manager)` with active-org pinning; other roles, other orgs, owners, tenants and `anon` get 42501; OFF ⇒ the TS reader returns null after one flag read, no `app.b023_` call, nothing rendered.
- **Replay of a deleted message** (soft `deleted_at` or hard delete by staff `team_update`/`team_delete`) returns `gone`, never `replayed` with a dangling id.
- **Edited marker.** The owner gateway returns `edited` = `edited_at` set, or (owner's own message) body no longer matches the digest recorded at send; shown as 已編輯 / Edited.
- **Volume cap.** At most 30 owner messages per thread per rolling 24 h (counted from `public.messages`, incl. soft-deleted); further posts return `rate_limited` with zero writes and zh-TW/en copy.
- Tests: integration now 9 (staff admin/manager see threads + replies; accountant/maintenance/other org/owner/tenant/anon denied; foreign lease denied; inbox lease query unchanged; gone/edited/cap; OFF matrix covers both staff readers).

---

# Slice 3：屋主帳號（登入裝置、聯絡資料、通知設定）

> Author: Claude FALLBACK-SUBAGENT implementer (Codex unavailable), 2026-11-06 PT. Branch `feat/b-023-owner-account-preferences` on slice 2 @ c4bdc28. Same flag `owner_portal_extensions` (default OFF). Migration `20261107116000_b023_owner_account_preferences.sql` (additive; slice-1/2 migrations untouched).

## 能力 ID

- Covered: owner profile / security / sessions and owner notification preferences (spec scope "profile/security/sessions and notification preferences"; acceptance "Given session/preference edits, when submitted, then ownership and recent-auth controls apply").
- Deferred: owner password change / credential epoch (B-031 #71, other stack); staff permissions; privacy/terms/consent text.

## Done means

With the flag ON, an owner opens `/o/account` (nav 帳號 / Account) and sees (1) 聯絡資料: display name, notification/contact language and preferred contact method of their own owner contact, editable; email and phone shown read-only; (2) 通知設定: 報修進度通知 and 屋主報表寄送通知, each ON by default, toggled per owner (copy says the choice is saved and applies once delivery supports it); (3) 登入裝置: their own live login sessions (browser · OS summary computed in SQL, signed-in and last-used time, 這台裝置 marker; no IP, no raw user agent), with 讓該裝置登出 on each other device (copy states this ends that device's whole Condola session, all roles/companies) when the current session signed in within the last 15 minutes. Flag OFF: `/o/account` 404, no nav entry, actions `unavailable`, zero writes.

## Reuse decisions

- **Sessions = `public.auth_sessions`** (user-level). `app.b023_owner_sessions(org, session)` returns only a device summary (`app.b023s3_device`, never the stored user agent) for `auth.uid()`'s live rows (`revoked_at IS NULL AND expires_at > now`); the caller's `session` must be its own live row (a borrowed id ⇒ 42501). `app.b023_revoke_owner_session(org, session, target, request)` revokes exactly one other own session (`revoked_at = clock_timestamp()`), like the existing staff `revokeSession`; another user's session id ⇒ 42501 without being read or locked; target = current ⇒ `current` (normal sign-out ends the current session). Ledger `app.b023_owner_session_revocations` (request-id idempotency, looked up before the `current`/`reauth_required` checks so a retried completed revoke is `replayed`) + one `audit_log` row (`owner_session_revoked`, no IP).
- **Legacy staff actions closed to portal sessions (review r1).** The pre-existing `/m/account` server actions `actionRevokeSession` / `actionRevokeOthers` (`src/server/auth-actions.ts`) now return with no effect unless `session.kind === "staff"`, so an owner or tenant session cannot bypass the owner recent-auth by calling them by action id. Staff behaviour is unchanged.
- **Recent-auth.** No re-authentication mechanism exists on this base (staff `/m/account` revokes without one). Fallback per brief: revoke requires the current session's `auth_sessions.created_at` (set only at sign-in; never re-issued on activity) within the last **15 minutes** (`app.b023s3_recent`). Older ⇒ `reauth_required`, zero writes; the page hides revoke buttons and explains "sign out and sign in again". Profile and preference edits do not change contact channels, so they need ownership + live session only.
- **Profile = own `public.contacts` row** (slice-1 `b023_owner_contact` binding). Editable: `display_name` (1–100, trimmed, no control chars), `locale` (`zh-TW|en`), `preferred_channel` (NULL = company default, `in_app`, or `email`/`sms`/`line` only when the contact has that address). Email/phone read-only: no verification flow exists for contact-channel changes. No new personal-data fields; no ID/tax numbers. Optimistic `version` (md5 over editable fields + `updated_at`) ⇒ `stale`; equal values ⇒ `unchanged`; ledger `app.b023_owner_profile_revisions` (request-id idempotency). The existing `contacts` audit trigger records the change. Same precedent as B-022 `b022_set_receipt_title` (owner edits a field of their own contact).
- **Preferences = tenant-reminder-preference pattern** (`app.b010_tenant_due_preferences`: default-true row, definer get/set, audit row on change). Additive `app.b023_owner_notification_preferences(org, owner_contact, category, enabled)`; no row = ON. Categories = owner notifications that exist on this base: `repair_updates` (B-028 center `vendor_job_assigned`, owner persona) and `statement_reports` (B-014 report delivery). Ledger `app.b023_owner_preference_requests`; audit `owner_notification_preference_changed`.
- **Delivery wiring pending.** No existing owner delivery consults preferences (B-028 has no granted producer; B-014 delivery is a mock adapter). `app.b023_owner_notification_enabled(org, contact, category)` (private, not granted) is the helper for future producers: true unless the flag is ON and the owner opted out, so defaults and flag-OFF keep current behaviour. Wiring belongs to the B-028 producer stack.
- **POST convention = slice 2**: Next server actions (`owner-account-actions.ts`), `requireCurrentConsent()` first, client keeps one request id per intended change and reuses it on retry.

## Writes, idempotency, locks

States: revoke `revoked | replayed | conflict | current | reauth_required | gone`; profile `recorded | replayed | unchanged | stale | invalid | conflict`; preference `recorded | replayed | unchanged | conflict | invalid`. Every denial (flag OFF, staff, tenant, other org, revoked/expired/borrowed session, foreign id) raises 42501 with zero writes. Lock order: owner_portal_extensions row SHARE → organization SHARE (`b023_flag_locked`) → owner contact (SHARE; profile FOR UPDATE) → (revoke) both own session rows in id order FOR UPDATE → request advisory lock → (preference) per-category advisory lock. New tables: RLS on, REVOKE ALL from PUBLIC/anon/authenticated/service_role; ledgers immutable (55000); all functions `SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp`, REVOKEd, only the six gateways granted to `authenticated`.

## 驗證方式

`src/server/b023-owner-account-preferences.integration.test.ts` (8 tests after review r1): own live sessions only (revoked/expired/other users excluded; no IP; no raw user agent; SQL device summary; field allowlist; borrowed session id 42501); revoke never another user's session (unavailable + raw 42501) or the current one (`current`), staff/tenant denied, zero writes; one other own session revoked + one ledger + one audit row; replay/conflict/gone write nothing; ledger immutable; recent-auth (1 h-old and 16-min-old current session ⇒ `reauth_required`, zero writes; 14-min ⇒ allowed; revoked/expired current ⇒ unavailable; a completed revoke retried after the window ⇒ `replayed`); legacy `/m/account` revoke actions called with owner/tenant cookies ⇒ zero revocations and zero audit rows, staff positive control unchanged (mutation-checked: removing the guard fails the test); profile ownership (other owner's contact byte-identical; channels limited to addresses; invalid/unchanged/stale/replay/conflict; staff/tenant/cross-org/borrowed session/foreign org ⇒ unavailable/42501; email untouched); preference defaults ON, per-owner isolation, replay/conflict/unchanged/invalid, producer helper incl. flag-OFF ⇒ true; private helpers/tables unreachable by API roles; OFF matrix (9 cases) ⇒ null/unavailable, no `app.b023_` call, raw RPC 42501 for all six gateways, zero writes. Unit `src/server/owner-account.test.ts` (display-name bounds, pre-DB denial, copy keys/banned words, migration grant/revoke shape) + `owner-nav.test.ts`. Evidence: `e2e/results/B-023/{integration-b023-owner-account-preferences.tap, unit-owner-account.tap, slice3-gates.json}`.

## Assumptions / open items

1. 15-minute recent-auth window from session creation is a fallback until a real re-authentication flow exists (CEO may choose another window or require password/OTP re-entry, likely with B-031).
2. Owner display-name edits change `contacts.display_name`, which staff also see (B-022 receipt-title precedent). `profiles.display_name` (user-level login name) is unchanged.
3. `preferred_channel` and `locale` are stored on the contact; no existing delivery path reads `preferred_channel` today.
4. **Open item — delivery wiring.** Preferences are stored only; nothing consumes `app.b023_owner_notification_enabled` yet. Wiring is pending in the B-028 center producers (`vendor_job_assigned`, owner persona) and the B-014 report delivery path (`statement_reports`), both on other stacks. Owner copy therefore promises only that the choice is saved and applies once delivery supports it. Turning the flag OFF makes the helper return "send" again (current behaviour), while stored choices are retained for re-enable.
5. Revoking a session ends the local `auth_sessions` row only, matching the existing staff single-session revoke (hosted GoTrue `end_auth_sessions` is used only by sign-out-all).
6. Owner password change / credential epoch: deferred to B-031 (#71).

---

# B-023 overall acceptance coverage

| Spec acceptance | Slice | Evidence |
|---|---|---|
| Given owner/property authorization, when listing files/repairs, then only authorized current/history content appears. | 1 | `b023-owner-portal-access.integration.test.ts` (exact id sets per owner A–G, gap/re-acquisition/successor clipping, exclusive end, cross-org/staff/foreign ids ⇒ 404) |
| Given a lifecycle reply, when saved, then tenant/company responses remain separate. | 2 | `b023-owner-replies-messages.integration.test.ts` (B-012 tables and tenant/staff views byte-identical after owner reply; owner sees only own replies; staff reads owner replies separately) |
| Given view/download, when audited, then no consent/confirmation is inferred. | 1 (+2) | consent/signature/confirmation/read snapshot unchanged around open/download (slice 1) and replies/messages (slice 2); one access row per request |
| Given session/preference edits, when submitted, then ownership and recent-auth controls apply. | 3 | `b023-owner-account-preferences.integration.test.ts` (own sessions only, never another user's or current session, 15-min recent-auth with zero writes when stale, own contact only, per-owner preferences, idempotent replay) |
| Each route/API/file, multi-property isolation and account cases under `e2e/results/B-023/` | 1–3 | `/o/files`, `/o/files/<id>`, `/o/repairs`, `/o/repairs/<id>`, `/o/lifecycle`, `/o/lifecycle/<id>`, `/o/messages`, `/o/messages/<propertyId>`, `/o/account` + staff readers; OFF matrices in all three integration files; TAP + gates JSON per slice |
| Out of scope respected (staff permissions, automatic consent, protected text) | 1–3 | no staff permission/policy changes; no consent writes; no privacy/terms text edits; owner password change deferred to B-031 |

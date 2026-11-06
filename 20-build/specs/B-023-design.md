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

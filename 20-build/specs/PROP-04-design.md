# PROP-04 — JIT L2 設計稿：同意紀錄統一（L1-CON）

> Author: Claude (Mac overnight, 2026-11-06 PT). L1 foundation per hub `10-product/step4-architecture/architecture-v0.md` §8 (L1-CON: unify `consents`, `partner_agreement_consents`, ID consent notices, lease agreement; **viewing ≠ consenting**). Depends on PROP-02 (done). Related B-005/B-027 consume it later. No new flag, no UI, no behaviour change. Branch cut from #36 (`d374bb6`).

## Done means

A single read model returns, for the signed-in user, every consent/acceptance record Condola holds about them — terms/privacy acceptances, partner-agreement/privacy acceptances for organizations they belong to, ID-notice acknowledgements tied to their contact, lease signatures — each with kind, document version or digest, time, source and scope; and CI fails if any page, layout or GET route handler writes a consent table (viewing a document never records consent).

## Design

- Migration `20261106080000_prop04_consent_records.sql` (additive): `app.prop04_my_consent_records()` SECURITY DEFINER `SET search_path = pg_catalog, public, app`, REVOKE ALL from API roles, GRANT EXECUTE TO authenticated. Returns `(kind text, scope_org_id uuid, document_ref text, accepted_at timestamptz, source text, record_id text)` only for `auth.uid()`:
  - `terms_privacy` ← `public.consents` (`terms_version|privacy_version`, `source`)
  - `partner_agreement` / `partner_privacy` ← `public.partner_agreement_consents` where `user_id = auth.uid()` (document_ref = `doc_type:version:sha256`)
  - `id_notice` ← identity documents of contacts whose `user_id = auth.uid()` that carry a consent notice digest (use the actual columns from migrations `20261025120000_id_consent_notice.sql` / `20261029140000_id_consent_shown_version.sql`; never return ID numbers, photos or storage paths)
  - `lease_signature` ← lease signature evidence for the user (`lease_signatures` and/or e-sign signer completion; document_ref = document digest/version only)
  Pinned org/env scope applies where the source is org-scoped (`app.is_member` / contact org).
- `src/server/consent-records.ts`: `myConsentRecords(session)` typed reader (tx + `requireOrgScope`), stable ordering newest first.
- Guard `src/server/consent-view-guard.test.ts` (unit, static): no file under `src/app/**/page.tsx`, `layout.tsx`, or a route's `GET` handler contains an INSERT/UPDATE into `consents` / `partner_agreement_consents` or calls a consent writer; consent writes stay in the existing explicit POST/server-action paths.

## Privacy

No ID numbers, images, storage paths, IPs or user agents in the read model; counts and digests only. No consent/notice/legal copy edited.

## Verification

Integration `src/server/prop04-consent-records.integration.test.ts`: own records only (other user/org hidden), each kind present when seeded, sandbox/live pinned scope respected, function privileges (anon denied). Unit guard test.

## Cross-review

- Codex QA r1 FAIL: guard missed `.call/.apply/.bind`, SQL constants and transitive server components; ID-notice digest/time mixed across versions → fixed (matched modern pair → legacy pair → omit; 15 edge cases).
- Codex QA r2 FAIL: destructuring/property/namespace aliases still bypassed the guard → fixed after r2 by Codex (60/60 guard cases incl. allowed POST/action/client boundaries), reviewed by Claude; not re-reviewed by a third QA round (2-round cap) — hub BLK-MAC-08.

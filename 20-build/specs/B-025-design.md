# B-025 — JIT L2 設計稿：廠商收據開立入口與全額實收閘（slice 1）

> Author: Claude (Mac overnight, 2026-11-06 PT). Layer-2 design for hub `20-build/specs/B-025.md` incl. **PROP-MF-B025 / UC4** and **PROP-US-v03-05 (CAP-V-14)** reserves. Stacked on B-022 (`feat/b-022-owner-replies-title`, receipt-title source). Existing backend reused: `src/server/vendor-receipt.ts` (invite/grant tokens, preview without sequence, idempotent issue, issuer-only void, reissue, PDF bytes + sha256) — it has no routes or UI yet.

**Slice 1 (this PR):** vendor-facing document entry behind `vendor_documents` (OFF) + the full-payment receipt gate + the two receipt paths. **Deferred to slice 2 (logged, not dropped):** onboarding-invitation UI, fixed-data/seal history UI, paper-scan sibling upload, trade quantity/unit field editing.

## Done means

With `vendor_documents` ON for a local test org and a staff-created document invite, the vendor opens `/v/documents/<token>` (the URL staff invitations already generate), sees the job's line items and total, previews a receipt/completion statement (no number consumed), records amounts received for this work order (partial amounts only accumulate), and can issue an electronic **receipt only once the recorded received total covers the document total** (two-step: completion statement first, or one-step on site: record the full amount and issue in one action); the vendor can void (issuer only) and reissue; PDFs download and old PDFs stay unchanged. Flag OFF: routes 404, nothing written.

## Data (additive migration `20261106050000_b025_vendor_document_gate.sql`)

- Seed `platform_settings('vendor_documents', {"enabled":false,"allowed_org_ids":[]})` ON CONFLICT DO NOTHING; `ops/flags.yaml` entry OFF.
- `app.b025_received_marks(id, org_id, ticket_id, vendor_profile_id, grant_id, amount_minor bigint > 0, request_id, created_at; UNIQUE(org_id, request_id))` — append-only vendor statements "received this amount for this work order"; RLS on, REVOKE ALL.
- Gate in the DB: `BEFORE INSERT` trigger on `public.vendor_documents` — when `vendor_documents` is ON for the org and `kind='receipt'`, require `sum(received marks for ticket+profile) >= total_minor` (bigint) else `23514`. **No override parameter** (US v0.3: the full-payment CHECK cannot be overridden). Flag OFF: unchanged (existing tests/paths keep working; no route reaches them).
- RPC `app.b025_record_received(p_grant uuid, p_request uuid, p_amount bigint)` SECURITY DEFINER (pinned search_path), used by the token route via the existing service path; idempotent by request id.

## Routes (token in POST body / header, never in a query string)

- `POST /api/vendor-documents` `{ token, action: 'context'|'preview'|'mark_received'|'issue'|'void'|'reissue', ... }` → flag check first (404 when OFF), then existing `vendor-receipt.ts` functions with the token actor. `issue` with `kind:'receipt'` maps a gate failure to `receipt_requires_full_payment`.
- `POST /api/vendor-documents/pdf` `{ token, documentId }` → PDF bytes (integrity-checked), `Cache-Control: no-store`.

## Money / permission (Class B)

BigInt for received marks and gate (existing `totalMinor` number fields are pre-existing; the gate re-checks in SQL bigint). Token-scoped grant authority (existing `authorize`/`authorizeDocument`); void issuer-only (existing); vendor surfaces never show owner prepay or company internal settlement (only line items, total, own received marks); receipt ≠ tax invoice (copy).

## 驗證

Integration `src/server/b025-vendor-document-gate.integration.test.ts`: flag OFF ⇒ route handlers 404 and zero marks; partial marks block receipt, full marks allow; completion statement allowed before full payment; one-step mark+issue; replayed request ids idempotent; preview consumes no sequence; void/reissue keeps old PDF bytes and never reuses a number; other grant's token cannot mark or read.

## 不做什麼

No ID-document collection, no company-checkbox substitution, no tax/legal claims, no change to numbering rules, no owner prepay/internal settlement exposure.

## Cross-review changes (Codex QA r1 FAIL → fixed)

1. **act on** — Gate bypass via UPDATE: `app.b025_document_identity_immutable` (BEFORE UPDATE) rejects changes to kind, totals, items, buyer, doc number, ticket/profile/org; voiding still works.
2. **act on** — One-step replay: an already-used idempotency key returns its document without appending another payment mark.
3. **act on** — Multi-row work-order pricing has no authoritative per-row names/amounts on the ticket: the token surface fails closed (`itemsUnavailable`, preview/issue 409 `items_unavailable`, page explains) instead of 404.
4. **act on** — Page moved to `/v/documents/[token]`, matching the URL `createVendorDocumentInvite` already returns.
5. **dismissed with reason** — 「買受人統一編號」 on company-buyer receipt PDFs is pre-existing merged code (`vendor-receipt-pdf.ts`, with an explicit test exemption): it labels the *buyer company's* tax ID on a vendor-issued receipt, not Condola showing or claiming its own registration. Raised to CEO (BLK-MAC-05) for a copy decision; unchanged here.

# B-022 — JIT L2 設計稿：屋主轉帳紀錄、收據抬頭與報表回覆

> Author: Claude (Mac overnight, 2026-11-06 PT). Layer-2 design for hub `20-build/specs/B-022.md` incl. the **PROP-US-v03-05** cross-reference (B-022 is the receipt-title *source* for CAP-V-14; it must not exclude CAP-V-14's two modes and does not decide receipt timing). Stacked on B-014 (`feat/b-014-owner-net-ledger`), which provides transfer records (`b014_owner_transfer_v1`) and report versions (`app.b014_statement_versions`).

## 使用者故事／能力 ID

- Covered: OWN-02/03/10, CAP-O-04 (owner-entered receipt title), CAP-O-06 (transfer history separate from statement totals), CAP-O-07 (report replies/disputes per version).
- Not covered: inferring a title from identity data, payment execution, tax guarantees, receipt issuance timing (B-025 / CAP-V-14), owner settings hub (B-023), real notifications (B-028).

## Done means

With `owner_receipt_title` ON for a local test org, an owner opens `/o/receipt-title`, enters a title and sees it saved with history; a vendor receipt for that owner's job uses only that title and is blocked while it is empty. With `owner_report_replies` ON, the owner on `/o/statements/<id>` sees their company-to-owner transfer records listed separately from the statement totals and can confirm or dispute the **current** report version; after staff creates a newer version (B-014), the owner sees 「報表已更新，請重新確認」 and the earlier confirmation is not carried forward; staff see the replies on `/m/statements/<id>`. Flags OFF: every page, PDF and write path unchanged; zero B-022 rows.

## 端到端 tracer bullets

1. **Receipt title**: owner form → server action `saveReceiptTitleAction({ requestId, title })` → `app.b022_set_receipt_title(org, request, title)` (SECURITY DEFINER; flag ON; caller is the active owner contact `contacts.user_id = auth.uid() AND is_owner AND archived_at IS NULL` in the pinned org) → updates `contacts.receipt_title` and appends `app.b022_receipt_title_revisions`. Vendor receipt path (`src/server/vendor-receipt.ts` → `validateBuyer`) already reads only `contacts.receipt_title` and fails `ownerReceiptTitleMissing` when empty — B-022 adds tests, not new vendor reads.
2. **Transfer history**: owner statement page → `ownerTransferHistory(session, statementId)` → `app.b022_owner_transfers_for(statement)` returns only B-014 transfer rows (`owner_payout` / `reversal`) whose `owner_payable` entry contact is the statement's owner and the caller `is_my_contact`, within the statement period → rendered as its own list, never added into the totals.
3. **Replies**: owner panel → `recordReportReplyAction({ statementId, versionId|null, requestId, kind: 'confirm'|'dispute', body })` → `app.b022_record_report_reply(...)`: flag ON; issued statement; caller `is_my_contact(owner_contact_id)`; `versionId` must be the **latest** version (NULL only when no B-014 version exists); dispute body 1..1000 trimmed, confirm body NULL; idempotent by request id → append-only `app.b022_report_replies`. Read `app.b022_report_replies_for(statement)` (staff member of org or the owner). Presentation: confirmed ⇔ a `confirm` reply exists for the current latest version id.

## 資料表與 RLS (additive migration `20261106040000_b022_owner_title_report_replies.sql`)

- Seeds `platform_settings` `owner_receipt_title`, `owner_report_replies` = `{"enabled":false,"allowed_org_ids":[]}` ON CONFLICT DO NOTHING; `ops/flags.yaml` entries default false.
- `app.b022_receipt_title_revisions(id, org_id, owner_contact_id, request_id, title text 1..100 trimmed, actor_user_id, created_at; UNIQUE(org_id,request_id))`.
- `app.b022_report_replies(id, org_id, statement_id, version_id NULL, owner_contact_id, request_id, kind confirm|dispute, body NULL|1..1000, actor_user_id, created_at; UNIQUE(org_id,request_id); FK statement; FK (org,statement,version) → b014 versions)`.
- RLS on, REVOKE ALL from PUBLIC/anon/authenticated/service_role, append-only triggers. All functions `SECURITY DEFINER SET search_path = pg_catalog, public, app`, `GRANT EXECUTE TO authenticated` only, none in `public`.
- The only existing-table write is `contacts.receipt_title` (column exists since `20261030150800`), done only by the RPC with flag ON.

## 錢／權限風險（Class B）

Permission + owner PII boundary. Review: owner can set only their own contact's title (no staff inference path); vendor sees only the title (field minimization already in `validateBuyer`); replies bind to one version and cannot target an old version; cross-org / other owner / draft statement fail closed; no money arithmetic beyond displaying BigInt transfer amounts.

## 驗證方式

Integration `src/server/b022-owner-replies.integration.test.ts` (disposable PG): flags OFF ⇒ actions unavailable, zero rows, `contacts.receipt_title` unchanged; owner sets title (history kept, replay idempotent, other owner/staff denied, empty/too long rejected); vendor receipt blocked without title and buyer snapshot has only `kind`+`receipt_title`; transfer list for owner shows payout + reversal separately, other owner's transfers hidden; confirm v2 → staff adds v3 → status not confirmed; confirm on v2 after v3 rejected; dispute needs body; cross-org denied.

## 不做什麼

No receipt issuance changes, no inferred title, no notifications, no change to B-014 tables or statement totals, no protected legal copy.

## Assumptions

1. Title max 100 characters (same order as existing holder/display names); no format validation beyond trim/non-empty (not a 統一編號 field and never labelled as one).
2. Transfer history and replies share the `owner_report_replies` flag (both are the owner finance-reply surface); title uses `owner_receipt_title`.
3. A reply on the original statement (no B-014 version) uses `version_id = NULL`; once a version exists, NULL is rejected.

## Cross-review changes (Codex QA)

- r1 BLOCKER (staff could write `contacts.receipt_title` through existing table grants): invoker trigger `app.b022_guard_receipt_title` rejects `authenticated` / `anon` / `service_role` changes unless `app.b022_set_receipt_title` wrote a transaction-scoped token in private `app.b022_title_write_tokens` (cleared at commit). Table-owner maintenance is unaffected; no existing app path writes the column.
- r1 BLOCKER (displayed vs confirmed version from separate transactions): replies bind to the version actually displayed; confirmation is disabled with a stale notice when it is not the latest; the RPC still rejects non-latest versions.
- r2 BLOCKER (staff rebinding `contacts.user_id` to themselves): defense in depth — owner-only RPCs reject active staff members of the organization (or its live org). The underlying issue — staff can change `contacts.user_id`, which every owner-portal check (`app.is_my_contact`) trusts — predates B-022 and is raised to CEO as BLK-MAC-04 (needs a trusted owner-linking operation).

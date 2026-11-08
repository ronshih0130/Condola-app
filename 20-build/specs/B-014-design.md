# B-014 — JIT L2 設計稿：屋主淨額帳、轉帳紀錄與報表版本

> Author: Claude (Mac overnight, 2026-11-06 PT). Layer-2 design per hub `20-build/specs/B-014.md`, including the appended reserves **PROP-MF-02 (presentation only)**, **PROP-MF-B014 acceptance addenda** and **PROP-US-v03-06 (US v0.3 / CAP v2.1)**. Stacked on B-010 (`feat/b-010-reminders-payment-results`); hard dependency B-008 is in that stack.

## 使用者故事／能力 ID

- Covered: MGT-25/26/27 (net ledger reconciliation, report versions, delivery events), OWN-02 (owner sees the period net and transfers), CAP-M-17/18, CAP-O-03; reserve CAP-M-36 / CAP-O-16 (prepay draw shown as a separate line, presentation only).
- Deliberately not covered: actual remittance, inferred owner repayment, owner-level invoices / auto-allocate (PROP-MF-03, not open), `owner_prepayment` ledger account (future PROP, CEO/Ron GO), protected legal copy, real e-mail / LINE delivery (B-028).

## Done means

With `owner_net_ledger` ON for a local test org, an admin/accountant opens `/m/statements/<id>`, enters a reason and records a new **report version**; the page shows the version's net-ledger breakdown (opening → company-collected rent, owner-direct rent (informational), utilities/other, management fee, advances/expenses, prepay draws (reserved 0), recorded transfers → closing) that reconciles to the integer minor unit, keeps every earlier version with reason/actor/time, and the owner sees the same latest version at `/o/statements/<id>`; a negative result shows 「本期淨額為負」 plus a note that it is not a payment request. With the flag OFF both pages, the PDF and every write path are byte-for-byte unchanged and no B-014 row is written.

## 端到端 tracer bullet

1. Staff (admin/accountant, live or sandbox org) on `/m/statements/<id>` → server action `recordStatementVersionAction({statementId, requestId, reason})`.
2. Server (`src/server/owner-net-ledger.ts`) checks flag ON (global `platform_settings.owner_net_ledger` `enabled===true` + `allowed_org_ids` contains org + `organizations.feature_flags.owner_net_ledger===true`), role, recomputes the period with the existing `calculateStatement` (B-008 path) plus:
   - **payouts**: B-014 owner transfer records (`ledger_transactions.source_table='b014_owner_transfer_v1'`, kinds `owner_payout` (+) / `reversal` (−)) for the owner's properties with `effective_date` inside the period;
   - **collector split**: each confirmed rent payment is classified `company` or `owner_direct` through the SECURITY DEFINER read `app.b014_payment_collectors(org, payment_ids[])` (snapshot precedence: `app.b010_payment_confirmations.confirmed_via` `owner_direct`/`staff_proxy` ⇒ owner_direct, `management` ⇒ company; else current `app.b010_lease_collectors.collector='owner'` ⇒ owner_direct; else company);
   - **opening**: latest version closing of the previous issued statement (same owner+currency) if it has versions, else that statement's `closing_balance_minor`, else 0.
3. Pure BigInt rules (`src/server/owner-net-ledger-rules.ts`) build the snapshot and check the identity `closing = opening + company_rent + other_income − management_fee − expenses − payouts` (owner-direct rent and prepay draws are listed but never change the company-pending balance).
4. RPC `app.b014_record_statement_version(...)` re-verifies flag/role/statement/identity in SQL and appends an immutable row in `app.b014_statement_versions` (version_no = previous + 1 under an advisory lock; idempotent by `request_id`).
5. Read: `app.b014_statement_versions_for(statement)` returns versions to staff of the org or to the owner contact of an issued statement (`app.is_my_contact`). Pages render `<OwnerNetLedgerPanel>`.
6. Optional (`monthly_report_delivery` ON): staff clicks 「記錄寄送（模擬）」 → mock adapter (local capture, no network) → `app.b014_record_delivery_event` appends `{version, channel:'email', result}`; manager page lists events.

## Caller-first 介面

```ts
// pages (server components)
const ledger = await ownerNetLedgerView(session, statementId); // null when flag OFF / not visible
// ledger: { latest: VersionView | null; versions: VersionSummary[]; canRecord: boolean; deliveries: DeliveryView[] | null }

// client component → server actions
await recordStatementVersionAction({ statementId, requestId, reason }); // {state:'recorded'|'invalid'|'unavailable'|'unchanged_identity_error', versionId?}
await recordReportDeliveryAction({ statementId, versionId, requestId }); // {state:'recorded'|'unavailable', result?}
```

Pure rules (unit-tested, no DB):

```ts
computeOwnerNet(input: { opening, companyRent, directRent, otherIncome, managementFee, expenses, payouts, prepayDraws }: Record<string, bigint>)
  → { closing, net, negative: boolean, lines: Array<{ key, amountMinor: bigint, affectsBalance: boolean }> }
reconcileSnapshot(snapshot) → boolean   // identity check on strings of integer minor units
```

## 資料表與 RLS（additive migration `20261106030000_b014_owner_net_ledger.sql`）

- Seeds (ON CONFLICT DO NOTHING): `platform_settings('owner_net_ledger', {"enabled":false,"allowed_org_ids":[]})`, `platform_settings('monthly_report_delivery', {"enabled":false,"allowed_org_ids":[]})`. `ops/flags.yaml` entries default `false`, ring internal.
- `app.b014_statement_versions` (id, org_id, statement_id, version_no int ≥2, request_id uuid, reason text 1..500, actor_user_id, created_at, snapshot jsonb, closing_minor bigint, fingerprint text; UNIQUE(org_id,statement_id,version_no), UNIQUE(org_id,request_id); FK (org_id,statement_id) → owner_statements). Version 1 is the original `owner_statements` row (issued_at/issued_by) and is never copied or changed.
- `app.b014_report_delivery_events` (id, org_id, statement_id, version_id NULL = v1, request_id UNIQUE per org, channel `email`, result `accepted|delivered|failed|bounced`, adapter `mock`, actor_user_id, created_at).
- Both tables: RLS enabled, `REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role`; BEFORE UPDATE/DELETE/TRUNCATE triggers raise (append-only, history retained).
- Functions (all `SECURITY DEFINER SET search_path = pg_catalog, public, app`; `REVOKE ALL FROM PUBLIC, anon, authenticated, service_role`; `GRANT EXECUTE … TO authenticated`): `app.b014_flag_on(org,key)` (internal, not granted), `app.b014_payment_collectors`, `app.b014_record_statement_version`, `app.b014_statement_versions_for`, `app.b014_record_delivery_event`, `app.b014_delivery_events_for`. No new `public` function ⇒ `supabase/rpc-allowlist.txt` unchanged and `check-fn-privs` stays green.
- Old code on new schema: unaffected (new tables only; no column/constraint change on existing tables).

## 錢／權限風險（Class B）

Class B (money + owner-visible amounts). Review focus: (1) BigInt only — no `Number()` on any new amount path, SQL identity re-check in bigint; (2) cross-org: every RPC derives org from the statement row and requires `app.has_role(org,'{admin,accountant}')` for writes / `app.is_member` or `is_my_contact` for reads, and flag ON for that org; (3) replay/race: advisory lock per statement, `request_id` idempotency, identical replay returns the same id, different payload under the same request id ⇒ unavailable; (4) no double count: payouts counted once per transfer, reversals subtract, prepay draws reserved at 0 and never deducted from pending; deposits excluded (`is_deposit` payments and deposit lines are not in the statement calc); (5) owner sees only issued statements of their own contact.

## HITL／AFK

AFK for build. HITL later: activation (flag ON anywhere hosted), Q1 fee basis (billed/collected) — unchanged here: management fee keeps the existing rule applied to attributed rent.

## 驗證方式與可觀察證據

- Integration (`src/server/b014-owner-net-ledger.integration.test.ts`, disposable PG): seed org, flag OFF → `ownerNetLedgerView` null, record action `unavailable`, zero rows in both B-014 tables and unchanged financial facts; flag ON → fixtures: positive, zero, negative, cross-period (opening follows previous statement's latest version), transfer + reversal (history kept, totals reconcile), owner-direct lease (direct rent listed, not in closing), regenerate twice (v2, v3 kept; reason/actor/time present), replay same request id ⇒ same version, cross-org staff ⇒ unavailable, owner of another contact ⇒ no versions; delivery mock event appended only with `monthly_report_delivery` ON.
- Unit (`src/server/owner-net-ledger-rules.test.ts`): identity, negative flag, BigInt beyond 2^53.
- UI: manager and owner statement pages render the panel only when the view is non-null.

## 不做什麼

No real transfer/remittance, no bank file, no e-mail/LINE send, no change to `issueStatement`, `calculateStatement` semantics or the PDF when OFF, no `owner_prepayment` account, no PROP-MF-03 allocation, no change to B-011 or other merged rows.

## Assumptions (resolved conservatively; flag OFF)

1. Collector source = B-010 collector reservation (lease-level `app.b010_lease_collectors` + per-payment `confirmed_via` snapshot). Default `company` (= today's behavior "recorded as received by your manager").
2. Management fee basis unchanged (existing rule on attributed rent, Q1 open). Owner-direct rent therefore can make the company-side net negative; copy states it is not a payment request.
3. Prepay draws: no schema yet ⇒ snapshot field `prepay_draws_minor = "0"` with `reserved: true`; never deducted.
4. The PDF stays the original v1 document; version breakdown is on screen. (Negative-net copy on the existing PDF is the already approved 「本期淨額為負」.)

## Cross-review changes (Codex QA r1 FAIL → fixed)

1. Version amounts are recomputed from the raw integer strings with BigInt ports of the statement attribution and fee rules (`attributePaymentBig`, `managementFeeBig`; same semantics as `money.ts`, including `Math.round` half-up), never from `calculateStatement`'s `Number` totals.
2. Deposit-tagged payments are excluded before the management-fee basis is formed (the v1 statement keeps its original fee).
3. Transfers and reversals are attributed by the owner on the `owner_payable` entry; a reversal recorded after the property's ownership ended still counts in its own period.
4. A retry with a committed request id resolves through `app.b014_version_for_request` before any recalculation.
5. Writer RPCs re-check both flags through `app.b014_flag_locked` (`FOR SHARE` on the settings and organization rows) after their advisory locks; the server retries `40001` and then sees OFF.
6. 「本期淨額為負」 and its note follow the **period net** (`net < 0`), not the closing balance.
7. Every version keeps its own breakdown (expandable in the history table) and shows the staff display name (`profiles.display_name`), or 「管理方」 when no name is set.

## 開放問題（Ron／CEO，非阻塞）

1. Should a later version also produce a versioned PDF? (default: no until approved copy)
2. Fee basis for owner-direct rent (Q1 interview).

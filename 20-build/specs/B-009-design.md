
# B-009 Design Note — Bank CSV Dedupe & Manual Matching (JIT L2)

## 摘要 (zh-TW)

本設計補齊 B-009 剩餘範圍：為重送／重疊匯出的銀行 CSV 建立穩定的「列身分」(row identity) 去重，以及為人工配對／拒絕加入 **requestId 冪等**與**單一有效配對**保證。新增一支 migration（接在 B-008 之後）：建立 `app.b009_row_identities`（append-only、僅擁有者可寫）、於 `app.b009_decisions` 加入 `request_id`/`request_digest` 與相關唯一索引，並以**部分唯一索引**保證每筆銀行交易／每筆付款最多一個 `match`。列身分以 `sha256` 計算，含檔內相同列的出現序號 (ordinal)，使重疊／重排的重送只略過「已知列」而不產生重複建議，且不自動確認任何付款。旗標 `bank_matching` 維持 **OFF**；完成 (Done) 不等於啟用 (activation)，本次不啟用、不回填、不改寫既有資料。所有行為以 unit + schema + 一次性 PG 整合測試覆蓋並接入 `package.json`。

---

## Scope / Non-scope

**In scope**
- Stable per-row identity so overlapping/reordered CSV re-exports do not create duplicate suggestions or payments.
- Optional `requestId` idempotency for manual match/reject (replay-safe, conflict fail-closed).
- A DB-enforced guarantee of at most one effective `match` per bank transaction and per payment under concurrency.
- One idempotent migration, plus unit/schema/integration tests wired into the gate.

**Non-scope**
- No automatic banking access; import only ever **suggests**, never confirms payments.
- No silent resolution of ambiguous candidates (multiple/equal/no candidate ⇒ no financial state change).
- No flag activation, no backfill, no rewrite of existing `b009_file_imports` / `b009_decisions` / `bank_transactions` rows.
- No change to the legacy OFF screen, scoring, authorization, financial locks, or allocation logic.

---

## Data model

New migration: `supabase/migrations/20261106010000_b009_bank_match_decisions.sql` (ordered after B-008 `20261106000000`). Fully idempotent (`IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` / guarded `CREATE`), wrapped with `SET LOCAL lock_timeout='5s'` and `SET LOCAL statement_timeout='60s'`. No `UPDATE`/backfill statements.

### a. `app.b009_row_identities`
```sql
CREATE TABLE IF NOT EXISTS app.b009_row_identities (
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  bank_account_id uuid NOT NULL,
  row_key text NOT NULL CHECK (row_key ~ '^[0-9a-f]{64}$'),
  bank_transaction_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, bank_account_id, row_key),
  FOREIGN KEY (org_id, bank_account_id) REFERENCES public.bank_accounts(org_id, id),
  FOREIGN KEY (org_id, bank_transaction_id) REFERENCES public.bank_transactions(org_id, id)
);
REVOKE ALL ON app.b009_row_identities FROM PUBLIC, anon, authenticated, service_role;
```
Append-only: reuse `app.b009_decisions_immutable()` via `BEFORE UPDATE OR DELETE` (row) and `BEFORE TRUNCATE` (statement) triggers. The composite PK is the dedupe key; a known `row_key` means the row already produced a transaction and must be skipped on re-import.

### b. `app.b009_decisions` idempotency columns
```sql
ALTER TABLE app.b009_decisions
  ADD COLUMN IF NOT EXISTS request_id uuid,
  ADD COLUMN IF NOT EXISTS request_digest text;
-- both NULL or both set; digest is hex64
ALTER TABLE app.b009_decisions
  ADD CONSTRAINT b009_decisions_request_pair CHECK (
    (request_id IS NULL AND request_digest IS NULL) OR
    (request_id IS NOT NULL AND request_digest ~ '^[0-9a-f]{64}$'));
CREATE UNIQUE INDEX IF NOT EXISTS b009_decisions_request_uq
  ON app.b009_decisions (org_id, request_id) WHERE request_id IS NOT NULL;
```
Existing rows keep `NULL`/`NULL` — the `CHECK` and partial unique index tolerate them, so no rewrite is needed.

### c. Single-effective-match partial unique indexes
```sql
CREATE UNIQUE INDEX IF NOT EXISTS b009_one_match_per_bank_tx
  ON app.b009_decisions (org_id, bank_transaction_id) WHERE decision = 'match';
CREATE UNIQUE INDEX IF NOT EXISTS b009_one_match_per_payment
  ON app.b009_decisions (org_id, payment_id) WHERE decision = 'match' AND payment_id IS NOT NULL;
```

---

## Algorithms

### Row key (`b009-row-v1`)
`row_key = sha256(join('|', ['b009-row-v1', bankAccountId, dateIso, amountMinor, last5 ?? '', normMemo, ordinal]))` as lowercase hex.

- `normMemo`: NFKC, collapse internal whitespace to single space, trim, lowercase. Deterministic and encoding-independent after decode.
- `ordinal`: 0-based occurrence index of an otherwise-identical tuple **within the same parsed file**. Computed by scanning parsed rows in file order and incrementing a per-tuple counter. This keeps genuinely identical in-file rows distinct (each gets its own `row_key`).
- During import, for each parsed row compute `row_key` and attempt insert into `b009_row_identities`. If the key already exists (PK conflict) the row is **already known**: skip it, create no `bank_transaction`, create no suggestion, and increment `duplicateRows`. Otherwise insert the transaction (as today) then the identity row linking to it.
- Result: exact re-import ⇒ every row known ⇒ zero new rows. Overlapping/reordered re-export ⇒ previously-seen rows skipped, only genuinely new rows produce transactions+suggestions.

### Request digest
`request_digest = sha256(canonicalJson)` where canonical input = stable-key-ordered JSON of `{ bankId, paymentId ?? null, suggestionId ?? null, decision, reason }`. Numbers/ids serialized as strings; no whitespace. Digest is computed server-side from validated input, never trusted from the client.

---

## Service / API contract (`bm.ts`)

- `importBankFile(session, accountId, bytes, encoding, dateFormat)` — unchanged signature. Internals: after the existing exact-file-hash short-circuit, the per-row loop gains the `row_key` compute + identity insert/skip. Return shape extends to `{ importId, duplicate, duplicateRows }` (`duplicateRows` = count of skipped known rows; `0` for a wholly new file, equals row count for an exact overlap handled by file-hash path).
- `decideBankMatch(session, input)` — `input` gains optional `requestId?: string` (uuid). Behavior:
  - No `requestId`: current behavior, plus the decision insert now also satisfies the single-match indexes.
  - With `requestId`: compute digest; `SELECT ... FOR UPDATE`-style existence check on `(org_id, request_id)`; same id + same digest ⇒ **replay**: return the prior success, write nothing new; same id + different digest ⇒ **conflict**: `throw fail()` (fail-closed, no write).
- `bankBoard` / `bankMatchingEnabled` unchanged.

---

## Concurrency & idempotency

- Manual match keeps the existing bank row `FOR UPDATE` + payment `FOR UPDATE`. The new `b009_one_match_per_bank_tx` / `b009_one_match_per_payment` partial unique indexes make the decision insert the serialization point: two concurrent `Promise.all` approvals of the same bank tx or payment ⇒ exactly one commits, the loser hits a unique violation and is rolled back via `fail()`. No new effective match can slip past.
- Replay idempotency: the `(org_id, request_id)` unique index plus the explicit pre-insert lookup make retries safe; a racing duplicate insert of the same `request_id` also surfaces as a unique violation and is treated as replay on same-digest, conflict otherwise.
- Import dedupe: the `b009_row_identities` PK insert is the atomic skip/claim; advisory lock on `org:account:file-hash` (existing) still serializes same-file imports, and the PK serializes same-row claims across different files.

---

## Security / RLS

- `app.b009_row_identities` has `REVOKE ALL` from `PUBLIC, anon, authenticated, service_role`; writable only by the table owner (the audited server path / migrations). Composite FKs pin every row to its org + account + transaction, so cross-org or cross-account references cannot be inserted.
- `app.b009_decisions` new columns inherit the existing REVOKE posture and append-only triggers; idempotency metadata cannot be mutated after insert.
- The existing `app.b009_direct_write_guard` on `bank_*`/`payments` is unchanged; when the flag is ON only the audited server path may mutate matching state.
- `authorize()` still requires `staff` + `admin|accountant` + live (non-sandbox) session, with sandbox mapped to the live org. Cross-org and cross-env access is denied before any read/write.

---

## Flag gating

- `platform_settings.bank_matching` stays `{"enabled":false,"allowed_org_ids":[]}`; org `feature_flags.bank_matching` not set. With the flag OFF, `authorize()` returns false ⇒ import/decide return `null` and perform **zero writes** (operation rolls back before `fn`).
- `bankMatchingEnabled` continues to distinguish an enabled-but-unavailable gateway from the legacy OFF screen; the OFF screen is untouched.
- **Done ≠ activation.** Shipping this migration + code does not enable any org. Activation is a separate, owner-gated settings change out of scope here.

---

## Test plan

**Unit** (`test:unit`):
- `row_key`: ordinal distinguishes identical in-file rows; memo normalization; stable hex64; overlap/reorder produces the same keys for the same logical rows.
- `request_digest`: canonicalization is key-order independent; differing inputs ⇒ differing digests.

**Schema test**: asserts table, columns, CHECKs, REVOKEs, triggers, and the three partial unique indexes exist with expected predicates; asserts idempotent re-run is a no-op.

**Disposable-PG integration** `src/server/b009-bank-match-decisions.integration.test.ts` (`test:rls`):
1. Exact re-import ⇒ no new rows (file-hash path); overlapping/reordered re-import ⇒ known rows skipped (`duplicateRows`), only new rows create transactions+suggestions.
2. Multiple / equal / no candidate ⇒ suggestions only, no payment confirmed, no financial state change.
3. Manual match and reject ⇒ actor, reason, source retained in append-only `b009_decisions`.
4. `Promise.all` concurrent approval of one bank tx (and of one payment) ⇒ exactly one effective `match`.
5. `requestId` replay (same id + digest ⇒ success, no new write) and conflict (same id + different digest ⇒ fail, no write).
6. Cross-org and cross-env denial.
7. Flag OFF ⇒ null/disabled response, zero writes.

Wire all new suites into `package.json` `test:unit` (unit) and `test:rls` (schema + integration). Sanitized regional CSV fixtures and concurrency/cross-org evidence land under `/workspace/e2e/results/B-009/`.

---

## Rollback

- Migration is additive and idempotent; rollback = drop `app.b009_row_identities`, drop the three indexes, and drop the two added columns + CHECK. No data rewrite occurred, so rollback restores the exact prior schema. Existing decisions (NULL request columns) are already valid without them.
- Code path is flag-gated OFF; reverting `bm.ts` has no production effect because no org is activated.

---

## Open risks

- **Memo normalization drift**: banks that mutate memo text between exports can defeat row-key dedupe, falling back to manual review (acceptable, documented). Overlapping re-exports with no stable source IDs still rely on the date+amount+last5+memo tuple.
- **Ordinal sensitivity**: if a re-export genuinely adds/removes an identical-tuple row mid-sequence, ordinals shift and the row may be treated as new; this over-suggests rather than under-dedupes, which is the safe direction (no auto-confirm).
- **CSV bytes not archived**: only metadata/hash retained; provenance review of de-identified real CSVs remains UNVERIFIED pending acceptance.
- **No global deadlock-freedom claim**; lock order (bank tx → payment → decision insert) matches existing code to minimize risk.

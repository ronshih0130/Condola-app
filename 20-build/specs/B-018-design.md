# B-018 — JIT L2 設計稿：租客付款紀錄、首頁狀態與每月應繳總額（FR-Q6-01）

> Author: Claude (Mac overnight, 2026-11-06 PT). Layer-2 design for hub `20-build/specs/B-018.md`, including **FR-Q6-01** (Ron P0 2026-11-05: tenant monthly total due incl. utilities and 代墊 offsets; display/record only), **PROP-MF-B018** (show components when present; full net needs the UC2 tenant credit state machine) and **PROP-US-v03-03** (CAP-T-17 credit write path is a separate additive migration handoff — not in this row). Branch `feat/b-018-tenant-monthly-due` is cut from B-014 (`6865f0d`); B-018 does not depend on B-014/B-022 code (hard deps B-003, B-010 are in the stack).

## 使用者故事／能力 ID

- Covered: TEN-07/08, CAP-T-04 (payment history: original amount/date, decision/reason — existing `tenant_payment_history` lane), CAP-T-09 (home/pay status agree), **CAP-T-16 / FR-Q6-01** (monthly total due with explicit component sources).
- Not covered: CAP-T-17 tenant advance request/approval (needs the `expenses` CHECK relaxation handoff, UC2), payment rails, claiming a report proves receipt.

## Done means

With `tenant_payment_history` ON for a local test org, a tenant on `/t` sees, per billing month, 「每月應繳總額」 and on `/t/pay` the components behind it — rent, utilities, other charges and credits (incl. 代墊 already on the bill), confirmed payments — each labelled with its source (bill number + item number); the totals equal the existing bill balance; an excess credit shows 0 due plus a carry note, never a negative claim. Flag OFF: `/t` and `/t/pay` unchanged.

## Calculation source and every component (FR-Q6-01 requirement)

Source = **open / partially_paid invoices of the selected lease** (already read by `tenantPaymentHistory` after tenant/session/lease admission) and their `invoice_lines`:

| Component | Source rows | Rule |
|---|---|---|
| 租金 rent | `invoice_lines.charge_type='rent'` (B-008 monthly rent writer / existing billing) | + amount |
| 水電 utility | `charge_type='utility'` (posted utility runs, B-008 utility preview path) | + amount |
| 押金 deposit | `charge_type='deposit'` (B-011 settlement lines when billed) | + amount |
| 其他費用 other | `add_on`, `late_fee`, `one_off`, `maintenance` (PROP-11 tenant-borne repair cost when billed) | + amount |
| 抵扣（含代墊） offset | any line with `amount_minor < 0` (`credit`, 沖銷電費, vendor-advance credit lines once B-010/PROP-11 post them) | − amount |
| 已確認繳款 paid | `invoices.paid_minor` (confirmed payments allocated by the existing allocator, B-010) | − amount |

Period = `invoices.period_start` month, else `due_date` month. `應繳總額 = max(0, gross − offset − paid)`, `carry = max(0, offset + paid − gross)` (B-008 `assertNoNegativeClaim`). All arithmetic in BigInt from the raw integer strings (`src/server/tenant-monthly-due-rules.ts`); the sum of `due − carry` over periods equals the existing `bill.balanceMinor` (integration-tested). Mixed currencies fail closed.

## 資料表與 RLS

No migration. Reads stay inside the existing authorized tenant read (`tenantPaymentHistory`: tenant session + lease party + flag decided before any lease lookup). Added columns to the existing line query: `invoice_lines.line_no`, `invoices.invoice_number`.

## 錢／權限風險

Money display only (Class B review of correctness): BigInt, no negative claim, no write path, another tenant's lease still denied by the existing admission (unchanged).

## 驗證方式

- Unit `src/server/tenant-monthly-due-rules.test.ts`: rent + utility − 代墊 − paid, carry when offsets exceed charges, period split, exact beyond 2^53, invalid/mixed-currency rejection.
- Integration (existing `tenant-payment-history.integration.test.ts` + new FR-Q6-01 case): components and sources for one invoice, totals equal the bill balance.

## 不做什麼

No tenant credit request/approval (CAP-T-17), no change to payment reporting, no new flag, no copy implying Condola handles money (copy: 「Condola 只顯示紀錄，不經手任何款項」).

## Assumptions

1. 代墊 offsets count only when they already appear as negative invoice lines; pending/unapproved advances are not shown (UC2 not built).
2. Deposit lines on an open invoice are part of what the tenant owes for that bill and are shown as their own component.

## Cross-review changes (Codex QA r1 FAIL → fixed → r2 PASS)

1. Excess copy no longer promises next-period application: it states the excess is not part of this month's total and is not applied to other months automatically, and a note says each month is calculated separately and the current outstanding balance is the amount actually open.
2. Confirmed payments keep their per-invoice source (`payments: [{invoiceNumber, paidMinor}]`) and render per bill, with an aggregate line when there is more than one.

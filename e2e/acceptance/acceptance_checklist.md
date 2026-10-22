Class A = pure logic, money, or copy; deterministic unit-testable. Class B = requires app, DB, RBAC, feature flags, migration, or deployment. Settlement integration is always Class B (payment R22). Every Class B row requires PM QA manual sign-off, including rows with automated coverage.

Sources: PAY = payment_records_spec_v1.md (sha256 81c4b4a3); UI = ui_copy_flows_v1.md (sha256 2229c085); PRC = pricing_rules_v1.md; BAN = banned_terms.md (sha256 3ff8df7d, allowlist read by copy-banned-terms.spec.ts). Paths in the Test file column are under `tests/`. “Manual” means no automated acceptance claim is made.

| ID | Source | Class | Given / When / Then | Auto/Manual | Test file |
|---|---|---|---|---|---|
| PAY-01 | PAY R4, D14, D18; UI P03 | B | Given registration form; when opened; then lease, type, period, positive amount, date, optional account suffix and notes are available. | Auto + Manual | payments.e2e.spec.ts |
| PAY-02 | PAY AC1; UI P04 | B | Given missing lease/type/period and zero amount; when submitted; then exact field errors and brief-required error summary appear and nothing is saved. | Auto + Manual | payments.e2e.spec.ts |
| PAY-03 | PAY R4, AC1 | A | Given business date; when payment date is today/tomorrow; then today accepted and tomorrow rejected. | Auto | money.spec.ts |
| PAY-04 | PAY R5, AC2; UI P01/P03 | A | Given 18,000 bill; when paid 10,000 then 8,000; then 部分付款/8,000 remaining then 已繳清/0. | Auto | money.spec.ts |
| PAY-05 | PAY D18 | A | Given August/September unpaid 18,000 bills supplied out of order; when paid 25,000; then August clears and September has 11,000 remaining. | Auto | money.spec.ts |
| PAY-06 | PAY R6, D3, AC3; UI P04 | B | Given identical lease/amount/date; when another payment saved; then exact duplicate hint appears and save succeeds. | Auto + Manual | payments.e2e.spec.ts |
| PAY-07 | PAY R7, D4, AC4; UI P05 | B | Given registered payment; when viewed/reversed; then edit/delete absent, reason required, original retained with 已撤銷 and reason, bill recalculated. | Auto + Manual | payments.e2e.spec.ts |
| PAY-08 | PAY R9, AC4 | B | Given registration/reversal/manual amount override; when committed; then exactly one audit entry per action includes actor/time/before/after/reason. | Manual | payments.e2e.spec.ts; moveout.e2e.spec.ts |
| PAY-09 | PAY R9a, D13; UI P01 | B | Given tenant report 待確認; when 確認登記 or 不登記 chosen; then status changes appropriately and report is retained. | Manual | payments.e2e.spec.ts |
| PAY-10 | PAY R9b, D15, AC16; UI P10 | B | Given readonly unit; when admin records/reverses; then both succeed, exact banner appears, unit/lease edits disabled. | Auto + Manual | payments.e2e.spec.ts |
| PAY-11 | PAY D21; UI P01/P07 | B | Given payments to each recipient; when recorded/viewed; then 付款對象 persists per payment and statement lists recipients separately. | Auto + Manual | payments.e2e.spec.ts; settlement.e2e.spec.ts |
| PAY-12 | PAY D22, R10 | A | Given lease due-day setting; when 1/28/0/29/undefined supplied; then valid/valid/invalid/invalid/default 5. | Auto | money.spec.ts |
| PAY-13 | PAY R10, AC6; UI P01 | B | Given unpaid October 5 bill and October 6 business date; when viewed; then 未繳租金 and 到期 10/05・已逾期 1 天 appear. | Auto + Manual | payments.e2e.spec.ts |
| PAY-14 | PAY R10, D9 | A | Given October 5 due date; when today October 5/6/12; then overdue days 0/1/7. | Auto | money.spec.ts |
| PAY-15 | PAY R11, AC6 | B | Given tenant home; when loaded; then first card line is 應繳合計 NT$x,xxx followed by details. | Manual | payments.e2e.spec.ts |
| PAY-16 | PAY R12, D8, AC11; UI L04 | B | Given eligible reminders; when due −3/0/+3 or lease −60/−30 days; then each sent once, text/link only, no name/amount/address. | Manual | copy-banned-terms.spec.ts |
| PAY-17 | PAY R3 | B | Given authorized manager/owner; when navigating; then /m/payments, /m/statements and readonly /o/statements work. | Auto + Manual | payments.e2e.spec.ts; settlement.e2e.spec.ts |
| STL-01 | PAY D11; UI P07/P08 | B | Given QA屋主甲 October 2026 statement; when opened; then title is QA屋主甲・2026年10月 屋主租金結算明細. | Auto + Manual | settlement.e2e.spec.ts |
| STL-02 | PAY R13–R14, D2, AC8 | B | Given statement; when rendered; then unit rent/unpaid/expenses and 管理公司匯給屋主/期初餘額/期末餘額 are shown. | Auto + Manual | settlement.e2e.spec.ts |
| STL-03 | PAY R13, AC8 | B | Given 36,000 deposit; when statement calculated; then deposit separately shown and excluded from net. | Auto + Manual | settlement.e2e.spec.ts |
| STL-04 | PAY D20 | A | Given opening 5,000, handled rent 36,000, expenses 4,200, payouts 30,000; when calculated; then closing 6,800 and next opening 6,800. | Auto | money.spec.ts |
| STL-05 | PAY D20–D21, D25 | A | Given owner/company rent and deposit; when handled rent calculated; then only rent with 付款對象 = 管理公司 counts; deposits excluded. | Auto | money.spec.ts |
| STL-06 | PAY R15, D12; UI P08 | B | Given net −3,300; when viewed; then 本期淨額為負 and exact warning appear, without implying owner debt. | Auto + Manual | settlement.e2e.spec.ts |
| STL-07 | PAY R16, D5, AC7; UI P11 | B | Given generated statement; when underlying payment reversed; then 已變更, 修改紀錄, 修改前內容 and regeneration preserve original/version history. | Auto + Manual | settlement.e2e.spec.ts |
| STL-08 | PAY D19 | B | Given v1 statement; when viewed/exported; then vacant/unleased electricity excluded. | Auto + Manual | settlement.e2e.spec.ts |
| STL-09 | PAY R17, AC12; UI P07 footer | B | Given statement/PDF/export; when inspected; then no prohibited tax/platform terms and footer disclaimer present. | Auto + Manual | settlement.e2e.spec.ts; copy-banned-terms.spec.ts |
| STL-10 | PAY D20 | B | Given manager; when manually recording payout; then persisted payout changes closing and carries into next opening. | Manual | settlement.e2e.spec.ts |
| MO-01 | PAY R18, D6, D23, AC9 | A | Given October 1–12 inclusive; when prorated; then 12 days and integer NT$7,200; all brief examples match half-up rounding. | Auto | money.spec.ts |
| MO-02 | PAY D23, D24 | A | Given 12,975/30 for one day; when rounded once at the end; then half-up 433. | Auto | money.spec.ts |
| MO-03 | PAY R18, D24 | A | Given 31 days at 18,000; when prorated; then capped at one month's rent: 18,000 (uncapped would be 18,600). | Auto | money.spec.ts |
| MO-04 | UI R04/R07; PAY AC9 | B | Given moveout; when calculated; then NT$18,000 ÷ 30 × 12 天 ＝ NT$7,200 shown. | Auto + Manual | moveout.e2e.spec.ts |
| MO-05 | PAY R19, AC9; UI R04 supplement | B | Given manual override; when saved; then actor/time badge and 原金額 NT$7,200，已改為 NT$7,000 shown; audit entry recorded. | Auto + Manual | moveout.e2e.spec.ts |
| MO-06 | PAY R20, AC10; UI R06 | A | Given deposit 36,000 and deductions 38,500/equal 36,000; when calculated; then shortfall 2,500/equal no warning and refund 0. | Auto | money.spec.ts |
| MO-07 | PAY R20; UI R06 | B | Given shortfall 2,500; when settling; then 押金不足扣抵 and 扣款超過押金，租客還需補付 NT$2,500 appear. | Auto + Manual | moveout.e2e.spec.ts |
| PERM-01 | PAY §6, P05 | B | Given manager/owner/tenant; when recording; then allow/deny/deny. | Manual | payments.e2e.spec.ts |
| PERM-02 | PAY §6, R7; UI P05 | B | Given admin/accountant/other manager/owner/tenant; when reversing; then allow/allow/deny/deny/deny with exact permission hint. | Auto + Manual | payments.e2e.spec.ts |
| PERM-03 | PAY §6 | B | Given manager/owner/tenant; when manually editing moveout amount; then allow/deny/deny. | Manual | moveout.e2e.spec.ts |
| PERM-04 | PAY §6, AC13 | B | Given manager/owner/tenant; when viewing payment records; then own organization/own properties/own lease only. | Manual | payments.e2e.spec.ts |
| PERM-05 | PAY §6 | B | Given manager/owner/tenant; when generating statement; then allow/deny/deny. | Manual | settlement.e2e.spec.ts |
| PERM-06 | PAY §6, AC13 | B | Given manager/owner/tenant; when viewing statements; then organization/own only/deny. | Auto + Manual | settlement.e2e.spec.ts |
| PERM-07 | PAY §6 | B | Given manager/owner/tenant; when viewing audit; then allow/deny/deny. | Manual | payments.e2e.spec.ts |
| PERM-08 | PAY §6, D26; UI P01 | B | Given admin/accountant/other manager/owner/tenant; when confirming (確認登記) or declining (不登記) a tenant-reported pending payment; then allow/allow/deny/deny/deny. | Manual | payments.e2e.spec.ts |
| SEC-01 | PAY R8, R21, AC5 | B | Given org A JWT and org B record; when either reversal overload or audit_event called; then 42501. | Auto + Manual | rpc-security.spec.ts |
| SEC-02 | PAY R8, AC5 | B | Given nonexistent ID; when either reversal overload or audit_event called; then not found, never 42501. | Auto + Manual | rpc-security.spec.ts |
| SEC-03 | PAY R21, AC5 | B | Given org A session; when org B page opened; then HTTP 404. | Auto + Manual | settlement.e2e.spec.ts |
| SEC-04 | PAY R21 | B | Given anon; when either reversal overload/audit_event called; then EXECUTE denied. | Auto + Manual | rpc-security.spec.ts |
| SEC-05 | PAY R21a, D16, AC15 | B | Given anon/authenticated; when either fn_invoice_* invoked; then EXECUTE denied; migration grants/revokes verified. | Auto + Manual | rpc-security.spec.ts |
| SEC-06 | PAY R22, D10, AC14 | B | Given flag off; when routes/navigation opened; then feature unavailable; deployment uses slot and complete PM QA. | Manual | settlement.e2e.spec.ts |
| COPY-01 | PAY R1–R2, D1, D17; UI global | A | Given global disclaimer; when rendered; then exact approved text and no platform custody implication. | Auto | copy-banned-terms.spec.ts |
| COPY-02 | PAY R23, AC12; BAN | A | Given source text; when whitelist sentences removed before scanning; then banned terms yield zero violations. | Auto | copy-banned-terms.spec.ts |
| COPY-03 | PAY R23; BAN (3ff8df7d) | A | Given 已收到 and 不開立統一發票 in the banned_terms.md allowlist; when scanned; then zero violations, while bare 已收 still flagged. Allowlist/banned list loaded from banned_terms.md. | Auto | copy-banned-terms.spec.ts |
| COPY-04 | PAY R24; UI P04 | B | Given final UI copy; when PMk reviews; then resolve competing required-field summaries; brief-required summary remains asserted pending decision. | Manual | payments.e2e.spec.ts |
| COPY-05 | UI supplement; PAY R23 | A | Given money/period/formula strings; when formatted; then commas, U+2212 minus, Chinese UI month, exact approved strings match. | Auto | money.spec.ts; copy-banned-terms.spec.ts |
| COPY-06 | BAN notes | B | Given tenant-facing UI/PDF/export; when manually reviewed; then tenants never described as 已驗證/verified. | Manual | copy-banned-terms.spec.ts |
| PRC-01 | PRC R1–R2, AC1–AC2 | A | Given free/std/pro and unit counts; when monthly quoted; then all brief exact totals match. | Auto | pricing.spec.ts |
| PRC-02 | PRC R3, AC1 | A | Given plan; when trial eligibility displayed; then paid plans offer three months, free does not. | Auto | pricing.spec.ts |
| PRC-03 | PRC R4, AC3, D8 | A | Given annual quote; when std 30/150/free; then 8,580/48,180/no annual discount; no partner price. | Auto | pricing.spec.ts |
| PRC-04 | PRC R5, AC4 | A | Given std 501; when quoted; then 14,910 monthly with no tier discount. | Auto | pricing.spec.ts |
| PRC-05 | PRC R6, AC10 | A | Given free/std/pro; when seat limits checked; then 1/5/unlimited and invite disabled at finite limit. | Auto | pricing.spec.ts |
| PRC-06 | PRC R7, AC5, D5 | A | Given midperiod increase/decrease; when scheduled; then current amount unchanged, next-period billing, increase usable immediately, decrease no refund. | Auto | pricing.spec.ts |
| PRC-07 | PRC R8–R9, AC7, D1–D2 | B | Given >4 after trial; when grace expires day 31; then oldest four editable by default, admin can change selection, other unit/lease/bill/reminder edits disabled; records retained, scheduled bills sent, tenant unaffected. | Manual | pricing.spec.ts |
| PRC-08 | PRC R10, AC6, D9 | A | Given trial reminders with trial end derived from TRIAL_MODE (calendar_months default \| days_90; pending Ron 10/22 18:30); when end−14/end−7 reached repeatedly; then once each; activation <14 days only seven-day reminder; Email/in-app, LINE gated. | Auto | pricing.spec.ts |
| PRC-09 | PRC R11, AC8, D7 | A | Given trial end derived from TRIAL_MODE; when annual starts; then day after trial end for 12 months; trial costs zero. Trial-length definition pending Ron 10/22 18:30. | Auto | pricing.spec.ts |
| PRC-10 | PRC AC9, D7 | A | Given used/active trial (end derived from TRIAL_MODE); when plan/billing switched; then end unchanged, annual start = end + 1 day, trial never restarts. | Auto | pricing.spec.ts |
| PRC-11 | PRC AC11 | A | Given pricing copy; when scanned/formatted; then 屋主, NT$x,xxx and no banned/tax terms. | Auto | copy-banned-terms.spec.ts |
| PRC-12 | PRC AC12, D4 | B | Given downgrade over seats; when 30-day grace/day31/upgrade; then all active during grace, admin plus earliest/selected kept, others disabled not deleted, upgrade restores. | Manual | pricing.spec.ts |
| PRC-13 | PRC D3 | B | Given pricing FAQ; when published; then matches 30-day grace and readonly rule. | Manual | copy-banned-terms.spec.ts |
| PRC-14 | PRC D6 | A | Given trial-end billing snapshot; when counted; then effective leases on last trial day determine units. | Auto | pricing.spec.ts |
| PRC-15 | PRC D8 | A | Given partner context; when quoted; then same public prices and discount only for paid annual plans. | Auto | pricing.spec.ts |
| PRC-16 | PRC Q7; UI S14 | B | Given annual midyear unit increase; when shown; then billing 待定 and no invented amount. | Manual | pricing.spec.ts |
| PRC-17 | PRC AC1, AC10; UI S1/S18 | B | Given selector/seats full; when viewed; then three plans, prices/seats/trial labels and disabled invite with upgrade prompt render correctly. | Manual | pricing.spec.ts |


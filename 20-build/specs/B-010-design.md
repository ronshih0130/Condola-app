# B-010 — JIT L2 設計稿：租金提醒與付款決策（含代屋主確認收款預留）

## 摘要（zh-TW）

B-010 處理三條主線：**(a) 租金提醒排程/手動觸發與抑制**、**(b) 付款確認/拒絕/沖正的結果事件（dedupe + source metadata）**、**(c) PROP-US-v03-04 / CAP-M-35「代屋主確認收款」的 additive 預留**。本稿在既有 `src/server/payment-result-events.ts`、`domain.ts`、`reminder-foundation.ts` 之上補齊缺口，不改寫既有冪等路徑。

三件待補重點：

1. **提醒**：驗證 paid/terminated 租約之抑制、重跑僅產生一個 claim、時區/DST 正確；對 B-028 補一個**可 mock 的 delivery adapter 介面型別**（傳輸細節留給 B-028，本 row 只定義契約）。
2. **付款結果事件**：補 dedupe 與 source metadata；拒絕/沖正強制**授權 + 理由**，且**保留原始紀錄**（append-only，不就地覆寫）。
3. **collector 預留**：新增私有表 `app.b010_lease_collectors`（`lease → collector in ('management','owner') + owner_contact_id`，缺省 `management`）與 append-only 稽核表 `app.b010_payment_confirmations`。`collector=owner` 時屋主本人或管理方皆可確認；管理方須 `proxyOwnerConfirmed=true`（UI popup「代屋主確認收款」），寫稽核且屋主讀模型可見。**代確認不改 collector**。

**全部以 `payment_results_v2` 旗標 OFF gate；OFF 時零寫入。** 新增 migration：`20261106020000_b010_payment_result_events.sql`。

> **邊界重申**：回報 ≠ 確認；代屋主確認 ≠ repair approval；**不重開 B-013**（已 QA PASS）。BUILD-ORDER 不動、不新開 B、不翻旗標。

---

## Scope

- **提醒抑制與冪等**
  - 確認 `reminder-foundation.ts::reminderEligible` 對 **paid/terminated** 租約回傳不合格（active lease、未終止、狀態 open/partially_paid、balance>0）。
  - 確認重跑（排程 + 手動）在 `reminders.ts` 的 `ClaimStore` 下只產生**一個** event claim（以 `occurrenceKey` + lease 去重）。
  - 確認時區/DST：`planScheduledReminder` 以租約時區的 local date 計算 occurrence，跨 DST 不產生漏/重。
- **付款結果事件**
  - 為 `emitPaymentResult`（`app.b010_emit_payment_event`）補 **dedupe key** 與 **source metadata**（來源、觸發者、command 關聯）。
  - `rejectPayment` / `reversePayment`：強制授權檢查 + 必填理由；**原始付款與原事件保留**，新增沖正/拒絕事件為 append。
  - partial payment 確認維持 oldest-first 配置（`lockAllocationInvoices` `ORDER BY due_date, created_at, id` 已符合）。
- **collector additive 預留（CAP-M-35）**
  - 新增 `app.b010_lease_collectors`、`app.b010_payment_confirmations`。
  - 確認路徑支援 `owner_direct` 與 `staff_proxy`（後者需 `proxyOwnerConfirmed=true`）。
  - `payment_id UNIQUE` 防同筆重複/並發重入帳。
  - 屋主讀模型可見代確認紀錄。
- **交付契約**：為 B-028 定義 `ReminderDeliveryAdapter` 介面型別（含 mock 實作對應 `local-reminder-capture.ts`）。

## Non-scope

- 真實 Email/LINE 傳輸、實際收款金流（B-028 承接傳輸）。
- 變更 collector 的 UI 流程（本 row 僅預留欄位；指派 collector 的管理面不在此）。
- 重開/掛載 B-013、B-002/B-003/B-007/B-011/PROP-01b/PROP-10/PROP-11。
- CAP-M-11 acceptance 的實作改動（本稿僅摺入語意，不新建 flag）。
- 翻旗標或改 BUILD-ORDER。

---

## Data model（migration `20261106020000_b010_payment_result_events.sql`）

所有新物件置於 `app` schema（私有、RLS 比照既有 b010 私有表）。**所有寫入由 `payment_results_v2` gate，OFF 時路徑完全不觸及這些表。**

### 1. `app.b010_lease_collectors`（collector 預留）

| 欄位 | 型別 | 說明 |
|---|---|---|
| `lease_id` | uuid PK, FK → leases | 一租約一列 |
| `collector` | text NOT NULL, CHECK in (`'management'`,`'owner'`) DEFAULT `'management'` | 缺省 management |
| `owner_contact_id` | uuid NULL, FK → contacts | `collector='owner'` 時應存在；以 CHECK 約束 `collector='owner' → owner_contact_id IS NOT NULL` |
| `created_at` / `updated_at` | timestamptz | 稽核 |

- **不改既有** `leases.payee_bank_account_id`；本表為 additive。
- 缺省語意：無列或 `collector='management'` 皆視為 management 收款。

### 2. `app.b010_payment_confirmations`（append-only 稽核）

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | uuid PK | |
| `payment_id` | uuid NOT NULL **UNIQUE** | 防同筆重複確認/並發重入帳的核心不變量 |
| `actor_user_id` | uuid NOT NULL | 操作者 |
| `on_behalf_of_owner_contact_id` | uuid NULL | 代理對象（`staff_proxy` 時必填，`owner_direct` 時 NULL） |
| `confirmed_via` | text NOT NULL, CHECK in (`'owner_direct'`,`'staff_proxy'`) | 確認途徑 |
| `source` | text NOT NULL | source metadata（UI/API/job） |
| `from_status` / `to_status` | text NOT NULL | 狀態變更 |
| `created_at` | timestamptz NOT NULL DEFAULT now() | |

- **Append-only**：僅 INSERT，無 UPDATE/DELETE（以權限 + trigger 阻擋）。
- `payment_id UNIQUE`：並發兩筆確認時，第二筆 INSERT 衝突 → 於交易內轉為冪等拒絕，不重複入帳。
- CHECK：`confirmed_via='staff_proxy' → on_behalf_of_owner_contact_id IS NOT NULL`。
- 屋主讀模型 view 由 `on_behalf_of_owner_contact_id` 關聯，令屋主可見代確認。

### 3. 付款結果事件 dedupe/source metadata

於既有 `app.b010_emit_payment_event` 相關表補：
- `dedupe_key` text（例：`payment_id + result_kind + command_id`）唯一索引，重跑/重試只留一次有效事件。
- source metadata 欄位：`source`、`triggered_by_user_id`、`origin_command_id`（關聯 `app.b010_payment_commands`）。
- 沖正/拒絕事件為新列 append，`from_status`/`to_status`、`reason` 必填；原事件與原付款紀錄不被就地修改。

---

## Server modules

- **`src/server/payment-result-events.ts`（擴充）**
  - `emitPaymentResult`：加入 `dedupe_key` + source metadata，重複呼叫冪等（已存在 dedupe_key → 回傳既有事件 id，不新增）。
  - `lockPaymentResultContext`：沿用 `app.b010_lock_payment_context` 行鎖，確保確認/沖正序列化。
- **`domain.ts`（擴充）**
  - `confirmPayment(input)`：
    - 讀 `app.b010_lease_collectors` 決定 collector。
    - `collector='owner'`：屋主本人 → `confirmed_via='owner_direct'`，無 popup；管理方 → 要求 `proxyOwnerConfirmed=true`，否則擲授權錯誤，通過則 `confirmed_via='staff_proxy'` 且帶 `on_behalf_of_owner_contact_id`。
    - 寫 `app.b010_payment_confirmations`（UNIQUE payment_id）→ 已 confirmed 時維持既有冪等返回。
    - 配置維持 `lockAllocationInvoices` oldest-first。
  - `rejectPayment` / `reversePayment`：強制授權 + 必填 `reason`；append 新事件，保留原紀錄。
- **`reminder-foundation.ts` / `reminders.ts` / `manual-reminders.ts`（驗證，無行為改動）**
  - 確認 paid/terminated 抑制、單一 claim、時區/DST 既有邏輯正確，補測試覆蓋。
- **B-028 delivery adapter 介面型別（新）**

```ts
// 可 mock 的交付契約；B-028 提供真實傳輸，本 row 僅定義型別 + mock
export interface ReminderDeliveryRequest {
  reminderEventId: string;
  leaseId: string;
  channel: 'email' | 'line';
  occurrenceKey: string;
  templateId: string;      // CAP-M-09/11 / brand-v2
  payload: Record<string, unknown>;
}

export interface ReminderDeliveryResult {
  reminderEventId: string;
  delivered: boolean;
  providerRef?: string;    // 傳輸層回執，mock 下為本地擷取 id
}

export interface ReminderDeliveryAdapter {
  deliver(req: ReminderDeliveryRequest): Promise<ReminderDeliveryResult>;
}
```
  - mock 實作綁 `local-reminder-capture.ts`，落地 `/workspace/e2e/results/B-010/`。

---

## Flag gating

- 單一旗標 **`payment_results_v2`**（`ops/flags.yaml`：`platform_settings.enabled` + `allowed_org_ids` + `organizations.feature_flags`）。
- **不新增** `rent_email_reminders` / `payment_review_results` key；提醒沿用既有 `reminder-foundation` / `overdue-schedule` 旗標。
- **OFF = 零寫入**：`confirmPayment`/`rejectPayment`/`reversePayment`/`emitPaymentResult` 在 flag OFF 時走既有未啟用路徑，**不觸及** `b010_lease_collectors`、`b010_payment_confirmations` 及新 dedupe 欄位。
- collector 預留在 OFF 下亦不讀不寫，缺省語意（management）不生效到新稽核表。

---

## Tests

- **Unit**（`test:unit`）
  - `reminderEligible`：paid / terminated / balance=0 → 不合格。
  - 重跑排程 + 手動：同 `occurrenceKey` 只產生一 claim。
  - 時區/DST：跨 DST 邊界 local date 不漏不重。
  - delivery adapter：mock `deliver` 冪等、重試不重複擷取。
- **Schema test**：`b010_lease_collectors` CHECK（owner→owner_contact_id）、`b010_payment_confirmations` UNIQUE(payment_id) 與 append-only trigger。
- **Disposable PG integration**（`src/server/b010-payment-decisions.integration.test.ts`，`test:rls`）
  - collector=owner：屋主直收（無 popup）vs 管理方 `proxyOwnerConfirmed=true` 代確認（staff_proxy + on_behalf_of）。
  - 管理方缺 `proxyOwnerConfirmed` → 授權拒絕。
  - 同筆並發/重試確認 → UNIQUE 衝突 → 只留一次有效確認、不重複入帳。
  - reject/reverse：缺授權或缺理由 → 拒絕；通過後原紀錄保留、新事件 append。
  - 屋主讀模型：可見代確認且狀態同步、不得重複確認同筆。
  - partial payment：oldest eligible bills 先配置。
  - **flag OFF**：以上路徑零寫入（斷言新表列數為 0）。
- **Wiring**：註冊於 `scripts/write-pr-migrations.mjs`、`lease-rules.test.ts` migration 清單、`seed.ts` wipe；evidence 落 `/workspace/e2e/results/B-010/`。

---

## Risks / LPQ

- **LPQ-1**：`collector=owner` 但 `owner_contact_id` 指向的 contact 與租約屋主不一致時，誰為「屋主本人」判定來源？暫以 contact ↔ user 對應判定，待確認映射表。
- **LPQ-2**：`proxyOwnerConfirmed` 由前端傳入 vs 後端二次驗證管理方角色——後端必須再驗角色，不可只信 UI flag（已納入授權檢查）。
- **LPQ-3**：dedupe_key 組成是否需含 org/時窗以避免跨租約碰撞？目前以 `payment_id + result_kind + command_id`，待審。
- **Risk**：DST 以租約時區 local date 計算，若租約時區資料缺失需 fallback（org 時區），列為測試邊界。
- **Risk**：append-only 以權限 + trigger 雙重阻擋 UPDATE/DELETE；需確認 RLS 不被 service role 繞過。
- **邊界守恆**：回報 ≠ 確認；代屋主確認 ≠ repair approval；不重開 B-013；代確認不改 collector。

---

## Done ≠ 啟用

- 本 row「Done」指：migration、表/約束、server 邏輯、介面型別、測試與 evidence 全數合入且綠燈。
- **啟用由 Ron 決定**：`payment_results_v2` 維持 **OFF**；合入後行為對使用者不可見，OFF 下零寫入、缺省收款語意（management）不落新稽核表。
- 不翻旗標、不動 BUILD-ORDER、不新開 B；CAP-M-35 / PROP-US-v03-04 僅以 additive 預留摺入 B-010。

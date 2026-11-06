# 設計說明 — B-008（Billing／partial-month／statement amount previews ＋ gated monthly rent writer ＋ FR-Q6-01／CAP-T-17 reserve，L2 preview≡generation）

> 存成 `20-build/specs/B-008-design.md`。
> 範本：`20-build/specs/B-024-design.md`／`20-build/specs/B-021-design.md`（CEO 2026-11-03 核准之 design-note 範式）。用詞以 `/GLOSSARY.md` 為準（org／staff／portal／live／sandbox／manager／owner）。
> Stack：**App 分支 `feat/b-008-billing-previews`，stack 於 `feat/b-024-vendor-job-ui` @ `cd1cba21465583b7a3908aed182243545be390de`（Draft PR #30，含 B-013／B-021／B-024 ＋ PROP-11 `20261105160000_prop11_repair_cost_foundation.sql` 之 `app.tenant_period_due_components`）。** 此 SHA 已含 stack 既有 B-008 preview surface（flags OFF）。B-008 本項 **stack 於 PR #30 head 之上，不 rebase、不 merge main（待 CEO GO）、不碰 prod**。B-013／B-021／B-024／PROP-11 schema 於其 QA 期間若變更，B-008 依最終 SHA 重綁。
> Hub design 落於 `pe/b-008-design`（自 `origin/pe/b-024-design` @ `07666e6dc09dd9359f3e568622f044ec40cc3841`）。prod tip `4aff923` 已含 **partial** B-008 preview surface；**Done ≠ production activation**。永不碰 hub `main`、`/workspace/condola-hub`、`/workspace/hub-sync`。維持 52-item BUILD-ORDER、0 violations；app BO mirror 與 hub **byte-identical**；**僅 B-008 單格** `partial → in_progress`，不重排、不新開 B id。
> 類別：**B（權限／隔離＋金額門檻 risk）**。相依：**PROP-11（`app.tenant_period_due_components`，FR-Q6-01 reserve，已在 stack）**、既有 B-008 preview surface（`billing-preview-*.ts`／`monthly-rent-preview.ts`／`monthly-rent-operation-plan.ts` 純 planner `monthly-rent-operation-v1`／`monthly-billing-*.ts`／`statement-preview.ts`／`first-period-*.ts`），以及 **已 review、未 apply** 的 writer foundation handoff（`e2e-evidence/B-008/monthly-operation-db-handoff.md` ＋ `monthly-operation-proposed.sql.txt`）。承 CAP-T-17（B-008 計算／預覽端；B-018 承 write path ＋ `expenses` CHECK widen）。
> **判定：PROCEED（BUILD-ONLY），將 BUILD-ORDER B-008 由 `partial` 推進至 `in_progress`。** 本項 end-state 目標仍為 `done（build-only / flags OFF）`，但該收斂在 Phase 2 QA、不在本設計之 commit。交付三部分、全在 OFF flag 之後：(A) 補齊 partial（shared calc service 延伸到 full-bill 預覽、gated monthly writer、preview≡generation parity、OFF byte-identical）；(B) FR-Q6-01 per-period／per-component reserve；(C) US v0.3 CAP-T-17 `advanceCredits` reserve DTO ＋ 負淨額規則。**不開任何 flag ON、不 seed ON、不翻 flag、不改既有 migration、不 ALTER `expenses` CHECK（B-018）、不碰 messaging／LINE／email／真實付款／扣款、不自動結案。** 未觸及任何 STOP 條件。
> **本設計明確不宣稱「done = 啟用」。** flag flip、staging 財務資料、live 開立／過帳、hosted migration apply、reader 對 live PII／storage 複檢一律列為 runtime ON-gate（見 §W1–W7／繼承 ON-gates、§不做什麼），不 overclaim。

---

## 使用者故事／能力 ID

- **覆蓋**：L2 — `CAP-M-08`／`CAP-M-22`（brand-v2 finance／report preview patterns），journey：staff（Admin／Accountant／Manager）在 org 內對某 lease／period **預覽** billing（rent ＋ 已過帳適格水電 ＋ statement-relevant 既有 SELECT 來源）、partial-month（顯示 period＋formula）、statement 金額，**全部經與生成同一條純計算 service**；在 flag ON 隔離 org 內，Admin／Accountant 可經 gated writer 實際開立月租（occurrence／command ＋ invoice／rent line／ledger），Manager 僅 preview。**preview≡generation**：相同輸入 → 相同 `amountMinor`（＋ digest）；差異被揭露而非靜默 coerce。
- **對應 spec／BO**：`B-008.md`（本項；含 US v0.3／CAP v2.1 hang PROP-US-v03-03 / CAP-T-17，Ron 2026-11-05 19:04 PT 核准）。BO note 已載：「**FR-Q6-01 reserve** — L2 須為租客每月應繳總額預留 per-period／per-component 金額＋來源參照（B-018 消費）」。本 note **消費** PROP-11 之 `tenant_period_due_components`，**不重開** PROP-11、**不自建付款執行**。
- **對應既有程式／資料（build-side 已存在，本項消費／延伸／驗證，不重建）**：
  - **Flags（registry）**：`billing_previews`（global＋org，default OFF，owner Ron）；`monthly_rent_posting`（**reserved／unprovisioned**；`flags.yaml` 已 document future gate，platform_settings 硬 key **尚未 insert**；今日 OFF）。
  - **Migrations（已在 stack）**：`20261031100208_b008_billing_previews.sql`（platform_settings seed OFF）、`20261031100210_b008_first_period_basis.sql`（`app.b008_capture_first_period` SECURITY DEFINER ＋ `leases.first_period_basis`）；PROP-11 `20261105160000_prop11_repair_cost_foundation.sql`（`app.tenant_period_due_components`）。
  - **TS（已在 stack）**：`billing-preview-*.ts`、`monthly-rent-preview.ts`、`monthly-rent-operation-plan.ts`（純 planner，literal version `monthly-rent-operation-v1`、canonical JSON 之 SHA-256 digest、輸出 `leaseId`／property／payer／currency／`amountMinor`／service period／due date／digest）、`monthly-rent-operation-plan.ts` 之上的 `monthly-rent-operation-plan.ts` planner、`monthly-billing-*.ts`、`statement-preview.ts`、`first-period-*.ts`、UI `/m/rent/monthly-preview` 與 components、e2e `b008-*.spec.ts`。
  - **Evidence（已收斂）**：checkpoints `4b8228f`／`17ec9df`（SELECT-only monthly rent ＋ first-invoice previews PASS scoped）。
  - **已 review、未 apply 的 writer foundation**：`e2e-evidence/B-008/monthly-operation-db-handoff.md` ＋ `monthly-operation-proposed.sql.txt`（occurrences／commands 表、immutable trigger、dual-gate writer `writeMonthlyRent(session,{leaseId,month,requestId,expectedDigest})`、Admin／Accountant write／Manager preview-only、replay／`already_issued`、integer money、fail-closed OFF、`monthly_rent_posting` seed）。**本項將其實作為 forward-only migration ＋ TS writer，不改其契約。**
  - **PROP-11 FR-Q6-01**：`app.tenant_period_due_components`（`org_id`／`lease_id`／`period_ym`／`component_key`／`amount_minor`（≥0 bigint）／`currency`／`source_ref_kind ∈ lease_charge｜repair_cost_item｜deposit_settlement｜manual｜other`／`source_ref_id`／`note`／`created_by`／`created_at`；service_role-only；record／display only）。
- **刻意不覆蓋**（＝其他 B 項或 runtime ON-gate）：
  - **租客代墊 write path ＋ `expenses` CHECK widen ＋ credit state machine**＝ **B-018**（CAP-T-17 write 端）；本項只**預覽**既核准 credit、**預留** DTO 形狀，不 ALTER `expenses`、不寫 credit。
  - **approved 區域 formula 變更／payment processing**＝ spec out of scope；本項不改 formula、不收款、不執行扣款、不碰 bank debit。
  - **租客每月應繳 complete net**＝ B-018 ＋ UC2；本項不宣稱完整淨額。
  - **flag flip、seed ON、staging 財務資料、hosted／prod migration apply、live 開立 UX**＝ CEO／Ron 的 separate decision。

## Done means（build-only）

一句話：**對 stack PR #30 head，B-008 把既有純 planner `monthly-rent-operation-v1` 延伸為 full-bill 預覽 composer（rent ＋ 已過帳適格水電 ＋ statement-relevant 既有 SELECT 來源，皆以同一 `amountMinor`／digest 規則），新增一支 forward-only migration `20261106000000_b008_monthly_rent_operation.sql`（> stack 最新 `20261105190000`）建 `app.b008_monthly_rent_occurrences`＋`app.b008_monthly_rent_commands`＋immutable trigger＋`platform_settings.monthly_rent_posting` seed `{"enabled":false,"allowed_org_ids":[]}` ON CONFLICT DO NOTHING，以及 TS writer `writeMonthlyRent(...)`（service_role inserts，dual-gate `billing_previews` ∧ `monthly_rent_posting` 皆 ON 才新開立、任一 OFF 時 history recovery SELECT 仍可用）；在 `billing_previews` OFF（＝今日）時既有頁面／action 逐 byte 不變、無任何新寫入、無新控制；在 flag ON 隔離測試 org 中 preview≡generation（相同輸入 → 相同 `amountMinor`＋digest，差異揭露不靜默 coerce）；月應繳預覽暴露 per-period／per-component 行（`component_key`／`amount_minor`／`currency`／`source_ref_kind`／`source_ref_id`，比對 `tenant_period_due_components` 形狀）；preview DTO 含 optional `advanceCredits[]`（今日空陣列），負淨額 → 顯示應繳 0 ＋ 下期 credit、永不宣稱已收款；所有新寫入經 stable server-rendered `requestId` 冪等、replay-before-head 回原結果、payload 變即拒、real route POST retry 測到；integer bigint money throughout。**
- **Staging（stack SHA）**：在 PR #30 head 之上 build、綠燈；新 migration 在 disposable 本機 PG（已套 stack 全部 migration，含 PROP-11／B-013／B-021／B-024）套用成功（完整 BEGIN→COMMIT 原子、函式／表／欄位 REVOKE/GRANT 正確、rollback 驗證、slot `20261106000000` 跨 inventory 確認未用）。**不在 hosted／prod 套用**；hosted apply 由 PE 依 handoff 流程另行執行。
- **flags OFF ＝今日**：`billing_previews`（global＋org）維持 OFF；`monthly_rent_posting` 維持 **未 provision／OFF**（seed 以 `{"enabled":false,"allowed_org_ids":[]}` 落，default OFF，不 insert ON）。**不新增 flag、不 seed ON、不翻任一 flag。**
- **可觀察**：
  - **`billing_previews` OFF**：`/m/rent/monthly-preview` 與既有 billing／statement／first-period 頁面／action render 與今日逐 byte 相同（相同呼叫序、相同 `data-testid`、相同既有行為）；full-bill composer／writer／credit reserve 分支 **short-circuit、不呼任何 writer、不 render 新控制、無新寫入**；靜態掃描：ON 分支無新 production writer 進入 live route 的 OFF 路徑。
  - **`monthly_rent_posting` OFF（即使 `billing_previews` ON）**：`writeMonthlyRent` 新開立被拒（fail closed），**無 occurrence／command insert、無 invoice／ledger 寫入**；current-authorized read-only history recovery SELECT 仍可用、不 append command。
  - **兩 flag 皆 ON（隔離 org）**：Admin／Accountant 開立 → `app.b008_monthly_rent_occurrences`／`commands` 各留不可變、org／lease／month／kind 唯一、`(org,actor,request)` 冪等之證據；同 `requestId` 重放回原結果、payload 改變即拒；不同 request 命中既有 occurrence → append `already_issued`、不新建 finance 列；Manager 僅 preview、寫入被拒；preview≡generation 單測綠。
- **BUILD-ORDER**：本項單格由 `partial → in_progress`（note 指向本 design ＋ stack base）。end-state `done（build-only / flags OFF）` 於 Phase 2 QA 收斂、不在本 commit。啟用（flag ON、staging 財務資料、live 開立、hosted apply、reader 對 live PII/storage 複檢）是 separate decision。

## 端到端 tracer bullet

最小可行、**只走 preview≡generation ＋ gated writer** 的一條路徑（本 SHA 後於 flag ON 隔離 org 以整合測試驅動；flags OFF 時此路徑不存在、既有頁面／action 不改任何行為）：

1. **preview（staff / CAP-M-08）**：staff 於 `/m/rent/monthly-preview` 對某 lease／month 預覽 → server 以 session（org 由 session 推導，非 client）呼純 composer `composeMonthlyBillPreview`，內部呼既有 `planMonthlyRentOperation`（literal `monthly-rent-operation-v1`）得 rent line，再組合已過帳適格水電 ＋ statement-relevant 既有 SELECT 來源，全部以同一 `amountMinor`／digest 規則；輸出 `MonthlyBillPreviewDTO`（含 `components[]`、`advanceCredits[]`、`netMinor`）。
2. **per-component reserve（FR-Q6-01 / Part B）**：composer 將每一組成拆為 per-period／per-component 行（`component_key`／`amount_minor`／`currency`／`source_ref_kind`／`source_ref_id`），形狀對齊 `app.tenant_period_due_components`；今日純 composition，不寫 DB（record helper 為 optional、見 §資料）。
3. **advance credit reserve（CAP-T-17 / Part C）**：composer 讀既核准 credit（若 B-018 write path 已存在且 flag ON 才有列；今日無列 → `advanceCredits = []`）。負淨額 → DTO `netMinor = 0`、`carryMinor > 0`、`status:'carry'`，UI copy「應繳 0，下期 credit $X」，**永不**標示「已收款／paid」。
4. **generate / write（staff Admin／Accountant / gated writer）**：在 `billing_previews ∧ monthly_rent_posting` 皆 ON 時，staff 以 stable server-rendered `requestId`（hidden field）POST → `writeMonthlyRent(session,{leaseId,month,requestId,expectedDigest})`：交易內 recheck 兩 gate ＋ membership（Admin/Accountant；Manager 拒）→ replay-before-head（同 key 同 intent 回原結果標 replay、同 key 異 intent 拒）→ re-run 純 planner、比對 `expectedDigest`（stale／ambiguous → 拒）→ 建 invoice／單一 rent line／平衡 ledger、service_role insert occurrence＋command（`created`）。
5. **preview≡generation（Part A-3）**：單測證相同輸入 → preview 之 `amountMinor`＋digest ＝ writer 寫入之 `amount_minor`＋`plan_digest`；差異 → surface `unsupported`／`conflict`，不靜默 coerce。
6. **可觀察結果**：查 DB — occurrence／command 各一筆、snapshot envelope `b008-monthly-issuance-v1` 通過 CHECK、`(org,actor,request)` 唯一、`(org,lease,month,kind)` 唯一；重放回原結果；跨 org／跨 lease／跨 month 一律拒；**flags OFF 時無任何新寫入、無 credit 列、無 ticket/狀態變更**。

## Caller-first API（呼叫端優先）

**延伸既有純 planner，不新建競爭 planner；writer 為 TS + SQL 表／trigger（不另建 overly-broad SECURITY DEFINER RPC）。**

```text
-- src/server/monthly-bill-preview.ts（純 composer；延伸既有 billing-preview-*.ts / monthly-billing-*.ts）
composeMonthlyBillPreview(input: { env, orgId, leaseId, periodYm, plannedRent, postedUtilities[], statementSources[], advanceCredits? })
    → MonthlyBillPreviewDTO
    -- 內部呼既有 planMonthlyRentOperation（monthly-rent-operation-v1）得 rent line digest；
    -- 全部 component 以同一 amountMinor（bigint/decimal-integer string）＋ digest 規則；
    -- 差異 → { kind:'unsupported'|'conflict', detail } surface，不靜默 coerce。

type MonthlyBillPreviewDTO = {
  orgId; leaseId; periodYm; currency;
  components: Array<{ componentKey; amountMinor; currency; sourceRefKind: 'lease_charge'|'repair_cost_item'|'deposit_settlement'|'manual'|'other'; sourceRefId?; note? }>; // FR-Q6-01 形狀
  advanceCredits: Array<{ creditId; amountMinor; currency; status:'approved'|'clawback'|'carry'; sourceExpenseId?; note? }>;        // CAP-T-17 reserve；今日 []
  grossMinor; creditOffsetMinor; netMinor; carryMinor;   // netMinor 永 ≥ 0；負淨額 → netMinor=0, carryMinor>0
  planVersion; planDigest;                               // 與 writer 比對
};

-- src/server/monthly-bill-rules.ts（pure；沿用既有 repair-rules idiom；不含 flag）
assertNoNegativeClaim({ grossMinor, creditOffsetMinor })  // 回 { netMinor, carryMinor }；carry 永不宣稱 paid
assertPreviewMatchesPlan({ previewDigest, planDigest })   // 不符 → FlowError 'errors.preview_mismatch'

-- src/server/monthly-rent-writer.ts（gated；實作 handoff writeMonthlyRent；TS + service_role insert）
writeMonthlyRent(session, { leaseId, month, requestId, expectedDigest }) → IssuanceResult
    -- 交易內 recheck billing_previews ∧ monthly_rent_posting（皆 ON 才新開立；fail closed）
    -- membership Admin|Accountant 才寫；Manager → preview-only（拒寫）
    -- replay-before-head：同 key 同 intent 回原 result 標 replay；同 key 異 intent 拒；異 request 命中既有 occurrence → already_issued
    -- re-run planMonthlyRentOperation、比對 expectedDigest；integer bigint money
readMonthlyRentHistory(session, { leaseId, month }) → IssuanceResult | null
    -- current-authorized read-only；任一 gate OFF 仍可用；never append command

-- src/server/period-due-components.ts（optional，flag-gated record reserve；service_role 路徑）
recordPeriodDueComponent(session, { leaseId, periodYm, component })   // 僅 billing_previews ON；record/display only；不收款
    -- 預設不呼；preview 先走純 composition。若 included，INSERT app.tenant_period_due_components（additive、tested）

-- Routes / actions（新；全 flag-gated，stable server-rendered requestId）
POST /api/monthly-rent-issue        -- writeMonthlyRent；UUID requestId 必填；OFF→short-circuit/rejected
// 既有 preview 頁面／action：billing_previews OFF 時逐 byte 不變
```

- **flag 落點（defense-in-depth，OFF byte-identical 首要保證＝page／action short-circuit）**：(1) preview 頁面／action 以 server-side flag resolver 決定是否 render full-bill／credit 控制，`billing_previews` OFF → 逐 byte 等同今日；(2) `writeMonthlyRent`／`recordPeriodDueComponent` 進入即檢 flag → OFF short-circuit；(3) SQL 層 gate（seed `monthly_rent_posting` default OFF、交易內 recheck）fail closed。
- **preview≡generation 單一 planner**：composer 與 writer 共用 `planMonthlyRentOperation` 的 canonical byte encoding 與 digest；writer 不信任 client digest（僅作 expected 比對值）。

## 資料／migration

- **一支 forward-only migration**：`20261106000000_b008_monthly_rent_operation.sql`（ts > stack 最新 `20261105190000_b024_vendor_completion_reason.sql`；PG 目標依 stack；slot 跨 inventory／ledger 確認未用）。內容＝實作 reviewed handoff `monthly-operation-proposed.sql.txt`：
  - `CREATE TABLE app.b008_monthly_rent_occurrences`（explicit UUID、`org_id` FK `public.organizations`、`(org_id,lease_id)` FK `public.leases(org_id,id)`、`month_start` 月初 CHECK、`kind='rent'`、`amount_minor bigint > 0`、`currency` FK `public.currencies`、`plan_version='monthly-rent-operation-v1'`、`plan_digest ~ '^[0-9a-f]{64}$'`、original issuer／invoice／rent-line／ledger-transaction UUID、`issuance_snapshot jsonb` 之 `b008-monthly-issuance-v1` envelope CHECK（`IS TRUE`，missing/null/type-mismatch 即 fail）、`(org_id,id)` UNIQUE、`(org_id,lease_id,month_start,kind)` UNIQUE）。
  - `CREATE TABLE app.b008_monthly_rent_commands`（`(org_id,actor_user_id,request_id)` UNIQUE、`(org_id,occurrence_id)` FK、`result_kind ∈ created|already_issued`）。
  - 兩表 `ENABLE ROW LEVEL SECURITY`、無 policy、`REVOKE ALL ... FROM PUBLIC, anon, authenticated, service_role`；**本項 TS writer 以 service_role 連線 insert**（依 handoff：writer 於交易內以受驗 owner／service 角色短暫切換插入 receipt，恢復 authenticated；feasibility 為 PE validation item，不 overclaim）。小型 `BEFORE UPDATE OR DELETE` 恆 raise 的 immutable trigger（`SET search_path = pg_catalog`），function execute REVOKE。
  - `INSERT ... platform_settings('monthly_rent_posting', '{"enabled":false,"allowed_org_ids":[]}', ...) ON CONFLICT DO NOTHING`（**prefer DO NOTHING** 以免 key 已存在而破壞交易；default OFF）。
  - **硬規矩**：`SECURITY DEFINER` 僅在真用到時加，`SET search_path = pg_catalog, app`（pinned；既有 B-008 function 若用 `pg_catalog, public` 則沿其慣例）、org 由 session 推導（非 client／GUC）、service_role-only、flags OFF fail closed。
- **FR-Q6-01（Part B）**：**不建新表**；消費既有 `app.tenant_period_due_components`（PROP-11）。preview 先走純 composition（不寫 DB）。**optional** `recordPeriodDueComponent` 若 included → 僅 `billing_previews` ON、service_role INSERT、additive、tested；`amount_minor ≥ 0 bigint`、`source_ref_kind` 限既有 enum。record/display only，不收款。
- **CAP-T-17（Part C）**：**不 ALTER `expenses` CHECK**（B-018 owns additive widen ＋ credit state machine）。本項僅 **預覽** 既核准 credit（若存在）／預留 DTO 形狀；今日無 credit 列 → `advanceCredits = []`。
- **seed.ts 相容（依 handoff diff）**：`resetAndSeed()`／`wipe()` 的私表清單前置 `"b008_monthly_rent_commands", "b008_monthly_rent_occurrences"`（commands 先於 occurrences 刪；`to_regclass` guard 各自保留）。僅在 disposable reset 的 trusted-owner 流程內繞 trigger／FK；確保 exception rollback、pooled 連線不殘留 replica mode。

## Flag

- **不新增 flag、reuse registry。** 兩個控制 default OFF ＝今日：
  - `billing_previews`（global＋org，owner Ron，expires 2026-11-10T18:00-08:00）：gate preview full-bill 組合、credit reserve、record helper、以及 writer 的 preview gate。OFF → 既有頁面／action 逐 byte 不變、無新控制。
  - `monthly_rent_posting`（**reserved／unprovisioned**；`flags.yaml` 已 document；seed 以 default OFF 落）：獨立 posting gate。**新財務開立** 需 `billing_previews` ∧ `monthly_rent_posting` **皆 ON**（platform global `enabled` 嚴格 JSON true ＋ `allowed_org_ids` 含該 org ＋ org override `feature_flags.monthly_rent_posting` 嚴格 true）；缺／malformed/false 即 fail closed。**preview 單獨不能啟用 posting。** 任一 gate OFF 時 current-authorized read-only history recovery 仍可用、不 append command。
- **flag 不進 pure 規則模組**（`monthly-bill-rules.ts` 保持純函式）；多處一致 fail-closed，OFF byte-identical 的首要保證是 preview 頁面／action short-circuit。

## 金額／權限 risk

- **金額（W4）**：全程 **integer bigint minor-unit**（SQL `bigint`、TS `BigInt`／canonical decimal-integer string）。**無 float**。`amount_minor > 0`（occurrence）、`tenant_period_due_components.amount_minor ≥ 0`、credit `amountMinor` 整數。preview digest 與 writer digest 以同一 canonical byte encoding；**不改任何 approved formula**、不設商業上限（＝產品 ON-gate）。負淨額經 `assertNoNegativeClaim` → `netMinor = 0` ＋ `carryMinor`，**永不宣稱已收款**。
- **權限／隔離（W2／W6／W7）**：
  - **org 由 session 推導**（非 client）；writer 交易內 recheck membership（Admin／Accountant 寫，Manager preview-only）＋ 兩 gate；fail closed on unknown authority／malformed flags／stale source。
  - **冪等／replay（W5）**：`(org,actor,request_id)` 唯一；replay-before-head 回原結果、同 key 異 intent 拒；occurrence／command immutable（trigger BEFORE UPDATE/DELETE 恆 raise）。
  - **跨租戶**：`(org,lease,month,kind)` 唯一 ＋ 複合 FK 保 org/lease 相符；跨 org／跨 lease／跨 month 一律拒。
  - **snapshot PII 最小化**：snapshot 存 stable ID（非姓名）、不存 raw request body／secrets；org/lease durable 參照可阻 parent 刪除 → 列為 privacy/retention ON-gate（不自創法定保存期）。

## HITL／AFK

- **HITL（人需介入）**：(1) `billing_previews`／`monthly_rent_posting` flag flip（CEO／Ron）；(2) hosted／prod migration apply（PE 依 handoff，非本設計）；(3) 實際開立月租／過帳之授權操作（Admin／Accountant，flag ON runtime）；(4) unexplained diff 的人工 close（spec acceptance：差異揭露、由人判讀，系統不隱藏、不自動 coerce）；(5) CAP-T-17 代墊之管理方核准（B-018 + UC2 runtime）。
- **AFK（可無人推進）**：build、單測（preview≡generation、負淨額、per-component 形狀）／PG 整合測試、disposable PG clone 的 migration 套用／rollback、flag-OFF characterization、real route POST retry／replay 測試、CI 綠燈、evidence 收斂——皆可在 stack SHA 上無人完成，不觸 hosted/prod。

## 驗證（tests／evidence）

證據收斂至 **`/workspace/e2e/results/B-008/`**（spec 指定路徑；沿用既有 `b008-*.spec.ts`，新測掛同目錄）。

- **OFF characterization（首要）**：以既有 fixtures render `/m/rent/monthly-preview` 與既有 billing／statement／first-period 頁面／action，`billing_previews` OFF 時 pre/post **逐 byte／逐欄位相同**（golden 快照）；`monthly_rent_posting` OFF 時 `writeMonthlyRent` 新開立被拒、無 occurrence/command/finance 寫入、history recovery SELECT 仍可用；靜態掃描確認 ON 分支無新 production writer 進入 OFF 路徑。
- **preview≡generation parity（Part A-3）**：單測相同輸入 → preview `amountMinor`＋`planDigest` ＝ writer 寫入 `amount_minor`＋`plan_digest`；差異 fixture → surface `unsupported`／`conflict`，不靜默 coerce。
- **金額 fixtures（spec）**：positive／zero／negative、vacant／shared allocation、multi-currency（含非兩位小數幣別）；partial-month → 顯示 period＋formula；rounding reconcile to bill。
- **writer acceptance（依 handoff）**：positive/zero 拒絕、stale digest 拒、payer/source ambiguity 拒、同 lease/month 兩 request 競 unique occurrence（loser rollback → fresh gated txn append `already_issued`）、同 key 同/異 intent、多 request/actor 映一 occurrence、manager 拒寫、legacy direct rent write 在 snapshot 前/中/後、void/刪除後 truthful replay、兩 gate ＋ strict allowlist 行為、malformed envelope key/型別/null 各拒、replay with gates OFF。
- **FR-Q6-01（Part B）**：單測 per-component 行形狀對齊 `tenant_period_due_components`（`component_key`／`amount_minor ≥ 0`／`source_ref_kind` enum）；若 included record helper → additive INSERT 測、service_role 路徑、不收款。
- **CAP-T-17（Part C）**：純 composer 負淨額單測 → `netMinor=0`＋`carryMinor`、`status:'carry'`、copy 不含「paid／已收款」；今日 `advanceCredits=[]`、UI 可省略。
- **real route POST retry**：`/api/monthly-rent-issue` stable server-rendered `requestId`、replay-before-mutable、重送同 requestId 回原結果、payload 改變即拒（B-021／B-024 standard）。
- **migration**：disposable PG clone（已套 stack 全 migration）clean-install ＋ replay、ACL/RLS（含 inherited role ＋ owner-trigger）、collision、all-or-nothing、slot 追蹤、before/after row counts、rollback 不抹除 receipt。

## 不做什麼（out of scope / STOP 邊界）

- **不 ALTER `expenses` CHECK、不建 credit state machine、不寫租客代墊 credit** — 屬 **B-018**（CAP-T-17 write path）。本項僅預覽既核准 credit／預留 DTO。
- **不宣稱租客每月應繳 complete net** — B-018 ＋ UC2。
- **不改 approved 區域 formula、不做 payment processing、不收款、不執行扣款、不碰 bank debit。**
- **不新增 flag、不 seed ON、不翻任一 flag、不改既有 migration。**
- **不送任何 messaging／LINE push／email／通知中心。**
- **不碰 hub `main`、`/workspace/condola-hub`、`/workspace/hub-sync`、不 rebase onto main、不 merge main、不碰 prod（`4aff923`）、不在 hosted/prod 套 migration。**
- **不重排 BUILD-ORDER、不新開 B id**；52 items 不變；僅 B-008 單格 `partial → in_progress`。
- **不自動結案、不自動過帳、不繞過人工 diff close。**

## W1–W7／繼承 ON-gates（PROP-11 risk 清單對照）

- **W1 隔離**：所有 preview／writer org 由 session 推導、跨 org 拒；`(org_id,...)` 複合 FK ＋ unique 保證。**build-side 已強制並測到。**
- **W2 權限**：writer 交易內 recheck membership（Admin/Accountant 寫、Manager preview-only）。**build-side 強制；live role/identity 驗證＝ON-gate。**
- **W3 flag**：`billing_previews` ∧ `monthly_rent_posting` dual-gate、fail closed。**build-side 強制；實際 flip＝CEO/Ron ON-gate。**
- **W4 金額**：integer bigint、無 float、無商業上限（上限＝產品 ON-gate）。**build-side 強制。**
- **W5 immutability／冪等**：occurrence/command immutable trigger ＋ `(org,actor,request)` 冪等。**build-side 強制並測到。**
- **W6 PII／snapshot**：snapshot 存 stable ID、不存 raw body/secrets。**build-side 最小化；live PII 複檢＝reader ON-gate。**
- **W7 storage／retention**：durable org/lease FK 可阻 parent 刪除 → retention/刪除工作流需 separately reviewed；**不自創法定保存期＝ON-gate。**
- **繼承 ON-gates**：hosted/prod migration apply（PE handoff）、flag flip（CEO/Ron）、staging 財務資料、live 開立 UX、reader 對 live 的 PII/storage 複檢、writer 之 owner role-switch feasibility（handoff 列為 blocking PE validation item）。本設計 **不 overclaim** 任一項為已完成。

## 交付清單（files／migrations／tests，≤ ~25 paths，優先延伸既有模組）

**Migration（1）**
1. `supabase/migrations/20261106000000_b008_monthly_rent_operation.sql` — occurrences／commands 表 ＋ immutable trigger ＋ `monthly_rent_posting` seed（ON CONFLICT DO NOTHING）。

**Server TS（延伸／新增）**
2. `src/server/monthly-bill-preview.ts` — `composeMonthlyBillPreview`（延伸既有 `billing-preview-*.ts`／`monthly-billing-*.ts`，共用 `planMonthlyRentOperation`）。
3. `src/server/monthly-bill-rules.ts` — pure `assertNoNegativeClaim`／`assertPreviewMatchesPlan`（沿既有 repair-rules idiom）。
4. `src/server/monthly-rent-writer.ts` — `writeMonthlyRent`／`readMonthlyRentHistory`（實作 handoff 契約）。
5. `src/server/period-due-components.ts` — optional `recordPeriodDueComponent`（flag-gated、service_role、additive）。
6. `src/server/monthly-rent-operation-plan.ts` — （既有純 planner）僅在 full-bill 組合需要時新增 export helper，**不改 canonical encoding／version**。
7. `src/server/seed.ts` — `resetAndSeed()`／`wipe()` 私表清單前置兩表名（依 handoff diff）。

**Routes／UI（flag-gated；OFF byte-identical）**
8. `src/app/api/monthly-rent-issue/route.ts` — POST writer，stable requestId、replay-before-mutable、OFF short-circuit。
9. `src/app/m/rent/monthly-preview/page.tsx` — （既有）加 full-bill／per-component／`advanceCredits` 區塊，server flag resolver gate、OFF 逐 byte 不變。
10. `src/components/billing/MonthlyBillPreview.tsx` — （延伸既有 component）顯示 components／credits／netMinor／carryMinor，無新金額欄模型。

**Types**
11. `src/server/types/monthly-bill.ts` — `MonthlyBillPreviewDTO`／`advanceCredits`／`IssuanceResult` 型別（semantics 固定）。

**Tests／evidence（`/workspace/e2e/results/B-008/`）**
12. `tests/unit/monthly-bill-preview.spec.ts` — preview≡generation parity、unsupported/conflict surface。
13. `tests/unit/monthly-bill-rules.spec.ts` — 負淨額（netMinor=0＋carry，不宣稱 paid）、preview mismatch。
14. `tests/unit/period-due-components.spec.ts` — per-component 形狀對齊 `tenant_period_due_components`。
15. `tests/integration/monthly-rent-writer.spec.ts` — dual-gate、membership、replay/already_issued、競態、immutable、manager 拒寫、OFF history recovery。
16. `tests/integration/monthly-rent-migration.spec.ts` — disposable PG clone 套用／rollback／ACL/RLS/slot。
17. `e2e/b008-monthly-preview.spec.ts` — （延伸既有）OFF characterization（逐 byte）＋ ON full-bill 預覽。
18. `e2e/b008-monthly-issue.spec.ts` — real route POST retry（同 requestId 回原結果、payload 變即拒）。
19. `src/flags.yaml` — 僅 reconcile `monthly_rent_posting` document（不改 default、不 seed ON）。

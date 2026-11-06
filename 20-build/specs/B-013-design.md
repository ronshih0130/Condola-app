# 設計說明 — B-013（Manager dispatch and shared repair approval state，L2 closeout）

> 存成 `20-build/specs/B-013-design.md`。
> 範本：`PROP-01b-design.md`（CEO 2026-11-03 核准之 design-note 範式）。用詞以 /GLOSSARY.md 為準（org／staff／portal／live／sandbox／vendor token／manager／owner）。
> Stack：`feat/prop-10-vendor-attribution` @ `c3f7fab`（含 `main` @ `4aff923` ＋ SEG1 ＋ SEG2 ＋ PROP-11 `20261105160000_prop11_repair_cost_foundation.sql` ＋ B-032／PROP-08／PROP-01b／PROP-10）。此 SHA 為 baseline；**不 rebase、不 merge main（待 CEO GO）**。
> 類別：**B（權限／隔離＋金額門檻 risk）**。BO v2 row #11，status `partial`。相依：**`—`（無硬前置）；與 B-021（#12）、B-024（#13）同屬一條 shared repair-state 契約 lane；foundation PROP-11（已 PASS-with-conditions @ `5f9cc01`）**。本項為該 lane 的**契約保留者（reserve-once）**：一次把六＋二張私有審批狀態表、純 TS 規則模組與 service-only gateway 的形狀定稿，供 B-021（owner 決定）、B-024（vendor 接受／排程／完成）在穩定介面上施作，不各自重建審批模型。涵蓋能力：`CAP-M-15`／`CAP-M-16`（manager 派工與審批狀態）、journey J5、inventory M-48／M-49。
> **判定：PROCEED（BUILD-ONLY），將 B-013 由 `partial` 推進至 `done（build-only / flag-OFF）`。** 本設計交付：(1) **一支 forward-only migration** `20261105170000_b013_repair_approval_state.sql`（ts > `20261105160000`），把 `b013-db-handoff.md` 的 CLOSED 六表提案**合併定稿並補 appointments ＋ 去重 event outbox**，RLS／revoke／composite org＋ticket FK／immutable trigger 全開，service-only SECURITY DEFINER gateway、org 由 session 推導、所有 writer 在 `REPAIR_APPROVALS`／`vendor_dispatch` OFF 時 **fail closed**；(2) **純 TS 規則模組** `repair-approval-rules.ts`（狀態機、門檻 strict `>`、新版本觸發、24h 靜默只產一筆提醒 intent、緊急例外需 Admin＋原因＋照片）；(3) **薄 server service** `repair-approval.ts` 僅在 flag ON 時呼 gateway，**flag OFF 時 `vendor-repair.ts`／`repairs.ts` 行為逐 byte 不變**。**不開任何 flag ON、不 seed flag、不改既有 migration、不碰 messaging／真實寄送／自動付款、不繞過 owner 核准。** 未觸及任何 STOP 條件。
> **本設計明確不宣稱「done = 啟用」。** flag flip、staging 資料、owner／vendor 實際 UX、reader 啟用一律列為 runtime ON-gate（見 §W1–W7、§不做什麼），不 overclaim。

## 使用者故事／能力 ID

- **覆蓋**：L2 — `CAP-M-15`／`CAP-M-16`（manager 派工與共享修繕審批狀態）、J5（修繕審批／派工 journey）、inventory **M-48／M-49**。把「某工單目前這版估價 → 門檻判定（需屋主決定 vs 政策合格）→ 指定屋主的單一終局決定 → 緊急例外 → 公司確認約訪 → 24h 靜默提醒意圖」這條**共享修繕審批狀態**，收斂成**單一、具名、可單測、有不可變證據**的伺服器端契約（私有表 ＋ `resolveApprovalState(...)` 純規則 ＋ service-only gateway），供 **B-021（owner 決定端）** 與 **B-024（vendor 接受／排程／完成端）** 消費，而非各自重算門檻或自建審批模型。
- **對應 spec／BO**：`B-013-spec.md`（本項）、`B-021-spec.md`（owner 決定，reuse 本 shared schema，不另建審批模型）、`B-024-spec.md`（vendor UI）。BO v2 note：「B-013/B-021/B-024 share one repair-state contract. Reserve their shared files once.」本 note 即該 reserve-once。
- **對應既有程式／資料**：
  - 已建之「門檻設定切片」（**不是審批流程**）：`20261031100220_b013_owner_repair_policy.sql`（regional／owner default roots＋revisions、`app.b013_owner_context`、`app.b013_owner_view`、default change/status/close/finish）、`..221_b013_owner_repair_override.sql`（property override change/status/close/finish）；消費於 `repair-owner-policy.ts`／`repair-owner-override.ts`／`/o/repair-policy/[id]`。本項**讀取其門檻值做 provenance 快照，不改其任何行為**。
  - 既有 live 修繕 writer（flag OFF 時逐 byte 不變）：`repairs.ts`（`saveRepairRecord`／`attachRepairPhoto`）、`domain.ts`（`updateTicket`）、`vendor-repair.ts`（`dispatchVendor`／`submitVendorReport`／`confirmVendorCost`）。
  - 既有純規則範式：`repair-rules.ts`（`FlowError`、exported const 陣列、photo sniff／MIME、`expenseLinkPlan`、`REPAIR_EXPENSE_STATUS='draft'`）。本項新規則模組**沿用此檔的 idiom 與 photo 驗證，不改該檔**。
  - foundation：PROP-11 `20261105160000_prop11_repair_cost_foundation.sql`（六張 `app.repair_cost_*`／`tenant_period_due_components`，RLS＋revoke＋service_role 最小授權，W1–W7 待消費端滿足）。
- **刻意不覆蓋**（＝其他 B 項或 runtime ON-gate）：
  - **owner 決定的實際 UX／pending 清單／approval cards**＝ B-021；本項只給其 `decide` gateway ＋ owner pending／history 讀取契約。
  - **vendor 接受／拒絕／時段提案 vs 公司確認／完成後照片 UI**＝ B-024；本項只給其 appointment 事件契約與 dispatch 守衛。
  - **真實 Email／LINE／通知中心送達**＝ messaging／B-028；本項的 event outbox **只記意圖、零送達、非 B-028 source**。
  - **自動付款、記帳過帳、既有 posted expense 改寫**＝ expense 螢幕；本項維持 `REPAIR_EXPENSE_STATUS='draft'`，收據只是證據不等於付款。
  - **flag flip、staging 資料灌入、生產啟用**＝ CEO／Ron 的 separate decision。

## Done means（build-only）

一句話：**對 stack `c3f7fab`，B-013 新增一支 forward-only migration、一個純 TS 規則模組與一個薄 service；在 `REPAIR_APPROVALS`／`vendor_dispatch` 皆 OFF（＝今日）時，`vendor-repair.ts`／`repairs.ts`／`domain.ts` 的每一條路徑逐 byte 行為不變；在 flag ON 的隔離測試 org 中，所有審批狀態（版本、決定、緊急、約訪、提醒意圖）只能經 service-only SECURITY DEFINER gateway 寫入，org 由 session 推導、跨 org／跨 ticket 一律拒絕、門檻判定 strict `>`、24h 靜默恰產一筆提醒意圖且永不核准、歷史不可變——且 PROP-11 的 W1–W7 當中可由 build-side SQL 強制的部分已被強制並測到，其餘明列為 reader／flag ON-gate。**

- **Staging（stack SHA）**：在 `feat/prop-10-vendor-attribution @ c3f7fab` 上 build、綠燈；migration 在 disposable 本機 PG17 clone 套用成功（完整 BEGIN→COMMIT 原子、循環 FK deferred 驗證、rollback 驗證）；QA packet 附 §驗證 證據至 `/workspace/e2e/results/B-013/`。**不在 hosted／prod 套用**；hosted apply 由 PE 依 handoff 流程另行執行。
- **flags OFF ＝今日**：`repair_approvals`（reconcile `REPAIR_APPROVALS*` proposal 名、見 §Flag）維持 OFF、`vendor_dispatch` 維持 OFF、不新增 flag、不 seed ON。flag OFF 時本項**不新增任何使用者可見行為**：既有工單／派工 writer 完全不改呼叫路徑。
- **可觀察**：
  - flag OFF：以既有 fixtures 跑 `repairs.ts`／`vendor-repair.ts`／`domain.ts`，pre/post 行為逐欄位相同（characterization golden）；新 service 不被任何 live route 呼叫（靜態掃描：無新 production caller）。
  - flag ON（隔離 org）：submit 超門檻 → `requires_owner_decision=true`（pending approval）；= 或 < 門檻 → policy_qualified，**不偽造屋主已同意**；指定屋主 approve/reject/more_information 落在特定版本；24h 靜默 → scheduler 產**恰一筆** `approval_reminder_24h` intent，**狀態不變為 approved**；Admin 緊急（水／電／安全＋原因＋照片）→ audit ＋**立即**一筆 `emergency_owner_notice` intent；vendor 拒絕 → ticket 保持 open。
  - 所有新表在未灌資料時初始為空；所有 app role／PUBLIC 對新表無直接讀寫權。

## 端到端 tracer bullet

最小可行、**只走 manager／owner／vendor 審批狀態面**的一條路徑（本 SHA 後，於 flag ON 隔離 org 以整合測試驅動；flag OFF 時此路徑不存在、不改任何既有行為）：

1. **submit（manager / B-013）**：manager 對工單 `T` 送估價 `{amount_minor, currency, minor_unit, work_scope, evidence[], expected_head_id, request_id, payload_sha256}`。gateway `app.b013_submit_estimate` 以 **session 推導 org**（非 client 參數／GUC），檢 `repair_approvals` ON、角色、consent；原子地：鎖 head（CAS `expected_head_id`）→ server 自鑄 `version_id` → 快照當時 `captured_threshold_minor`／`threshold_source`／`threshold_revision_id`／`threshold_provenance_sha256`（取自 100220／221 門檻值）→ 寫 immutable version（`version_no=prev+1`）→ deferred FK 更新 head `current_version_id` → 寫 command 列 `(actor_id, request_id)`。`requires_owner_decision = amount_minor > captured_threshold_minor`（**strict >**，generated STORED）。
2. **門檻分岔（純規則 / repair-approval-rules.ts）**：`requires_owner_decision=true` → `pending_approval`；`false` → `policy_qualified`（≤ 門檻，**非偽造核准**，不產屋主決定列）。
3. **decide（owner / B-021 消費）**：指定屋主對**該版本**呼 `app.b013_decide_estimate` → 寫 immutable decision（`approved｜rejected｜more_information`，`decided_by` 以複合 FK 綁回版本保存之 `designated_principal_id`）；`UNIQUE(org_id,version_id)` 保證一版一終局決定。`more_information`／`rejected` 不改金額即不重用——金額／範圍／證據／指定屋主有變 → 走步驟 1 產**新版本**，舊同意不沿用。
4. **24h 靜默（scheduler / B-013）**：pending 版本逾 24h 無決定 → `app.b013_emit_reminder` 以 `UNIQUE(org_id,version_id,kind='approval_reminder_24h')` 去重寫**恰一筆** intent；**提醒永不等於核准**（gateway 不寫 decision、不改 head 授權）。
5. **emergency（Admin / B-013）**：Admin（角色於 gateway 強制）呼 `app.b013_authorize_emergency{category∈water/electricity/safety, reason, photos[1..8]}` → 原子寫 emergency 列 ＋ recordAudit ＋**立即**一筆 `emergency_owner_notice` intent；**不偽造屋主決定、不重用他版 override**。
6. **dispatch／appointment（vendor / B-024 消費）**：`vendor_dispatch` ON 時，`dispatchVendor` 經守衛 `app.b013_assert_dispatchable(version)`——僅當該版本為 `approved` 或 `policy_qualified` 或有有效 emergency 才放行；`app.b013_confirm_appointment` 記 vendor 提案／公司確認／vendor 拒絕／完成待審 事件（immutable 事件列）。**vendor 拒絕 → 規則回 `keepTicketOpen`，不改 ticket 狀態為 resolved/closed。**
7. **可觀察結果**：每個狀態都在私有表留下不可變、org／ticket 綁定、actor＋request 冪等的證據；重放同 `request_id` 回傳原結果、payload 改變則拒絕；跨 org／跨 ticket／跨版本一律拒絕。**查 DB：無任何真實送達列、無自動 posted expense、flag OFF 時無任何新寫入。**

> 本 B 項 BUILD-ORDER 單一狀態欄位維持一項：`partial → done（build-only / flag-OFF）`。啟用（flag ON、staging 資料、reader UX）是 separate decision，不在本欄位。

## 資料表與 RLS（full DDL outline）

**一支新 migration** `supabase/migrations/20261105170000_b013_repair_approval_state.sql`（ts > `20261105160000`；additive、forward-only、完整 `BEGIN…COMMIT` 原子；`SET LOCAL lock_timeout/statement_timeout`；物件衝突即停、不以 `IF NOT EXISTS` 掩蓋結構不符；**無 DROP／無破壞性 ALTER／不改既有表／不 seed flag／不建 enum type（用 text＋CHECK，與 PROP-11 一致）**）。schema 用 `app.`，公開母表以 composite `(org_id,id)` key 參照。

**八張私有表**（六張承自 `b013-db-handoff.md` ＋ 本項新增 appointments ＋ 去重 outbox）：

1. **`app.b013_estimate_heads`**（**唯一可變**：CAS 指標）
   - `org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT`、`ticket_id uuid NOT NULL`、`current_version_id uuid NOT NULL`、`updated_at timestamptz NOT NULL DEFAULT clock_timestamp()`
   - `PRIMARY KEY (org_id, ticket_id)`；`FOREIGN KEY (org_id, ticket_id) REFERENCES public.maintenance_tickets(org_id, id) ON DELETE RESTRICT`
   - `FOREIGN KEY (org_id, ticket_id, current_version_id) REFERENCES app.b013_estimate_versions(org_id, ticket_id, id) DEFERRABLE INITIALLY DEFERRED`（head＋version 同交易插入、server 自鑄 version UUID，避免 nullable／永久空 head）
   - 授權規則：唯一允許的 UPDATE 是 `(current_version_id, updated_at)`，且僅經 gateway CAS；**不設 head.state 以免與 immutable 歷史漂移**，授權狀態一律由 version＋decision＋emergency 推導。

2. **`app.b013_estimate_versions`**（**immutable**）
   - `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`、`org_id uuid NOT NULL`、`ticket_id uuid NOT NULL`、`property_id uuid NOT NULL`
   - `version_no bigint NOT NULL CHECK(version_no>0)`
   - `currency char(3) NOT NULL REFERENCES public.currencies(code) ON DELETE RESTRICT`、`minor_unit smallint NOT NULL CHECK(minor_unit BETWEEN 0 AND 4)`、`amount_minor bigint NOT NULL CHECK(amount_minor>=0)`
   - `work_scope text NOT NULL CHECK(length(btrim(work_scope)) BETWEEN 1 AND 8000)`
   - `evidence_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(evidence_snapshot)='array' AND jsonb_array_length(evidence_snapshot)<=8)`
   - 事件時身分快照（非當下授權）：`designated_ownership_id uuid NOT NULL`、`designated_contact_id uuid NOT NULL`、`designated_principal_id uuid NOT NULL`
   - `captured_threshold_minor bigint NOT NULL CHECK(captured_threshold_minor>=0)`、`threshold_source text NOT NULL CHECK(threshold_source IN ('property_override','owner_default','regional_default'))`、`threshold_revision_id uuid`、`threshold_provenance_sha256 bytea NOT NULL CHECK(octet_length(...)=32)`、`payload_sha256 bytea NOT NULL CHECK(octet_length(...)=32)`
   - `requires_owner_decision boolean GENERATED ALWAYS AS (amount_minor > captured_threshold_minor) STORED` ← **strict >**
   - `submitted_by uuid NOT NULL`、`submitted_at timestamptz NOT NULL DEFAULT clock_timestamp()`
   - `UNIQUE(org_id,ticket_id,id)`、`UNIQUE(org_id,ticket_id,version_no)`、`UNIQUE(org_id,ticket_id,id,designated_principal_id)`
   - `FOREIGN KEY(org_id,ticket_id) REFERENCES app.b013_estimate_heads(org_id,ticket_id) ON DELETE RESTRICT`、`FOREIGN KEY(org_id,property_id) REFERENCES public.properties(org_id,id) ON DELETE RESTRICT`
   - `CHECK((threshold_source='regional_default' AND threshold_revision_id IS NULL) OR (threshold_source<>'regional_default' AND threshold_revision_id IS NOT NULL))`

3. **`app.b013_estimate_decisions`**（**immutable**；一版一終局決定）
   - `id`、`org_id`、`ticket_id`、`version_id`、`decision text NOT NULL CHECK(decision IN ('approved','rejected','more_information'))`、`decided_by uuid NOT NULL`、`reason text CHECK(reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 4000)`、`decided_at timestamptz NOT NULL DEFAULT clock_timestamp()`
   - `CHECK(decision='approved' OR (reason IS NOT NULL))`（reject／more_information 需理由）
   - `UNIQUE(org_id,version_id)`、`UNIQUE(org_id,ticket_id,version_id,id)`
   - `FOREIGN KEY(org_id,ticket_id,version_id) REFERENCES app.b013_estimate_versions(org_id,ticket_id,id) ON DELETE RESTRICT`
   - `FOREIGN KEY(org_id,ticket_id,version_id,decided_by) REFERENCES app.b013_estimate_versions(org_id,ticket_id,id,designated_principal_id) ON DELETE RESTRICT`（決定者綁回版本保存之指定 principal）

4. **`app.b013_repair_emergencies`**（**immutable**；Admin 例外，與屋主核准分離）
   - `id`、`org_id`、`ticket_id`、`version_id`、`category text NOT NULL CHECK(category IN ('water','electricity','safety'))`、`reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 4000)`
   - `authorized_photo_snapshot jsonb NOT NULL CHECK(jsonb_typeof(...)='array' AND jsonb_array_length(...) BETWEEN 1 AND 8)`
   - `authorized_by uuid NOT NULL`、`authorized_at timestamptz NOT NULL DEFAULT clock_timestamp()`
   - `UNIQUE(org_id,version_id)`、`UNIQUE(org_id,ticket_id,version_id,id)`
   - `FOREIGN KEY(org_id,ticket_id,version_id) REFERENCES app.b013_estimate_versions(org_id,ticket_id,id) ON DELETE RESTRICT`
   - Admin 角色、真實照片 bytes 於 gateway／reader 強制（見 W6）。

5. **`app.b013_repair_appointments`**（**immutable 事件列**；B-013 新增，供 B-024）
   - `id`、`org_id`、`ticket_id`、`version_id`、`repair_vendor_job_id uuid NOT NULL`
   - `event_kind text NOT NULL CHECK(event_kind IN ('vendor_proposed','company_confirmed','vendor_rejected','vendor_completion_submitted'))`
   - `proposed_start timestamptz`、`proposed_end timestamptz`、`confirmed_start timestamptz`、`confirmed_end timestamptz`
   - `actor_id uuid NOT NULL`、`occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()`
   - `CHECK(proposed_end IS NULL OR proposed_start IS NULL OR proposed_end>=proposed_start)`、`CHECK(confirmed_end IS NULL OR confirmed_start IS NULL OR confirmed_end>=confirmed_start)`
   - `CHECK(event_kind<>'company_confirmed' OR (confirmed_start IS NOT NULL AND confirmed_end IS NOT NULL))`
   - `UNIQUE(org_id,ticket_id,version_id,id)`
   - `FOREIGN KEY(org_id,ticket_id,version_id) REFERENCES app.b013_estimate_versions(org_id,ticket_id,id) ON DELETE RESTRICT`、`FOREIGN KEY(org_id,repair_vendor_job_id) REFERENCES public.repair_vendor_jobs(org_id,id) ON DELETE RESTRICT`
   - 「目前約訪狀態」由最新事件列推導；`vendor_rejected` 不改 ticket 狀態（規則 `keepTicketOpen`）。

6. **`app.b013_repair_commands`**（**immutable**；actor＋request 冪等 ledger，含 OFF fail-closed 結果）
   - `actor_id uuid NOT NULL`、`request_id uuid NOT NULL`、`org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT`、`ticket_id uuid NOT NULL`
   - `operation_kind text NOT NULL CHECK(operation_kind IN ('submit','decision','emergency','appointment','reminder','close'))`
   - `outcome text NOT NULL CHECK(outcome IN ('recorded','cancelled','rejected_conflict','rejected_disabled','rejected_invalid','rejected_unavailable'))`
   - `expected_head_id uuid`、`requested_version_id uuid`、`payload_sha256 bytea CHECK(payload_sha256 IS NULL OR octet_length(...)=32)`
   - 結果綁定（deferred）：`result_version_id`、`result_decision_id`、`result_emergency_id`、`result_appointment_id`、`result_event_id`
   - `recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()`、`PRIMARY KEY(actor_id,request_id)`
   - `FOREIGN KEY(org_id,ticket_id) REFERENCES public.maintenance_tickets(org_id,id) ON DELETE RESTRICT`；對應 result 的 deferred 複合 FK 至各 immutable 表
   - `CHECK((outcome='recorded') OR (result_version_id IS NULL AND result_decision_id IS NULL AND result_emergency_id IS NULL AND result_appointment_id IS NULL AND result_event_id IS NULL))`（非 recorded 不綁結果）
   - **`rejected_disabled`** 即 flag OFF 之 fail-closed 落點；重放回原結果、payload 改變即拒。

7. **`app.b013_repair_event_outbox`**（**immutable；去重；只記意圖、零送達**）
   - `id`、`org_id`、`ticket_id`、`version_id`、`kind text NOT NULL CHECK(kind IN ('approval_reminder_24h','emergency_owner_notice'))`、`emergency_id uuid`、`designated_principal_id uuid NOT NULL`、`occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()`
   - `UNIQUE(org_id,version_id,kind)` ← **dedupe；`kind` NOT NULL，無 NULL-distinct 漏洞（對應 W3）**
   - `CHECK((kind='emergency_owner_notice')=(emergency_id IS NOT NULL))`
   - `FOREIGN KEY(org_id,ticket_id,version_id) REFERENCES app.b013_estimate_versions(org_id,ticket_id,id) ON DELETE RESTRICT`、`FOREIGN KEY(org_id,ticket_id,version_id,designated_principal_id) REFERENCES app.b013_estimate_versions(org_id,ticket_id,id,designated_principal_id) ON DELETE RESTRICT`、`FOREIGN KEY(org_id,ticket_id,version_id,emergency_id) REFERENCES app.b013_repair_emergencies(org_id,ticket_id,version_id,id) DEFERRABLE INITIALLY DEFERRED`
   - **無任何 delivery／sender 欄位；非 B-028 source／非送達證明。**

**不可變 trigger ＋ RLS ＋ 授權（DO 迴圈，承自 handoff 並擴及 appointments）**：
- `CREATE FUNCTION app.b013_approval_immutable_row() RETURNS trigger`（`RAISE EXCEPTION 'Immutable repair approval history' USING ERRCODE='23514'`）；`REVOKE ALL ON FUNCTION ... FROM PUBLIC,anon,authenticated,service_role`。
- 對 `versions／decisions／emergencies／appointments／commands／event_outbox` 建 `BEFORE UPDATE OR DELETE`（FOR EACH ROW）與 `BEFORE TRUNCATE`（FOR EACH STATEMENT）immutable trigger；**heads 不設**（CAS 可變）。
- 八張表全 `ENABLE ROW LEVEL SECURITY`；`REVOKE ALL ON TABLE ... FROM PUBLIC,anon,authenticated,service_role`。
- **存取路徑**：僅經 SECURITY DEFINER gateway（owner＝專用 schema owner role，持表權）；`GRANT EXECUTE` 於 gateway 給 `service_role`。**此處對新表採比 PROP-11 更嚴的「零直接 service_role 表權」模型**（PROP-11 給 service_role SELECT/INSERT；審批狀態風險更高，故僅開 gateway EXECUTE），§開放問題 1 列此差異待 PE 確認。
- **無 DELETE grant、無 down/DROP 腳本**；撤回優先停用 writer／code rollback（RESTRICT＋immutable 意味不可沿用未更新 demo seed，見 handoff）。

## Gateways（service-only SECURITY DEFINER；簽章 proposed，名待核）

共通契約：`SECURITY DEFINER`、`SET search_path=pg_catalog, app`、**org 由 session 推導**（`app.current_session_org()`／既有 session helper，**非** client 參數／GUC）；進入即檢 flag（`repair_approvals`／`vendor_dispatch`，見 §Flag）→ OFF 即寫 `outcome='rejected_disabled'` 原子回傳、不動任何狀態（**fail closed**）；角色／consent／selected live-or-sandbox org／指定屋主有效性於函式內重查；單一 `BEGIN→一項操作→全 constraint→最後 current-auth→直接 COMMIT`；未知結果保留原 `request_id` UUID；重放回原結果、payload 變即 `rejected_conflict`。

```text
-- 寫入 gateway（B-013 reserve；B-021/B-024 消費）
app.b013_submit_estimate(p_request_id uuid, p_ticket_id uuid, p_expected_head_id uuid,
  p_amount_minor bigint, p_currency char(3), p_minor_unit smallint,
  p_work_scope text, p_evidence jsonb, p_payload_sha256 bytea)
    RETURNS app.b013_estimate_versions         -- manager；超門檻→pending_approval，≤→policy_qualified

app.b013_decide_estimate(p_request_id uuid, p_version_id uuid,
  p_decision text, p_reason text, p_payload_sha256 bytea)
    RETURNS app.b013_estimate_decisions        -- 指定屋主（B-021）；approve/reject/more_information；一版一終局

app.b013_authorize_emergency(p_request_id uuid, p_version_id uuid,
  p_category text, p_reason text, p_photos jsonb, p_payload_sha256 bytea)
    RETURNS app.b013_repair_emergencies        -- Admin only；原子寫 emergency + recordAudit + 立即 emergency_owner_notice intent

app.b013_confirm_appointment(p_request_id uuid, p_version_id uuid, p_vendor_job_id uuid,
  p_event_kind text, p_proposed_start timestamptz, p_proposed_end timestamptz,
  p_confirmed_start timestamptz, p_confirmed_end timestamptz, p_payload_sha256 bytea)
    RETURNS app.b013_repair_appointments       -- vendor/company（B-024）；vendor_rejected 不關單

app.b013_emit_reminder(p_request_id uuid, p_version_id uuid)
    RETURNS app.b013_repair_event_outbox       -- scheduler；僅 pending 版本；dedupe 恰一筆；永不寫 decision

app.b013_close_request(p_request_id uuid, p_ticket_id uuid, p_expected_head_id uuid)
    RETURNS app.b013_repair_commands           -- cancel/original-request recovery；close 不核准、不建工作

app.b013_assert_dispatchable(p_org_id uuid, p_ticket_id uuid, p_version_id uuid)
    RETURNS boolean                            -- 派工守衛：approved ∨ policy_qualified ∨ 有效 emergency 才 true（vendor_dispatch ON 時由 dispatchVendor 呼）

-- 讀取 gateway（B-021/B-024 消費；party-visibility 於 reader 施作、見 W6）
app.b013_manager_view(p_ticket_id uuid)   RETURNS SETOF ...   -- manager：某工單版本/決定/約訪狀態
app.b013_owner_pending()                  RETURNS SETOF ...   -- owner（B-021）：待決清單（session org 範圍）
app.b013_owner_history(p_ticket_id uuid)  RETURNS SETOF ...   -- owner：歷史（含移轉後存取界線，見開放問題 4）
```

- **純解析／規則不進 gateway 的 SQL 層以外**：門檻分岔、新版本觸發、提醒去重語義、vendor 拒絕保持開單等**判定邏輯**集中在 TS 規則模組 `repair-approval-rules.ts`（pure），gateway 只做原子寫入＋constraint＋current-auth，與 `repair-rules.ts` 把驗證抽純函式、副作用留 writer 的切法一致。
- **緊急與提醒為各自可信固定 gateway 原子產生**，驗證仍為同版 pending；不回覆不核准（handoff §不提供行為 5）。

## Flag

- **不新增 flag、reuse registry。** 兩個控制皆 default OFF ＝今日：
  - `REPAIR_APPROVALS*`（proposal 名，`*` 標記）**reconcile 既有 `repair_approvals` 全域控制**（completion-audit／remaining-handoff 均觀測其為 OFF：platform enabled ∧ allowlist ∧ org feature flag，缺一即 OFF）。**沿用，不建第二個競爭開關**（BO 明示「names above never justify creating a second competing switch」）。
  - `vendor_dispatch` 為既有 dispatch 控制，**先對照 code／registry 確認識別名再動**（BO：「Existing MOVE_OUT, consent, dispatch and partner flag identifiers must be confirmed against code/registry before mutation」）；維持 OFF。
- **無 flag seed、無 ON、無 RLS 變更（除本 migration 新表自帶的 RLS/revoke）。** 所有 writer gateway 進入即以 server-side flag resolver 檢查，OFF → `rejected_disabled` fail-closed；**flag 不進純規則模組**（規則保持純函式，gate 留 service／gateway，避免被誤用時旁生寫入）。
- flag OFF ＝今日：`vendor-repair.ts`／`repairs.ts`／`domain.ts` 不改任何呼叫路徑。未來 ON（owner 可見審批／dispatch）屬 B-021／B-024 的使用者可見變更，須走既有 Mode B 判定式、於隔離 local/staging test org 測，default OFF——那不在本 note。

## 錢／權限風險（Class B 判定）

**判定：Class B（跨 org／跨 ticket／跨版本隔離 ＋ 金額門檻 ＋ 偽造核准／誤授權 risk）。** 本契約是「某工單某版估價 → 是否需屋主決定 → 誰可決定 → 可否派工」的決定點；錯一步＝跨 org／跨 ticket 外洩、**以過期門檻重算舊估價**、**偽造屋主已同意**、或**靜默被當核准放行派工**。**不得改變任何既有授權／金流邊界。** 合併前須有獨立審查逐條走完（PRINCIPLES 37 Class B 強制獨立審閱）：

1. **跨 org／跨 ticket／跨版本綁定**：每張子表帶 `(org_id, ticket_id)` 並以複合 FK 綁 head/ticket；decision／emergency／appointment／intent 皆以 `(org_id,ticket_id,version_id)` 綁回版本。審查確認 same-org wrong-ticket INSERT 被 FK 拒（對應 W1）；無任何集合式回傳讓某 org 列舉他 ticket。
2. **org 由 session 推導、非 client**：gateway 不接受 client 傳入 org／role 作為權威；不以 caller-set GUC 為證。審查確認 `designated_*`／`property_id`／`threshold_revision_id` 皆以 session org scope 解析，跨 org parent 拒絕（對應 W2 build-side）。
3. **門檻 strict `>` 不得放寬**：`requires_owner_decision = amount_minor > captured_threshold_minor`（generated STORED）；`=` 門檻為 `policy_qualified`，**不冒稱屋主已同意**。審查對照 TS `thresholdStrictGt` 與 DB generated 欄一致，邊界 `amount=threshold` 兩側行為確定。
4. **門檻 provenance 快照不可變**：版本保存當時 `captured_threshold_minor`／`threshold_source`／`threshold_revision_id`／`threshold_provenance_sha256`；**default 數字之後變更只影響新版本、不得重寫已送出門檻**（Ron 決定）。審查確認 100220／221 門檻變更不回寫既有 version。
5. **指定屋主單一終局、不偽造 session**：`UNIQUE(org_id,version_id)` 一版一決定；`decided_by` 複合 FK 綁回版本保存之 `designated_principal_id`；合法多屋主不要求全員核准。審查確認無以 client actor 冒充屋主、無以 legacy mutable `owner_approval` 當權威；過期／改綁／替換 ownership／幣別精度漂移拒絕新決定。
6. **緊急例外不得偽造核准**（最高風險之一）：emergency 與 owner approval **結構分離**；`authorize_emergency` 需真 Admin（gateway 角色檢）＋ `category∈{water,electricity,safety}` ＋ `reason` ＋ `photos[1..8]`；原子產 audit ＋ 立即 owner-notice intent；**不得偽造屋主決定、不重用他版 override**。審查確認無 owner-decision 旁路。
7. **靜默永不核准、提醒去重**：`emit_reminder` 僅對 pending 版本、`UNIQUE(org_id,version_id,kind)` 去重、**不寫 decision、不改授權**（對應 W3）。審查以「pending 逾 24h 多次觸發」驗只產一筆、狀態不變 approved。
8. **冪等與競態**：`(actor_id,request_id)` PK；重放回原結果、payload 變 `rejected_conflict`；save-close 競爭、自然 session 過期、COMMIT ACK 遺失、deferred trigger 被迫早觸、trigger 例外 rollback 皆須測（handoff §不提供行為 6）。
9. **flag OFF fail-closed 未位移**：OFF → `rejected_disabled`，不新增繞過 pending 的路徑；既有 live writer 路徑 flag OFF 時逐 byte 不變（對應 W7、§Done）。
10. **金額／付款對象／證據**：維持 `REPAIR_EXPENSE_STATUS='draft'`；公司確認最多一筆 reviewed draft、**無自動過帳、不改既有 posted expense**；收據照片為證據非付款／稅務證明。evidence／photo JSON 形狀 **非**不可變 bytes 證明（W6 於 reader 補）。

**金額／付款對象／租約效力**：門檻判定牽動修繕費用與負擔方（L1-RPR／PROP-11 下游），故列 Class B；本項不改既有 vendor 可見／可寫邊界，不動 cost-bearer 分攤。

## PROP-11 inherited W1–W7 matrix

對 PROP-11 verdict（`5f9cc01`）「Writer-activation conditions for B-013/B-021」W1–W7，逐條切分**本項 build-side 現在實作（SQL check／test）** vs **殘留 runtime ON-gate**。B-013 的新表是**審批狀態**表（非 PROP-11 的 `repair_cost_*` 成本表）；下列為「B-013 能在 build-side 強制者」與「須於 reader／flag 啟用時才成立者」之界線，**不 overclaim**。

| W# | PROP-11 條件（摘） | B-013 build-side 現在做到（SQL／測試） | 測試名 | 殘留 runtime ON-gate |
|---|---|---|---|---|
| **W1** | item/allocation/document/job **ticket agreement**；same-org wrong-ticket | 每張子表帶 `(org_id,ticket_id)`、以複合 FK 綁 heads/tickets；decision/emergency/appointment/intent 綁 `(org_id,ticket_id,version_id)`；appointment 綁 `repair_vendor_jobs(org_id,id)`；same-org 錯 ticket INSERT 被拒 | `b013-schema.ticketAgreement`（static）、`b013.pg: wrong_ticket_fk_rejected` | B-013 新表彼此已強制；**與 PROP-11 `repair_cost_items/allocations` 的 join-time agreement 在 B-021/B-024 reader 讀成本列時才成立**（reader 啟用） |
| **W2** | 以 scoped org 解析 statement-line；due-component soft source 以 kind/org/lease | gateway 以 **session org** 解析 `designated_*`／`property_id`／`threshold_revision_id`，跨 org parent 拒絕；`FOREIGN KEY(org_id,property_id)` 綁 `properties` | `b013.pg: designated_owner_cross_org_rejected`、`property_scope_rejected` | `owner_statement_line_id`／`tenant_period_due_components.source_ref_id` 的 soft-source 解析屬 **B-021 statement reader／B-018**，非 B-013；B-013 不讀成本/對帳列 |
| **W3** | NULL-source 冪等＋component 聚合；payment 冪等另立 | event outbox `UNIQUE(org_id,version_id,kind)`（`kind` NOT NULL ⇒ 無 NULL-distinct 漏洞）；command ledger PK `(actor_id,request_id)`；`emit_reminder` 原子去重產一筆 | unit `rules.reminderDedupe`、`b013.pg: reminder_single_intent`、`command_replay_returns_original` | **B-013 無付款** → payment idempotency 明確不在本項；outbox 的真實聚合／送達在 B-028 消費時（非本項） |
| **W4** | supported currency、ceilings、source/aggregate caps、split rounding | `currency char(3) REFERENCES currencies`、`minor_unit 0–4`、`amount_minor>=0`、`captured_threshold_minor>=0`、generated `requires_owner_decision = amount>threshold`（**strict >**） | unit `rules.thresholdStrictGt`、`b013.pg: strict_gt_boundary`、`currency_drift_rejected` | **業務金額上限／aggregate caps／per-org 幣別設定**＝ owner-UX／產品 ON-gate；B-013 只存與比較、不設商業限額 |
| **W5** | audited transitions、immutable finalized history、correction attribution、sanitize money/PII | 六張歷史表 immutable trigger（UPDATE/DELETE/TRUNCATE）；**改動即新版本**（無就地編輯）⇒ attribution 即 version 列；gateway 呼 recordAudit 並 sanitize 金額/PII payload | `b013.pg: immutable_history`、unit `rules.newVersionOnChange`、`audit.sanitizedPayload` | 正式 audit sink 接線＋對 live 資料的 PII 複檢＝ON-gate；B-013 交付 shape 與 trigger |
| **W6** | attachment/storage authz、真實 MIME/hash/photo class、party visibility、accountant 排除 | **結構保留＋build-side 形狀驗證**：emergency `photos[1..8]`、evidence `≤8`、XOR source 存在；reuse `repair-rules.ts` `sniffPhotoMime`／`assertPhotoMeta` 驗 ref 形狀 | unit `rules.evidenceShape`、`rules.emergencyPhotosRequired` | **真實 bytes/hash/generation 驗證、storage 授權讀取、party-visibility＋accountant photo 排除**於 reader 讀時才成立（消費 PROP-11 `repair_cost_visibility`）＝reader ON-gate |
| **W7** | 每個 service-role op scoped authz＋完整 DB privilege/isolation/regression | 八表 RLS ON；`REVOKE ALL` 自 PUBLIC/anon/authenticated/**service_role**；僅 SECURITY DEFINER gateway（owner role 持權）開 EXECUTE 給 service_role；org 由 session；OFF→`rejected_disabled` | `b013.pg: rls_enabled_all`、`no_direct_table_grants`、`off_fail_closed`、`org_isolation`、`role_definer_only` | **完整 staging regression＋reader 啟用＋隔離 org flag flip**＝ON-gate；本項於 disposable clone 驗，不在 hosted apply |

## HITL／AFK

- **AFK（agent 可自行完成）**：migration DDL 撰寫；在 disposable 本機 PG17 clone 的套用／rollback／循環-FK deferred 驗證；純 TS 規則模組與其 table-driven 單測；薄 service（flag-gated）；既有 live 模組 flag-OFF 的 characterization golden；schema 靜態 SQL 測試；PG17 整合測試（RLS/role/org 隔離、OFF fail-closed、immutability、strict >、靜默不核准、dedupe）。
- **HITL（人工定稿／簽核）**：
  - **契約形狀定稿**：八表名／gateway 名／`app.` schema／「零 service_role 直接表權、僅 gateway EXECUTE」是否相對 PROP-11 的 service_role SELECT/INSERT 模型採行（§開放問題 1）。本文件先定為上述較嚴模型，待 PE 回填即轉 AFK。
  - **Class B 獨立審查強制**（PRINCIPLES 37）：合併前獨立審閱逐條走完 §錢／權限風險 1–10（尤重 6 緊急零偽造核准、5 指定屋主單一終局、3 strict >、7 靜默不核准），確認 `repairs.ts`／`vendor-repair.ts`／`domain.ts` flag-OFF 行為零位移。
  - **hosted／staging apply**：Codex 不碰 hosted DB；PE 依 `b013-db-handoff.md`／`b013-b021-remaining-db-handoff.md` 流程核對 catalog／history／roles／grants、備份還原、counts/grants snapshot、target guard 後套用，提供 exact migration SHA／結果／QA，Ron 通知後方續接 reader。
  - **flag flip／staging 資料／owner-vendor UX**：separate decision（CEO/Ron），不在本項。

## 驗證

不寫「跑測試」，寫真實介面／真實輸入／可觀察狀態。證據落 `/workspace/e2e/results/B-013/`。

- **單元（純規則；table-driven）** `repair-approval-rules.test.ts`：
  - `thresholdStrictGt`：amount>threshold → `pending_approval`；amount=threshold 與 amount<threshold → `policy_qualified`（邊界兩側確定、`=` 不視為需核准、不偽造同意）。
  - `newVersionOnChange`：amount／scope／evidence／designated-owner 任一改變 → 需新版本、舊同意不沿用；純 default 數字變更不重寫已送出門檻。
  - `decisionTransitions`：approve/reject/more_information 合法轉移；reject/more_info 需理由。
  - `reminderDedupe`：pending 逾 24h 多次觸發 → 恰一筆 `approval_reminder_24h`；提醒永不轉 approved。
  - `emergencyRequires`：缺 Admin／缺 reason／缺 photos／category 非水電安全 → 拒；齊備 → emergency＋立即 owner-notice intent。
  - `vendorRejectionKeepsOpen`：vendor 拒絕 → `keepTicketOpen`，不改 ticket 狀態。
  - `evidenceShape`／`emergencyPhotosRequired`：reuse `repair-rules.ts` photo 驗證的 ref 形狀邊界（≤8／1..8）。
- **schema 靜態 SQL 測試** `repair-approval.schema.test.ts`：檢 migration 文字含八表、全 RLS ON、REVOKE 自四 role（含 service_role）、無 DELETE grant、immutable trigger 覆蓋六歷史表、generated `requires_owner_decision` 為 strict >、dedupe `UNIQUE`、composite org＋ticket FK、threshold_source/revision 配對 CHECK。
- **gateway 靜態** `repair-approval.gateway.test.ts`：service 於 flag OFF 不產生任何 production caller；flag resolver 於 OFF 回 fail-closed、不呼 gateway。
- **PG17 整合** `e2e/pg/b013-repair-approval.pg.test.ts`（disposable clone）：
  - `rls_enabled_all`／`no_direct_table_grants`／`role_definer_only`：PUBLIC/anon/authenticated/service_role 直接對表讀寫被拒；僅 gateway EXECUTE 可寫。
  - `org_isolation`／`wrong_ticket_fk_rejected`／`designated_owner_cross_org_rejected`：跨 org／跨 ticket／跨版本拒絕。
  - `off_fail_closed`：`repair_approvals`／`vendor_dispatch` OFF → 所有 writer `rejected_disabled`、零狀態變更。
  - `immutable_history`：對六歷史表 UPDATE/DELETE/TRUNCATE 皆 raise；head CAS 僅改 `current_version_id`。
  - `strict_gt_boundary`：amount=threshold 不需決定；amount=threshold+1 需決定。
  - `reminder_single_intent`／`command_replay_returns_original`：去重與冪等（重放回原結果、payload 變 `rejected_conflict`）。
  - 循環 FK：head 持 server 預鑄 version UUID，deferred FK 交易末成立；完整插入成功、失敗 rollback。
- **回歸閘（flag OFF byte-identical）**：`repairs.ts`／`vendor-repair.ts`／`domain.ts` pre/post characterization golden 逐欄位相同；既有 unit/RLS gate 綠（不回退 PROP-11、PROP-01b、PROP-10 任何結果）。
- **feature map**：使用者＝manager 於工單送估價、owner 決定、vendor 排程（flag ON 隔離 org）；agent 驅動＝以 fixture 直接呼 gateway／規則；可觀察＝私有表不可變證據列、恰一筆提醒、零送達、flag OFF 時零新寫入。

## 不做什麼

- **不開任何 flag ON、不 seed flag**；`repair_approvals`／`vendor_dispatch` 維持 OFF ＝今日。
- **不改既有 migration、不重跑 100217/218/220/221**；只新增一支 forward-only `20261105170000_b013_repair_approval_state.sql`。
- **不在 hosted／prod 套用 migration、不 merge main**（待 CEO GO）；hosted apply 由 PE 另行執行。
- **不改 `repairs.ts`／`vendor-repair.ts`／`domain.ts` 的 flag-OFF 行為**（僅於 flag ON 時新增守衛呼叫路徑）；不改 `repair-rules.ts`（僅複用其 photo 驗證與 idiom）。
- **不實作真實 Email／LINE／通知中心送達**＝ messaging／B-028；event outbox 只記意圖、零送達、非 B-028 source／非送達證明。
- **不做自動付款、不過帳、不改既有 posted expense**；維持 `REPAIR_EXPENSE_STATUS='draft'`；收據為證據非付款。
- **不以門檻變更重寫已送出版本**；不以 legacy mutable `owner_approval`／`estimated_cost_minor` 當權威。
- **不偽造屋主 session／屋主決定**；緊急例外與屋主核准結構分離、不互冒。
- **不做 owner approval cards／pending 清單 UI**＝ B-021；**不做 vendor 接受／排程／完成 UI**＝ B-024；本項只給其後端契約。
- **不新增 flag／RLS 以外變更、不建第二個競爭 dispatch／approvals 開關、不發明不存在的表／flag／函式名**；新函式／模組名標 **待核**。
- **不宣稱 reader 層 W2/W6 已滿足**（statement-line/due-component 解析、真實 photo bytes／party-visibility／accountant 排除屬 reader ON-gate）；**不宣稱 done = 啟用**。
- **不動 PROP-MF／BO 排序、不碰 messaging、不碰 `auth.ts`／`perms.ts`／session 身分面**（PROP-01a/01b 範圍）。

## 開放問題（可非同步填答）

1. **表授權模型**：對新八表採「`REVOKE ALL` 含 service_role、僅 SECURITY DEFINER gateway EXECUTE」（本文件採，較 PROP-11 的 service_role SELECT/INSERT 嚴），或與 PROP-11 一致授 service_role 直接 SELECT/INSERT？建議前者（審批狀態風險更高）。（Ron／PE）
2. **命名定案**：migration `20261105170000_b013_repair_approval_state.sql`、八表名、gateway 名、`src/server/repair-approval-rules.ts`／`repair-approval.ts` 可否定案？（Ron／CEO）
3. **`vendor_dispatch` 識別名**：對照 code／registry 確認既有 dispatch flag 的真實識別名，確不建第二開關？（PE per BO）
4. **屋主移轉後歷史存取界線**：`owner_history` 讀取在 ownership 移轉後對舊／新屋主的可見範圍（completion-audit 要求「define historical access after transfer; do not invent missing policy」）——需產品界定。（Ron／B-021 owner）
5. **appointments 建模**：採 immutable 事件列（本文件採，狀態由最新列推導）或小型可變＋CAS 表？建議事件列以與其餘 immutable 歷史一致。（PE／B-024 owner）
6. **reset／retention**：RESTRICT＋immutable trigger 意味不能沿用未更新 demo seed／purge；phase-2 前的 reset／保留方案需 PE 定（不以 disable trigger 繞過）。（PE／CEO）
7. **B-021/B-024 reader 啟用的 W2/W6 契約**：reader 讀 PROP-11 `repair_cost_*`／`repair_cost_visibility` 時的 party-visibility／accountant 排除與 statement-line 解析，是否於各自 B 項補？（確認不回流本 note）（Ron）

## 判定：PROCEED（BUILD-ONLY）

**PROCEED。** 本設計把 B-013 由 `partial` 推進至 `done（build-only / flag-OFF）`：交付一支 forward-only migration（合併定稿 handoff 六表＋appointments＋去重 outbox，RLS/revoke/composite FK/immutable trigger/service-only SECURITY DEFINER gateway、org 由 session、OFF fail-closed）、純 TS 規則模組、薄 flag-gated service，並對 PROP-11 W1–W7 明確切分 build-side 已做 vs reader/flag ON-gate。**未觸及任何 STOP 條件**（無 flag ON、無 seed、無 hosted apply、無 main merge、無真實送達／自動付款、無偽造核准、既有 live 模組 flag-OFF 零位移）。啟用（flag flip、staging 資料、owner/vendor UX、reader W2/W6 滿足）為 separate decision，明列不 overclaim。

## Implementation checklist for Codex

**新建檔**
- `supabase/migrations/20261105170000_b013_repair_approval_state.sql`（ts > `20261105160000`）：八張 `app.b013_*` 表（heads CAS／versions／decisions／emergencies／appointments／commands／event_outbox）＋ immutable function/trigger（六歷史表）＋ 八表 RLS ON＋`REVOKE ALL` 自 `PUBLIC,anon,authenticated,service_role`＋ SECURITY DEFINER gateway（owner role 持權、`GRANT EXECUTE` 給 `service_role`）。完整 `BEGIN…COMMIT`、`SET LOCAL lock_timeout/statement_timeout`、循環 FK `DEFERRABLE INITIALLY DEFERRED`、無 DROP／無 down 腳本。
- `src/server/repair-approval-rules.ts`（**pure**，沿用 `repair-rules.ts` idiom：`FlowError`、exported const 陣列、無 I/O）：`APPROVAL_STATES`／`DECISIONS`／`EMERGENCY_CATEGORIES`／`EVENT_KINDS` 常數；`classifyThreshold(amount,threshold)`（strict >）、`requiresNewVersion(prev,next)`、`nextDecisionState(...)`、`reminderDue(now,submittedAt,hasDecision)`、`assertEmergency({role,category,reason,photos})`、`vendorRejectionKeepsOpen(...)`、`evidenceShapeOk(...)`。
- `src/server/repair-approval.ts`（**薄 service**，flag-gated）：flag resolver（`repair_approvals`／`vendor_dispatch`）→ OFF 即 fail-closed、不呼 gateway；ON 時呼對應 SECURITY DEFINER gateway，sanitize audit payload。**無 UI 變更**。

**測試檔**
- `src/server/repair-approval-rules.test.ts`（unit，table-driven：threshold strict >、newVersionOnChange、decisionTransitions、reminderDedupe、emergencyRequires、vendorRejectionKeepsOpen、evidenceShape）。
- `src/server/repair-approval.schema.test.ts`（static SQL：八表／RLS／revoke 含 service_role／無 DELETE grant／immutable trigger／generated strict >／dedupe UNIQUE／composite FK／threshold 配對 CHECK）。
- `src/server/repair-approval.gateway.test.ts`（static：flag OFF 無 production caller、fail-closed 不呼 gateway）。
- `e2e/pg/b013-repair-approval.pg.test.ts`（PG17 整合，disposable clone：`rls_enabled_all`／`no_direct_table_grants`／`role_definer_only`／`org_isolation`／`wrong_ticket_fk_rejected`／`designated_owner_cross_org_rejected`／`off_fail_closed`／`immutable_history`／`strict_gt_boundary`／`reminder_single_intent`／`command_replay_returns_original`／循環 FK deferred）。
- characterization golden：`src/server/repairs.characterization.test.ts`／`vendor-repair.characterization.test.ts`（flag OFF pre/post byte-identical）。

**不動（flag-OFF byte-identical；僅 flag ON 新增守衛路徑）**
- `src/server/repairs.ts`、`src/server/vendor-repair.ts`、`src/server/domain.ts`、`src/server/repair-rules.ts`、既有 100220/221 門檻設定與其 route/pages、`auth.ts`／`perms.ts`／session 身分面、PROP-11 migration 與 `repair-cost.ts`。

**npm scripts to register**（對照既有 `test:unit`／RLS gate 命名慣例）
- 把 `repair-approval-rules.test.ts`／`*.schema.test.ts`／`*.gateway.test.ts` 納入既有 `test:unit`（無須新 script；確認 glob 覆蓋 `src/server/*.test.ts`）。
- 新增 `"test:b013:pg": "<PG17 integration runner> e2e/pg/b013-repair-approval.pg.test.ts"`（disposable clone；與既有 RLS/PG 測試 harness 同機制）。
- 將新 migration 加入既有 migration 清單／ordering 檢查（`supabase/migrations` 目錄序、BO order check 若涵蓋）；**不重跑既有已套用檔**。
- 證據輸出目錄 `/workspace/e2e/results/B-013/`（schema diff、PG17 結果、characterization golden、counts/grants snapshot）。

**合併前**
- Class B 獨立審查逐條走 §錢／權限風險 1–10（重點 6 緊急零偽造核准、5 指定屋主單一終局、3 strict >、7 靜默不核准、9 flag-OFF 零位移）。
- disposable PG17 clone 驗套用/rollback/循環-FK/immutability；**不碰 hosted/prod**。
- flags OFF、不 merge main（待 CEO GO）；hosted apply、flag flip、staging 資料、owner/vendor reader UX 皆為 separate decision，Ron/PE 核。

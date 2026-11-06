# 設計說明 — B-024（Vendor accept／reject／schedule／completion UI，L2 vendor-decision ＋ approval-lock）

> 存成 `20-build/specs/B-024-design.md`。
> 範本：`20-build/specs/B-013-design.md`／`20-build/specs/B-021-design.md`（同 lane 的 reserve-once 契約保留者與 owner 決定端，CEO 2026-11-03 核准之 design-note 範式）。用詞以 `/GLOSSARY.md` 為準（org／staff／portal／live／sandbox／vendor token／manager／owner／designated principal）。
> Stack：**App 分支 `feat/b-024-vendor-job-ui`，stack 於 `feat/b-021-owner-repair-decisions` @ `3d31326`（Draft PR #29，base＝B-013 `feat/b-013-vendor-dispatch-closeout`；B-013 head `b811f80`）**。此 SHA 已含 B-013 定稿 migration `20261105170000_b013_repair_approval_state.sql`（7 張 `app.b013_*` 表 ＋ service-only gateway）與 B-021 reader migration `20261105180000_b021_repair_approval_reads.sql`（三支讀取 gateway ＋ `b013_appointment_job_guard` BEFORE INSERT trigger）。B-024 **stack 於 B-021 之上**（stacked PR，base＝PR #29 head，非 main）；**不 rebase、不 merge main（待 CEO GO）、不碰 prod**。B-013／B-021 schema 在其 QA 期間若變更，B-024 依最終 SHA 重綁。
> Hub design 落於 `pe/b-024-design`（自 `e908adb`）。BUILD-ORDER 單一狀態欄位可由 `todo` 推進至 `in_progress`／`verifying`／`done（build-only / flags OFF）` 並附 note；維持 52-item order、0 violations；app BO mirror 與 hub **byte-identical**。
> 類別：**B（權限／隔離＋金額門檻 risk）**。BO v2 row #13，status `todo`。相依：**B-013（#11 lane 契約保留者；本項消費其 `b013_repair_appointments` 事件契約、`b013_record_appointment`／`b013_dispatch_allowed` gateway 與 TS `recordAppointment`／`dispatchAllowed`）＋ B-021（#12 owner 決定端 ＋ reader／trigger）**。foundation PROP-11（PASS-with-conditions @ `5f9cc01`）。本項為該 shared repair-state lane 的 **vendor 端 UI 消費者**：在 `/v/[token]` 上交付 vendor 接單／拒單／建議時段／開工／完工回報，並以 server 強制 B-013 審批狀態（待屋主核准鎖），**不另建審批模型、不重算門檻、不建第二個競爭開關**。涵蓋能力：`CAP-V-01`／`CAP-V-02`／`CAP-V-03`、journey J5（vendor 分支）。
> **判定：PROCEED（BUILD-ONLY），將 B-024 由 `todo` 推進至 `done（build-only / flags OFF）`。** 交付：(1) **flag-gated vendor-job 控制**（接單／拒單／建議時段／公司確認〔staff，minimal〕／開工／完工回報缺照片必填原因），全部在 `vendor_dispatch` ∧ `repair_approvals` OFF（＝今日）時 **不 render、不呼任何 gateway**；(2) **server 端 approval-lock**：待屋主核准時 `/v/[token]` 顯示「待屋主核准」、開工／完工控制停用，且 **server 亦呼 `dispatchAllowed` 拒絕**（UI 停用非唯一防線）；(3) **薄 server service** `vendor-job.ts`（薄 wrapper，flag ON 才呼 B-013 gateway）＋純顯示規則擴充；(4) **至多一支 forward-only migration**，**僅在** inspect `b013_repair_appointments`／commands schema 後確認 reason／response 欄位真缺時才提，優先把原因存於事件列／command payload、不新建表。**不開任何 flag ON、不 seed flag、不改既有 migration、不碰 messaging／真實寄送／LINE push／自動付款、不自動結案、不繞過公司核對。** 未觸及任何 STOP 條件。
> **本設計明確不宣稱「done = 啟用」。** flag flip、staging vendor 資料、vendor／staff 實際 live UX、reader 對 live 的 PII／storage 複檢一律列為 runtime ON-gate（見 §W1–W7、§繼承 ON-gates、§不做什麼），不 overclaim。

---

## 使用者故事／能力 ID

- **覆蓋**：L2 — `CAP-V-01`／`CAP-V-02`／`CAP-V-03`、journey **J5（vendor 接受／排程／完成分支）**。把「vendor 以 token 進入**單一工單** → 見到該案目前估價版本的審批狀態（超門檻且未核准 → 待屋主核准鎖）→ 接單（確認或建議時段，待公司確認）／拒單（須原因，原報修保持 open）→ 開工 → 完工回報（缺處理後照片必填原因，送出後待公司核對、不自動結案）」這條 **vendor 決定與完成** 路徑，收斂成 **消費 B-013 事件契約＋dispatch 守衛的一個 flag-gated 的 vendor UI／server caller**，而非另建審批模型或自判門檻。
- **對應 spec／BO**：`B-024-spec.md`（本項；scope＝single-job accept/reject/proposed time、company-confirmed appointment、photos、completion reason、enforce B-013 approval state；out of scope＝token-derived history access、auto-closing on vendor submission）、`B-013-spec.md`（shared schema／事件契約提供者）、`B-021-spec.md`（owner 決定端，提供解鎖的核准來源與 reader／trigger）。BO v2 note：「B-013/B-021/B-024 share one repair-state contract. Reserve their shared files once.」本 note **消費** reserve-once，**不新增第二審批模型、不建第二個競爭開關**。
- **對應既有程式／資料（build-side 已存在，本項消費／驗證，不重建）**：
  - **B-013 已交付（`b811f80`）**：`app.b013_repair_appointments`（immutable 事件列；`event_kind ∈ vendor_proposed｜company_confirmed｜vendor_rejected｜vendor_completion_submitted`；org／ticket／version 複合 FK ＋ `repair_vendor_job_id` 複合 FK）；service-only SECURITY DEFINER gateway `b013_record_appointment`、`b013_dispatch_allowed`；session-validated actor `b013_actor`、flag resolver `b013_approvals_enabled`、idempotent `(actor,request)` ledger、OFF→`rejected_disabled`。TS wrapper `recordAppointment(session,{requestId,versionId,vendorJobId,eventKind,proposed*/confirmed*})`、`dispatchAllowed(session,{versionId})→boolean`（approved ∨ policy_qualified ∨ 有效 emergency 才 true）。
  - **B-021 已交付（`3d31326`）**：owner decide production caller（`b013_decide_estimate`）＋ 三支 reader；`manager_view` 回 `appointment_*` 欄位（read-only）；`b013_appointment_job_guard` BEFORE INSERT trigger（job org/ticket 須相符，23503）。**本項消費 approve 結果作為解鎖來源、消費 appointment reader 形狀；不改 B-021 任何行為。**
  - **既有 `/v/[token]`**：`src/app/v/[token]/page.tsx`（`vendor-page-today.tsx`）— `loadVendorJob(token)` ＋ report form（done／cost／photos）經 `actionVendorReport`→`submitVendorReport`；photos 經 `TicketPhotoUpload`（sign/confirm）＋ `/api/vendor-jobs/{token}/photos/{id}`（link check 於 route）。**flag OFF 路徑逐 byte 不變**是本項首要保證。
  - **既有純規則範式**：`repair-approval-rules.ts`（pure；`keepTicketOpen`／`assertDecision` idiom）、`repair-rules.ts`（`FlowError`、photo sniff／MIME、`vendorCostMinor` 整數金額）。本項新規則沿用 idiom、不改該檔。
- **刻意不覆蓋**（＝其他 B 項或 runtime ON-gate）：
  - **owner 決定 UX／pending 清單**＝ B-021；本項只**讀**審批/dispatch 狀態、不呼 `b013_decide_estimate`、不建 owner UI。
  - **manager 送估價／新版本**＝ B-013 `b013_submit_estimate`；本項不送估價、不重算門檻。
  - **token-derived history access**＝ 明示 out of scope；vendor 只見**本案當前版本**，不開放歷史工單／跨案檢視。
  - **auto-closing on vendor submission**＝ 明示 out of scope；完工只寫 `vendor_completion_submitted` 事件，**永不改 ticket 狀態為 resolved/closed、永不跳過公司核對**。
  - **真實 Email／LINE push／通知中心送達**＝ messaging／B-028／B-039；本項不送任何通知。
  - **B-025 onboarding／docs、B-026 estimates／accounts**＝ 非本項。
  - **flag flip、seed ON、staging 灌入、prod/main**＝ CEO／Ron 的 separate decision。

## Done means（build-only）

一句話：**對 stack `3d31326`，B-024 新增 flag-gated vendor-job 控制與一個薄 server caller（接單／拒單／建議時段／公司確認／開工／完工，皆呼既有 B-013 `recordAppointment`／`dispatchAllowed`），至多一支僅在 reason 欄真缺時才提的 forward-only migration；在 `vendor_dispatch`／`repair_approvals` 皆 OFF（＝今日）時 `/v/[token]`（`vendor-page-today.tsx`）與 `submitVendorReport` 每一條路徑逐 byte 行為不變；在 flag ON 的隔離測試 org 中，vendor 以 token 僅見本案當前版本，超門檻且未核准 → 顯示「待屋主核准」且開工／完工 UI 停用、server 亦以 `dispatchAllowed` 拒絕，owner approve 或 Admin 緊急後解鎖；拒單須原因且原報修保持 open（`vendor_rejected`→`keepTicketOpen`，B-013 既有規則）；完工 → `vendor_completion_submitted`、缺處理後照片必填原因、copy「已回報，待公司核對」、永不自動結案；所有新寫入經 stable server-rendered `requestId` 冪等、重放回原結果、payload 變即拒；PROP-11 W1–W7 中可由 build-side 強制者已強制並測到，其餘明列為 reader／flag／storage ON-gate。**
- **Staging（stack SHA）**：在 B-021 PR #29 head `3d31326` 之上 build、綠燈；任何新 migration 在 disposable 本機 PG17 clone（已套 B-013＋B-021 migration）套用成功（完整 BEGIN→COMMIT 原子、函式／欄位 REVOKE/GRANT 正確、rollback 驗證）。**不在 hosted／prod 套用**；hosted apply 由 PE 依 handoff 流程另行執行。
- **flags OFF ＝今日**：`vendor_dispatch`（既有 dispatch 控制，**先對照 code／registry 確認識別名再動**）維持 OFF；`repair_approvals`（＝ `REPAIR_APPROVALS*` proposal 名，reconcile 既有全域控制：platform enabled ∧ allowlist ∧ org feature flag，缺一即 OFF）維持 OFF。**不新增 flag、不 seed ON；completion-reason 行為不另立 `VENDOR_COMPLETION_REASON*` 開關**（見 §Flag）。
- **可觀察**：
  - **flags OFF**：`/v/[token]` render 與今日逐 byte 相同（相同 `brandV2Enabled`／`loadVendorJob`／`VendorLinkDetails`／`renderReportControls` 呼叫序、相同 `data-testid`／`data-v2-*`、相同 `actionVendorReport`→`submitVendorReport` 路徑與既有 `reported`/cost/photo 行為）；`vendor-job.ts` 的 approval-lock／accept／reject／complete-event 分支在 OFF 時 **short-circuit、不呼任何 gateway、不 render 新控制**；靜態掃描：無新 production caller 進入 live route 的 ON 分支。
  - **flag ON（隔離 org）**：超門檻且未核准版本 → 頁面顯示「待屋主核准」、開工／完工控制 `disabled`，且直打 server action／route 時 `dispatchAllowed` 回 false → 開工／完工被拒；owner approve（或 Admin 緊急）後 `dispatchAllowed` 轉 true → 解鎖。accept → `recordAppointment(company_confirmed｜vendor_proposed)`；reject（填原因）→ `recordAppointment(vendor_rejected)` 且 ticket 保持 open；完工缺處理後照片未填原因 → 被拒（規則＋server），填原因後 → `vendor_completion_submitted`、copy「已回報，待公司核對」、ticket 狀態不變。
  - revoked/expired token → `loadVendorJob` 回 invalid capability → 工單／照片一律拒（既有行為，本項不放寬）；photo 仍 id-only 經既有 link-checked route，不洩漏他方照片。
- **BUILD-ORDER**：本 B 項單一狀態欄位維持一項：`todo → done（build-only / flags OFF）`。啟用（flag ON、staging vendor 資料、live vendor/staff UX、reader 對 live PII/storage 複檢）是 separate decision，不在此欄位。**B-024 build-only 完成只要求 B-013／B-021 schema 存在（已於 `b811f80`／`3d31326`／staging），不要求其 flag-ON 啟用。**

## 端到端 tracer bullet

最小可行、**只走 vendor 接受／排程／完成面**的一條路徑（本 SHA 後，於 flag ON 隔離 org 以整合測試驅動；flags OFF 時此路徑不存在、`/v/[token]`+`submitVendorReport` 不改任何既有行為）：

1. **open（vendor / token）**：vendor 以 token 進 `/v/[token]`；`loadVendorJob(token)` 解得本案（`job_id`／`org_id`／`ticket_id`／當前 version）。revoked/expired → invalid capability → 拒（既有）。
2. **approval-lock 判定（server / CAP-V-01）**：`vendor-job.ts` 以 session（org 由 session 推導，非 client）呼 `dispatchAllowed(session,{versionId})`。false（超門檻且未 approved／policy_qualified／emergency）→ 頁面 render「待屋主核准」、開工／完工控制 `disabled`；true → render 可操作控制。**server 同時在開工／完工 action 內再呼一次 `dispatchAllowed`，UI 停用非唯一防線（defense-in-depth）。**
3. **accept / propose（vendor / CAP-V-02）**：vendor 接單 → 若直接確認公司時段則 `recordAppointment(..., eventKind:'company_confirmed', confirmedStart/End)`（staff path，minimal, flag-gated）；若建議時段則 `eventKind:'vendor_proposed', proposedStart/End`（待公司確認）。`requestId` 為 server-rendered hidden field（stable）。
4. **reject（vendor / CAP-V-02）**：拒單 **須原因**（form 必填＋pure rule `assertVendorResponse({eventKind:'vendor_rejected', reason})`）→ `recordAppointment(..., eventKind:'vendor_rejected', reason)`。規則回 `keepTicketOpen`，**ticket 狀態不變**（B-013 既有規則）；原報修保持 open。
5. **complete（vendor / CAP-V-03）**：完工回報 → 若無處理後照片，`reason` **必填**（pure rule `assertCompletion({hasAfterPhoto, reason})`）→ `recordAppointment(..., eventKind:'vendor_completion_submitted', reason?)`。UI copy「已回報，待公司核對」；**不改 ticket 狀態、不觸發結案、不跳過公司核對**。cost 若於此路徑回報，續走既有 `vendorCostMinor` 整數金額路徑（不新增金額欄）。
6. **可觀察結果**：每個事件都在 `app.b013_repair_appointments` 留下不可變、org／ticket／version 綁定、`(actor,request)` 冪等的證據（`b013_appointment_job_guard` 保 job org/ticket 相符）；重放同 `requestId` 回原結果、payload 改變即拒；跨 org／跨 ticket／跨版本一律拒。**查 DB：無任何 ticket close 列、無真實送達列、flags OFF 時無任何新寫入。**

## Caller-first API（呼叫端優先）

**不新增 B-013 寫入 gateway；全部消費既有契約。** 新增薄 server service 與 flag-gated UI。

```text
-- src/server/vendor-job.ts（薄 wrapper；flag ON 才呼 gateway；OFF→short-circuit）
resolveVendorJobState(session, {token})
    → { versionId, dispatchAllowed: boolean, locked: boolean, currentEvent: 'none'|'vendor_proposed'|'company_confirmed'|'vendor_rejected'|'vendor_completion_submitted' }
    -- 以 loadVendorJob 解 job→ticket→當前 version；呼 B-013 dispatchAllowed(session,{versionId})
    -- locked = !dispatchAllowed（＝ CAP-V-01「待屋主核准」）；OFF→不呼、回 null（頁面走今日路徑）

respondVendorJob(session, {token, requestId, action:'accept_confirm'|'propose'|'reject', times?, reason?})
    → ApprovalResult   -- 呼既有 recordAppointment（company_confirmed｜vendor_proposed｜vendor_rejected）
submitVendorCompletion(session, {token, requestId, hasAfterPhoto, reason?})
    → ApprovalResult   -- 呼既有 recordAppointment(vendor_completion_submitted)；不改 ticket 狀態

-- src/server/vendor-job-rules.ts（pure；沿用 repair-approval-rules.ts idiom）
assertVendorResponse({action, times, reason})   -- reject 須 reason；propose 須 proposedStart/End；company_confirmed 須 confirmedStart/End
assertCompletion({hasAfterPhoto, reason})        -- !hasAfterPhoto ⇒ reason 非空（FlowError 'errors.required'）
// 不含 flag（規則保持純函式）；start/complete 的核准判定由 server 以 dispatchAllowed 施作

-- Routes / actions（新；全 flag-gated，stable server-rendered requestId）
POST /api/vendor-job-response        -- accept/propose/reject；UUID requestId 必填；OFF→rejected_disabled
POST /api/vendor-job-completion      -- 完工事件；UUID requestId 必填；OFF→rejected_disabled
// actionVendorReport→submitVendorReport（既有 cost/done/photo）保留；ON 時於其後追加 completion 事件，OFF 時完全不變
```

- **flag 落點（defense-in-depth，OFF byte-identical 首要保證＝page short-circuit）**：(1) `vendor-page-today.tsx` 以 server-side resolver 決定是否 render 新控制，OFF→逐 byte 等同今日；(2) `vendor-job.ts` 進入即檢 flag → OFF short-circuit；(3) 既有 `b013_record_appointment`／`b013_dispatch_allowed` OFF→`rejected_disabled`／false（fail closed）。
- **approval-lock 兩層**：UI `disabled` ＋ server action 內 `dispatchAllowed` 重判——acceptance「Given pending approval, when starting/completing via UI or direct API, then both are denied」要求 server 拒絕，不得僅靠 UI。

## 資料／migration

- **預設：reuse B-013／B-021，不建表、不加 table grant。** accept/propose/reject/completion 全部映到既有 `app.b013_repair_appointments` 事件列與既有 gateway。
- **reason／response 欄位**：mandate 要求 **inspect `b013_repair_appointments` 與 commands schema 後**才決定。既有 appointment 事件列（`b013-sql-appointment-excerpt.sql`）含 `event_kind`／`proposed_*`／`confirmed_*`／`actor_id`／`occurred_at`，**excerpt 未見 `reason`/`response` 欄**；`recordAppointment` TS payload 亦無 reason 欄。
  - **若** inspect `3d31326` 後確認 reason/response 真缺（且 command payload 無可承載處）：提**一支** forward-only migration `20261105190000_b024_vendor_completion_reason.sql`（ts > `20261105180000`），**僅**對 `app.b013_repair_appointments` 加 **nullable** `response_reason text`（＋長度／空白 CHECK），並以 CHECK 強制 `event_kind='vendor_rejected' ⇒ response_reason IS NOT NULL`；同步擴充 `b013_record_appointment` gateway 與 `recordAppointment` TS 的 reason 參數。**不新建表**（immutable 事件列上存 reason 優於第二張表）。
  - **若** 既有 schema 已有可承載欄位（或 command payload 可存）：**不提 migration**，reason 存於事件/command payload。
  - **「完工缺照片必填原因」**的照片數為 app-side 知識：DB 不強制 completion 的 photo↔reason 關係（避免把 storage 計數帶進 gateway），由 pure rule `assertCompletion` ＋ server 強制；DB 只強制 `vendor_rejected` 的 reason 必填。
- **任何新 SQL 的硬規矩**：`SECURITY DEFINER`、`SET search_path=pg_catalog, app`（pinned）、**org 由 session 推導**（非 client 參數／GUC）、service_role-only（`REVOKE ALL FROM PUBLIC,anon,authenticated`；欄位 GRANT 最小化）、org／env-bound、**flags OFF 時 fail closed**（`rejected_disabled`）。新欄位設於 immutable 事件列 → 僅 INSERT 時寫入，受既有 immutable trigger 保護（BEFORE UPDATE/DELETE 拒）。
- **B-021 `b013_appointment_job_guard` BEFORE INSERT trigger** 繼續保 appointment→job 的 org/ticket 相符（23503）；本項不改該 trigger。

## Flag

- **不新增 flag、reuse registry。** 控制皆 default OFF ＝今日：
  - `vendor_dispatch`（既有 dispatch 控制）：**先對照 code／registry 確認識別名**（BO：「Existing MOVE_OUT, consent, dispatch … names above never justify creating a second competing switch」）再動；vendor accept/reject/schedule/completion 事件路徑在其 OFF 時 fail closed。
  - `repair_approvals`（＝ `REPAIR_APPROVALS*` proposal 名，reconcile 既有全域控制）：approval-lock（CAP-V-01，`dispatchAllowed`）所依之審批狀態由其 gate；OFF→`dispatchAllowed` false／`rejected_disabled`。
  - **`VENDOR_COMPLETION_REASON*`**：mandate 要求「reconcile if needed，do NOT invent a second competing switch — confirm against code/registry first」。**先掃 code／registry 確認是否已存在識別名**；completion-reason 行為**不另立新開關**，掛在 `vendor_dispatch`（並以 `repair_approvals` 提供 approval-lock）之下。若 registry 已有該 proposal 名，僅 reconcile 文件、不新 seed。
- **flag 不進 pure 規則模組**（規則保持純函式）；多處一致 fail-closed，但 OFF byte-identical 的首要保證是 `vendor-page-today.tsx` short-circuit。

## 金額／權限 risk

- **金額（W4）**：B-024 **不新增金額欄、不改金額模型**。完工回報的 cost 續走既有 `submitVendorReport`→`vendorCostMinor` 的 **minor-unit 整數**路徑（SQL bigint、TS string/BigInt）。不設商業上限／aggregate caps（＝產品 ON-gate，非本項）。completion-reason 為文字，無金額語義。
- **權限／token（W2／W6／W7）**：
  - **token pinning**：所有新控制以 `/v/[token]` 的 token 解 job，**版本／org 由 server 從 job→ticket 推導、非 client 傳入**；session.orgId 進 gateway。
  - **approval-lock 不可繞**：server action 內 `dispatchAllowed` 重判，直打 API 亦被拒（acceptance 明列）。
  - **photo id-only / 不洩漏他方**：完工照片續用既有 `TicketPhotoUpload`（sign/confirm）＋ `/api/vendor-jobs/{token}/photos/{id}`（link check 於 route），**id-only、不取 bytes、不驗 MIME/hash**（＝ storage authz ON-gate）；reader（若回 appointment/photo refs）projected id-only，不向 owner/accountant 等他方暴露。
  - **revoked/expired token**：`loadVendorJob` 回 invalid capability → 工單／照片一律拒（既有，不放寬）。
  - **immutability（W5）**：appointment 事件（含 reason）immutable，受 B-013 trigger 保護。

## HITL／AFK

- **HITL（人需介入）**：(1) `vendor_dispatch`／`repair_approvals` flag flip（CEO／Ron）；(2) hosted／prod migration apply（PE 依 handoff，非本設計）；(3) owner 實際核准（解鎖 approval-lock 的真實事件，屬 B-021 runtime）；(4) **公司核對**完工回報（CAP-V-03「待公司核對」，vendor 送出後需 staff 複核，**系統永不自動結案**）；(5) staff 的 company-confirmed 時段（minimal path）由人操作。
- **AFK（可無人推進）**：build、單測／PG 整合測試、disposable PG17 clone 的 migration 套用／rollback、flag-OFF characterization、CI 綠燈、evidence 收斂——皆可在 stack SHA 上無人完成，不觸 hosted/prod。

## 驗證（tests/evidence）

證據收斂至 **`/workspace/e2e/results/b-024-1105/`**（legacy 路徑 `/workspace/e2e/results/B-024/` 於 spec；二者皆留 note 指向 `b-024-1105`，避免散落）。

- **OFF characterization（首要）**：以既有 fixtures render `/v/[token]` 並跑 `submitVendorReport`，pre/post **逐 byte／逐欄位相同**（golden：相同 `loadVendorJob`／`VendorLinkDetails`／`renderReportControls` 輸出、相同 `actionVendorReport` 行為、相同 `reported`/cost/photo 分支）；靜態掃描確認 ON 分支無新 production caller。
- **State matrix（flag ON 隔離 org）**：`pending`（超門檻未核准 → 待屋主核准＋開工/完工 UI disabled＋server `dispatchAllowed` 拒）／`approved`（解鎖）／`emergency`（Admin 緊急 → 解鎖）／`rejected`（拒單填原因 → `keepTicketOpen`，ticket 不變）／`expired`/`revoked` token（工單/照片拒）。
- **Acceptance 對應測試**：
  - pending → start/complete via UI **與** direct API 皆拒（`vendor_start_denied_when_pending`、`vendor_complete_denied_direct_api`）。
  - reject with reason → original repair remains open（`vendor_reject_keeps_ticket_open`）。
  - completion without after-photo → reason mandatory（`completion_requires_reason_when_no_photo`，pure rule ＋ server ＋〔若加欄〕DB `vendor_rejected` CHECK）。
  - completion submitted → company review still required / never auto-close（`completion_never_closes_ticket`）。
  - revoked/expired token → photos/job denied（`expired_token_denied`、`photo_leakage` 不洩漏他方照片）。
- **Idempotency（PROP-11 W3）**：新 route/form 用 **stable server-rendered `requestId`**（UUID hidden field）；**HTTP lost-response retry regression**（pattern 自 B-021 `request-id.test.ts`）＋ SQL replay companion（重放回原結果、payload 變 `rejected_conflict`）。
- **UI**：44px 控制（accept/reject/propose/start/complete 按鈕）、brand-v2 vendor-job/responsive states、copy「待屋主核准」「已回報，待公司核對」經 `copy:check`。
- **分層**：PG17 integration（含新 migration／欄位 replay、`dispatchAllowed` gating、guard trigger）＋ unit（pure rules）＋ gateway importer allowlist（`check-function-privileges`，service_role-only、無 table grant）。
- **Gates**：tsc 0 · lint 0 errors · copy:check PASS · test:unit 綠 · PG17 integration 綠 · check-function-privileges PASS · next build PASS · CI push/PR 綠（check job green）。**不在 hosted/prod 套用。**

## 不做什麼（out of scope，keep）

- **token-derived history access**：vendor 只見本案當前版本，不開放歷史/跨案。
- **auto-closing on vendor submission**：完工只寫事件，永不改 ticket 為 resolved/closed、永不跳過公司核對。
- **B-025 onboarding/docs、B-026 estimates/accounts**。
- **LINE push / 真實通知（B-039／B-028）**；本項不送任何通知。
- **flag ON / seed ON / staging 灌入 / prod / main / rebase / merge main**。
- **重建審批模型或門檻**（消費 B-013／B-021，不重算）；**第二個競爭開關**（不建 `VENDOR_COMPLETION_REASON*` 新 switch）。
- **「done = 啟用」的宣稱**。

## 開放問題

1. **reason 落點**：inspect `3d31326` 的 `b013_repair_appointments`／commands schema 後，reason/response 欄是否真缺？缺則加 nullable `response_reason text`（本項 migration）；不缺則存既有欄/payload、不提 migration。**需在實作前確認，避免多建欄。**
2. **version 解析**：`/v/[token]` 由 job→ticket 解「當前估價版本」的精確來源（head `current_version_id` vs 最新 appointment version）需與 B-021 reader 對齊；approval-lock 必須鎖在 vendor 當下所見的同一版本。
3. **company-confirmed（staff）最小面**：此 path 的進入點（vendor 頁 vs manager 頁）與角色界線——本項採 minimal、flag-gated；若需 staff 專屬入口，是否移至 B-013/manager UI？待與 lane owner 確認。
4. **`vendor_dispatch` 識別名**：registry/code 中的精確 flag key 需先掃描確認（BO 明示 names 不得據以新建開關）。
5. **`VENDOR_COMPLETION_REASON*`**：registry 是否已存在此 proposal 名？若有，僅 reconcile；若無，completion-reason 掛 `vendor_dispatch`、不新立。

## PROP-11 W1–W7（build-side 強制 vs 殘留 runtime ON-gate；不 overclaim）

| W# | PROP-11 條件（摘） | B-024 build-side 現在做到（SQL／TS／測試） | 測試名 | 殘留 runtime ON-gate |
|---|---|---|---|---|
| **W1** same-ticket/org integrity | item/allocation/appointment ticket agreement | 事件走既有複合 FK（org＋ticket＋version、org＋job）＋ B-021 `b013_appointment_job_guard` BEFORE INSERT（job org/ticket 相符，23503）；版本由 server 從 token→job→ticket 推導，不由 client 指定 | `b024.pg: appointment_job_guard`、`cross_ticket_rejected` | **parent-side job 重指派不被 guard**（單欄 FK，僅 record 時檢）＝ 繼承 ON-gate；既有列不回溯複檢 |
| **W2** principal/token pinning | 每個 op scoped 到正確 principal | vendor token→job→org/version 全 server 推導；session.orgId 進 gateway；direct-API start/complete 經 `dispatchAllowed` 二次拒；revoked/expired token 拒 | `b024.pg: pending_denied_direct_api`、`expired_token_denied` | vendor session 的 live/sandbox 綁定依 `b013_actor` env binding＝ON-gate |
| **W3** idempotency | NULL-source 冪等；payment 另立 | 新 route/form 用 stable server-rendered `requestId`；重放回原結果／payload 變 `rejected_conflict`（既有 `(actor,request)` ledger）；HTTP lost-response retry 回歸 | `b024.pg: response_replay_returns_original`、`request-id.test.ts`（HTTP retry） | 無付款 → payment idempotency 不在本項 |
| **W4** integer money / caps | 支援幣別、ceilings、caps、rounding | **不新增金額**；cost 續走 `vendorCostMinor` bigint/minor-unit；completion-reason 為文字無金額 | `b024.unit: costMinorUnchanged` | 業務上限／aggregate caps／per-org 幣別＝產品 ON-gate；本項不設商業限額 |
| **W5** immutability | immutable finalized history、attribution | appointment 事件（含 reason）immutable（B-013 BEFORE UPDATE/DELETE trigger）；`actor_id`／`occurred_at` attribution；reason 僅 INSERT 寫入 | `b024.pg: completion_event_immutable` | audit sink 對 live PII 複檢＝ON-gate |
| **W6** photo refs / party visibility | attachment/storage authz、真實 MIME/hash、party 排除 | 完工照片 id-only 經既有 link-checked route；reader 回 ref（id/count）不取 bytes；不向 owner/accountant 暴露；vendor 只見本案 | `b024.pg: photo_leakage`、`unit: afterPhotoRefShape` | **真實 photo bytes/MIME/hash、storage 授權讀取、安全投影**＝ 繼承 storage ON-gate；本項不取 bytes |
| **W7** RLS/grants/search_path/env | 每個 service-role op scoped authz＋完整 privilege/isolation | 任何新 SQL/欄位 SECURITY DEFINER、pinned `search_path`、service_role-only、org 由 session、env-bound、OFF→`rejected_disabled`；無新表/無 table grant（若加欄則最小欄位 GRANT） | `b024.pg: off_fail_closed`、`no_direct_table_grants`、`env_mismatch_forbidden` | 寫入 gateway 的 `b013_actor` env binding（live vs sandbox）＝ 繼承 ON-gate；OFF `rejected_disabled` ledger 列語義（documented） |

## 繼承 ON-gates（不宣稱關閉；Done ≠ production activation）

承 B-013 QA（`b811f80`，2026-11-05）與 B-021 QA（`3d31326`）：
- **`app.b013_actor` session 環境綁定**（live vs sandbox）於 write gateway——啟用前須驗；B-024 新寫入路徑同受此 gate，**未改、未關閉**。
- **Storage photo 授權＋安全投影**（emergency/evidence/after-photo refs 於 readers）——id-only 已做，真實 bytes/MIME/hash/storage authz 仍為 ON-gate。
- **appointment→vendor job org/ticket invariant**（單欄 FK；僅於 `b013_record_appointment`／guard trigger 強制）——parent-side job 重指派未守，為殘留。
- **Parent FK lock time 於 T0 rehearsal**（rehearsal-blockers.md）——未在本項測量/關閉。
- **PROP-11 W1–W7 residuals**（cross-ticket soft-source、NULL-source 聚合、商業金額上限、audit PII sanitize、accountant cost-photo 排除）——按上表切分，未 overclaim。
- **OFF ledger/replay 語義**（`rejected_disabled` 列）documented，非 bug。

**Flags 維持 OFF；flag flip、staging vendor 資料、live vendor/staff UX、reader 對 live PII/storage 複檢＝ separate decision，不在本 build-only 欄位。**

## 要更新的 manifests／registries

- **BUILD-ORDER**：`todo → in_progress`（起）→ `verifying` → `done（build-only / flags OFF）`＋note；維持 52-item order、0 violations；**app BO mirror 與 hub `pe/b-024-design` byte-identical**（mirror 時 `check_order` PASS）；done 計數 +1。
- **write-pr-migrations**：**僅在**提 `20261105190000_b024_vendor_completion_reason.sql` 時登錄；否則不動。
- **lease-rules / privilege scans**：`check-function-privileges` 清單——若擴充 `b013_record_appointment` 簽章/新欄位 GRANT 則更新計數（參 B-021 15→18 的 pattern）；確認無新 table grant、service_role-only。
- **gateway importer allowlist**：`vendor-job.ts` 所呼 B-013 gateway 列入 importer allowlist（不新增未授權呼叫面）。
- **i18n**：`src/i18n/*` 新 vendor-job copy key（「待屋主核准」「已回報，待公司核對」、accept/reject/propose/start/complete 標籤）；`copy:check` PASS。
- **registry 對照**：`vendor_dispatch`／`repair_approvals`／（若存在）`VENDOR_COMPLETION_REASON*` 識別名先掃 code/registry 確認，reconcile 文件、**不新建開關、不新 seed**。
- **evidence index**：`/workspace/e2e/results/b-024-1105/`（legacy `/workspace/e2e/results/B-024/` 留指向 note）。

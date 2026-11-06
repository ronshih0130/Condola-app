# 設計說明 — B-021（Owner thresholds and versioned repair decisions，L2 owner-decision ＋ read-activation）

> 存成 `20-build/specs/B-021-design.md`。
> 範本：`20-build/specs/B-013-design.md`（同 lane 的 reserve-once 契約保留者，CEO 2026-11-03 核准之 design-note 範式）。用詞以 `/GLOSSARY.md` 為準（org／staff／portal／live／sandbox／vendor token／manager／owner／designated principal）。
> Stack：**B-013 分支 `feat/b-013-vendor-dispatch-closeout` @ `b811f80`（PR #28，draft，on `main` @ `bcd5f41` ＝ `c3f7fab` tree；fast-forward，無 rebase/force）**。此 SHA 已含 B-013 定稿 migration `20261105170000_b013_repair_approval_state.sql`（7 張 `app.b013_*` 表 ＋ 6 支 service-only gateway，staging 已套用、CI PASS）。B-021 **stack 於此之上**（stacked PR，base ＝ PR #28 head，非 main）；**不 rebase、不 merge main（待 CEO GO）**。B-013 schema 在其 QA 期間若變更，B-021 reader migration 依最終 B-013 SHA 重綁。
> 類別：**B（權限／隔離＋金額門檻 risk）**。BO v2 row #12，status `partial`。相依：**B-013（#13 lane 契約保留者；本項消費其 shared schema 與 `b013_decide_estimate`）**；與 B-024（#13）同屬一條 shared repair-state 契約 lane；foundation PROP-11（PASS-with-conditions @ `5f9cc01`）。本項為該 lane 的 **owner 決定端 ＋ 讀取啟用端**：補齊 B-013 設計已保留但未交付的三支讀取 gateway（`b013_owner_pending`／`b013_owner_history`／`b013_manager_view`）、owner 決定的 production caller（server route 呼既有 `b013_decide_estimate`）、以及 flag-gated owner approval cards／minimal manager view，**不另建審批模型、不重複門檻設定**。涵蓋能力：`CAP-O-01`／`CAP-O-02`／`CAP-O-08`、journey J5.4、inventory **O-05**。
> **判定：PROCEED（BUILD-ONLY），將 B-021 由 `partial` 推進至 `done（build-only / flag-OFF）`。** 交付：(1) **一支 forward-only migration** `20261105180000_b021_repair_approval_reads.sql`（ts > `20261105170000`），僅新增三支 service-only SECURITY DEFINER **讀取** gateway（owner pending／owner history／manager view），**不建表、不改表、不加 table grant**，flag OFF 時回空集（fail closed）；(2) **owner 決定 production caller**（server route／action，呼既有 `b013_decide_estimate`，reapproval／stale 語義由既有 gateway 強制）；(3) **`/o/approvals` brand-v2 owner approval cards ＋ minimal manager view**，**僅 flag ON 時 render，flag OFF 輸出逐 byte 等同今日 placeholder**；(4) **純 TS 顯示／衍生規則** 擴充與測試。**不開任何 flag ON、不 seed flag、不改既有 migration、不碰 messaging／真實寄送／自動付款、不繞過 owner 核准、不重建門檻設定。** 未觸及任何 STOP 條件。
> **本設計明確不宣稱「done = 啟用」。** flag flip、staging owner 資料、owner／manager 實際 live UX、reader 對 live 資料的 PII／storage 複檢一律列為 runtime ON-gate（見 §W1–W7、§不做什麼），不 overclaim。

---

## 使用者故事／能力 ID

- **覆蓋**：L2 — `CAP-O-01`／`CAP-O-02`／`CAP-O-08`（owner 檢視待決修繕、對特定版本作出核准／拒絕／要求補充、檢視已核准修繕與緊急例外）、journey **J5.4**（owner 決定分支）、inventory **O-05**。把「指定屋主看到某工單**當前版本**的估價與門檻判定 → 對**該版本**作出單一終局決定（approve／reject／more_information）→ 變更估價後舊核准不沿用 → 緊急例外的原因／照片／通知意圖對屋主可見」這條 **owner 決定與讀取** 路徑，收斂成 **消費 B-013 shared schema 的讀取契約 ＋ 一個 flag-gated 的 owner UI／server caller**，而非另建審批模型或另存門檻。
- **對應 spec／BO**：`B-021-spec.md`（本項；scope＝owner-editable threshold、pending list、approve/reject/request-more-information、changed-estimate reapproval、emergency visibility；out of scope＝no-response approval、broader owner property access）、`B-013-spec.md`（shared schema 提供者）、`B-024-spec.md`（vendor 端，非本項）。BO v2 note：「B-013/B-021/B-024 share one repair-state contract. Reserve their shared files once.」本 note **消費** B-013 的 reserve-once，**不新增第二個審批模型、不建第二個競爭開關**。
- **對應既有程式／資料（build-side 已存在，本項消費／驗證，不重建）**：
  - **門檻設定切片（Acceptance #1 largely satisfied）**：`supabase/migrations/20261031100220_b013_owner_repair_policy.sql`（regional／owner default roots＋revisions、`app.b013_owner_context`、`app.b013_owner_view`、default change/status/close/finish、`app.b013_policy_commands` 作 actor＋request 證據）、`..221_b013_owner_repair_override.sql`（property override change/status/close/finish）；消費於 `src/server/repair-owner-policy.ts`／`repair-owner-override.ts`／`src/app/api/owner-repair-policy/route.ts`／`owner-repair-override/route.ts`／`src/app/o/repair-policy/[id]/`（consent＋current session）。**門檻變更已以 `b013_policy_commands`＋recordAudit 記 actor／value／time，currency 綁 owner／org／property 設定**＝ Acceptance #1 的「actor/value/time audited, currency follows configuration」。**本項不重建此切片**；以 reconciliation 證據（§驗證）確認其滿足 #1，並讓 B-021 的 submit→threshold 快照（B-013 `b013_submit_estimate`）繼續以該 currency／threshold 為來源。
  - **B-013 已交付 schema／寫入 gateway（`b811f80`）**：7 張 `app.b013_*` 表（heads CAS／versions／decisions／emergencies／appointments／commands／event_outbox）；6 支 service-only SECURITY DEFINER gateway：`b013_submit_estimate`、`b013_decide_estimate`（**指定屋主唯一終局、本項的決定寫入點**）、`b013_authorize_emergency`、`b013_record_appointment`、`b013_emit_reminder`、`b013_dispatch_allowed`；session-validated actor（`b013_actor`）、flag resolver（`b013_approvals_enabled`）、idempotent `(actor,request)` ledger、OFF→`rejected_disabled`。
  - **薄 service**：`src/server/repair-approval.ts`（已有 `decideEstimate`／`emitReminder`／`dispatchAllowed` 等 wrapper，**目前無 production caller**）；`src/server/repair-approval-rules.ts`（pure；`assertDecision` 等）。
  - **owner placeholder**：`src/app/o/approvals/page.tsx`（靜態空狀態：`requireCurrentConsent`→`getSession`→`brandV2EnabledForOrg`→`makeT`→render `i_approvals`／`i_no_approvals`）。
  - **讀取 gateway 尚未交付**：B-013 設計 §Gateways 保留了 `b013_owner_pending`／`b013_owner_history`／`b013_manager_view` 的名與語義，但 **`b811f80` 未建**。本項補齊之。
- **刻意不覆蓋**（＝其他 B 項或 runtime ON-gate）：
  - **manager 送估價 / 新版本產生**＝ B-013 `b013_submit_estimate`（本項只讀其結果、不重算門檻）。
  - **vendor 接受／排程／完成／派工守衛**＝ B-024（`b013_record_appointment`／`b013_dispatch_allowed`，本項不呼叫、不建 UI）。
  - **owner-editable threshold 的編輯 UI／流程**＝ 既有設定切片（`/o/repair-policy`），**不在本項重建**；本項只驗證其滿足 #1 並以之為 submit 門檻來源。
  - **真實 Email／LINE／通知中心送達**＝ messaging／B-028；本項讀取 event outbox **意圖狀態**，顯示「intent recorded」、**永不顯示「sent」**。
  - **no-response approval**（靜默自動核准）＝ 明示 out of scope；靜默只產一筆提醒意圖、永不轉 approved（B-013 `b013_emit_reminder` 已強制）。
  - **broader owner property access**＝ out of scope；owner reader 嚴格 scope 到「該 owner 為指定 principal 的版本」，不開放其他物業檢視。
  - **flag flip、staging 資料、reader 對 live PII／storage 的複檢**＝ CEO／Ron 的 separate decision。

---

## Done means（build-only）

一句話：**對 stack `b811f80`，B-021 新增一支 forward-only migration（僅三支讀取 gateway，不建表/不加 table grant）、一個 owner 決定 production caller（呼既有 `b013_decide_estimate`）、flag-gated owner approval cards ＋ minimal manager view 與純顯示規則；在 `repair_approvals` OFF（＝今日）時 `/o/approvals` 輸出與今日 placeholder 逐 byte 相同、三支 reader 回空集、decide route 回 disabled、既有 live 修繕/設定模組逐 byte 不變；在 flag ON 的隔離測試 org 中，指定屋主只能看到自己為指定 principal 的當前待決版本並對該版本作出單一終局決定，stale/superseded/非指定屋主/跨 org/跨 property 一律拒絕或不可見，manager 可見該版本帶時間戳的決定與緊急例外（原因/照片 refs/intent 狀態＝「intent recorded」），且 PROP-11 W1–W7 當中可由 reader build-side 強制的部分已強制並測到，其餘明列為 flag/storage ON-gate。**

- **Staging（stack SHA）**：在 B-013 PR #28 head `b811f80` 之上 build、綠燈；B-021 reader migration 在 disposable 本機 PG17 clone（已套 B-013 migration）套用成功（完整 BEGIN→COMMIT 原子、函式 REVOKE/GRANT 正確、rollback 驗證）；QA packet 附證據至 `/workspace/e2e/results/B-021/`。**不在 hosted／prod 套用**；hosted apply 由 PE 依 handoff 流程另行執行。
- **flags OFF ＝今日**：`repair_approvals`（＝ `REPAIR_APPROVALS*` proposal 名，reconcile 既有 `repair_approvals` 全域控制：platform enabled ∧ allowlist ∧ org feature flag）維持 OFF；不新增 flag、不 seed ON。**本項不涉 `vendor_dispatch`**（owner 決定端不派工）。flag OFF 時本項**不新增任何使用者可見行為**。
- **可觀察**：
  - **flag OFF**：`/o/approvals` render 與今日 placeholder **逐 byte 相同**（相同 `requireCurrentConsent`／`getSession`／`brandV2EnabledForOrg`／`makeT` 呼叫序、相同 `data-v2-page` 判定、相同 `i_approvals`／`i_no_approvals` 輸出，頁面在 flag OFF 時 **short-circuit、不呼任何 reader**）；三支 reader 若被直接呼叫回空集、零列；owner-repair-decision route 回 `rejected_disabled`（經 `b013_decide_estimate` fail-closed），不改任何狀態；既有 `repairs.ts`／`vendor-repair.ts`／`domain.ts`／設定切片逐 byte 不變。
  - **flag ON（隔離 org）**：指定屋主於 `/o/approvals` 看到 **恰其當前待決版本**（`designated_principal_id = actor` ∧ `requires_owner_decision` ∧ 無決定 ∧ ＝ head 當前版本）；approve/reject/more_information 落在**特定版本**並寫不可變 decision（`decided_at` 時間戳）；= 或 < 門檻版本**不出現在待決清單**（policy_qualified，非偽造同意）；superseded（非 head）版本**不出現、且對其決定被拒**（`rejected_conflict`／`40001`）；非指定屋主決定被拒（`42501`）；manager view 回該版本帶 `decided_at` 的決定、緊急例外（category/reason/photo refs）與 intent 狀態（`approval_reminder_24h`／`emergency_owner_notice`，標「intent recorded」）；跨 org／跨 property／他 owner 的版本不可見。
  - 不新增任何表；三支 reader 對 PUBLIC/anon/authenticated/service_role **無表權**，僅 reader 函式本身 `GRANT EXECUTE` 給 service_role；查 DB 無任何真實送達列、無自動 posted expense、flag OFF 時無任何新寫入。

> 本 B 項 BUILD-ORDER 單一狀態欄位維持一項：`partial → done（build-only / flag-OFF）`。啟用（flag ON、staging owner 資料、live owner/manager UX、reader 對 live 的 PII/storage 複檢）是 separate decision，不在本欄位。**B-021 build-only 完成不要求 B-013 flag-ON 啟用**，只要求 B-013 schema 存在（已於 `b811f80`／staging）；B-021 之 merge／啟用與 B-013 共用 no-merge/no-flag-flip gate。

---

## 端到端 tracer bullet

最小可行、**只走 owner 決定與讀取面**的一條路徑（於 flag ON 隔離 org 以整合測試＋UI 測試驅動；flag OFF 時此路徑不存在、既有行為零位移）：

1. **submit（manager / B-013，前置）**：manager 對工單 `T` 送超門檻估價 → `b013_submit_estimate` 寫 immutable version `V1`（`requires_owner_decision=true`、`captured_threshold_minor`/`threshold_source` 快照自設定切片、currency＝property currency），head 指向 `V1`。**本項不實作此步，只消費其結果。**
2. **owner pending（owner / B-021）**：指定屋主登入 `/o/approvals`（flag ON）。頁面解析 `repair_approvals` ＝ ON → 呼 `repair-approval.ts#ownerPending(session)` → `app.b013_owner_pending(org, session)`：以 session 推導 org、`b013_actor` 驗 session＋owner 身分、回 `designated_principal_id = actor` ∧ 需決定 ∧ 無決定 ∧ ＝ head 的版本列（`V1`：amount/currency/scale/work_scope/evidence refs/captured_threshold/version_no/submitted_at/是否有緊急/提醒意圖時間）。brand-v2 approval card render。
3. **decide（owner / B-021）**：屋主在 card 按「核准」（或拒絕／要求補充，後二者需理由）→ POST `src/app/api/owner-repair-decision/route.ts`（consent＋session 驗）→ server 鑄 `request_id` → `repair-approval.ts#decideEstimate(session,{requestId,versionId:V1,decision:'approved'})` → `app.b013_decide_estimate`：`b013_lock_version` 鎖 ticket＋確認 `V1` ＝ head 當前（否則 `40001` stale）、`actor = designated_principal_id`（否則 `42501`）、重查 owner 有效性＋currency 未漂移、`UNIQUE(org,version)` 保一版一終局 → 寫 immutable decision（`decided_at`）→ 命令 ledger 記 `(actor,request)` 結果。重放同 `request_id` 回原結果；payload 改變 `rejected_conflict`。
4. **reapproval（owner / B-021）**：若 manager 其後改金額/範圍/證據/指定屋主 → `b013_submit_estimate` 產 **新版本 `V2`**、head 指向 `V2`。此時屋主的 pending 清單**只顯示 `V2`**；對 `V1` 再決定被 `b013_lock_version` 以「not current」拒（`40001`）＝ **舊核准不沿用**（Acceptance #3）。
5. **manager view（manager / B-021）**：manager 於既有修繕/工單詳情（flag-gated 區塊）呼 `app.b013_manager_view(org, session, T)` → 回 `V1/V2` 的版本/決定（帶 `decided_at`）/緊急/約訪狀態/intent 狀態時間軸 ＝ **「manager sees the timestamped decision for that version」**（Acceptance #2）。
6. **emergency visibility（owner＋manager / B-021）**：若 Admin 先 `b013_authorize_emergency`（B-013）→ 本項 reader 於 owner card／manager view 顯示緊急例外之 `category`/`reason`/`photo refs` 與 `emergency_owner_notice` **intent 狀態＝「intent recorded」、決不顯示「sent」**（Acceptance #4）。緊急不移除屋主 pending（屋主仍可為記錄作決定）、不偽造屋主決定。
7. **可觀察結果**：決定為不可變、org/ticket/version 綁定、actor＋request 冪等之證據；owner 只見己為指定 principal 的版本、manager 只見本 org 工單、跨 org/property/他 owner 一律空集或拒絕；**查 DB：無真實送達列、無自動 posted expense、flag OFF 時無任何新寫入、`/o/approvals` OFF 輸出 byte-identical。**

---

## 資料表與 RLS / read gateways（簽章）

**不新增任何表、不改任何既有表、不加任何 table grant。** 複用 B-013 於 `20261105170000` 已交付的 7 張 `app.b013_*` 表與其 RLS／REVOKE（含 service_role）／immutable trigger。

**一支新 migration** `supabase/migrations/20261105180000_b021_repair_approval_reads.sql`（ts > `20261105170000`；additive、forward-only、完整 `BEGIN…COMMIT` 原子、`SET LOCAL lock_timeout/statement_timeout`；**僅 `CREATE FUNCTION` ×3 ＋ REVOKE/GRANT；無 CREATE TABLE／無 ALTER TABLE／無 DROP／無 down 腳本／無 flag seed／無 enum**）。三支皆 `SECURITY DEFINER`、`SET search_path=pg_catalog,public,app,pg_temp`、**org 由參數＋session 推導並以 `app.b013_actor(p_org,p_session)` 驗證**（session 有效、org 成員或指定 owner；沿用 B-013 helper，不接受 client role）；進入即以 `app.b013_approvals_enabled(p_org)` 檢 flag → **OFF ⇒ `RETURN`（空集，fail closed）**；`REVOKE ALL ... FROM PUBLIC, anon, authenticated, service_role` 後僅 `GRANT EXECUTE ... TO service_role`。命名採 `b013_` 前綴以**兌現 B-013 設計保留之 shared 契約名**（非第二模型），由 B-021 migration 交付。

```text
-- 讀取 gateway（B-021 交付；兌現 B-013 §Gateways 保留名；service-only；flag OFF → 空集）

app.b013_owner_pending(p_org uuid, p_session uuid)
  RETURNS TABLE(ticket_id uuid, property_id uuid, version_id uuid, version_no bigint,
    currency char(3), minor_unit smallint, amount_minor bigint,
    captured_threshold_minor bigint, threshold_source text,
    work_scope text, evidence_snapshot jsonb, submitted_at timestamptz,
    has_emergency boolean, reminder_intent_at timestamptz)
  -- owner only。actor 經 b013_actor 解析；回「designated_principal_id = actor
  --   ∧ requires_owner_decision ∧ 無 decision ∧ version = 該 ticket head 當前版本」之列。
  --   session org scope；= / < 門檻（policy_qualified）、superseded、他 owner、跨 org 一律不回。
  --   非 owner（純 staff）actor 無符合列 → 自然回空集。flag OFF → 空集。

app.b013_owner_history(p_org uuid, p_session uuid, p_ticket uuid)
  RETURNS TABLE(version_id uuid, version_no bigint, amount_minor bigint, currency char(3),
    minor_unit smallint, captured_threshold_minor bigint, requires_owner_decision boolean,
    submitted_at timestamptz, decision text, decided_at timestamptz, decision_reason text,
    emergency_category text, emergency_reason text, emergency_photo_refs jsonb,
    emergency_notice_intent_at timestamptz, is_current boolean)
  -- owner only。僅回該 ticket 中「designated_principal_id = actor」之版本歷史（含決定/緊急/intent 狀態）。
  --   移轉後：前屋主見其曾為指定 principal 的版本、新屋主見其版本（保守界線，見開放問題 1）。
  --   跨 org / 錯 ticket / 他 owner → 空集。flag OFF → 空集。

app.b013_manager_view(p_org uuid, p_session uuid, p_ticket uuid)
  RETURNS TABLE(version_id uuid, version_no bigint, amount_minor bigint, currency char(3),
    minor_unit smallint, captured_threshold_minor bigint, threshold_source text,
    requires_owner_decision boolean, submitted_at timestamptz, submitted_by uuid,
    decision text, decided_at timestamptz, decided_by uuid, decision_reason text,
    emergency_category text, emergency_reason text, emergency_photo_refs jsonb,
    appointment_event_kind text, appointment_occurred_at timestamptz,
    reminder_intent_at timestamptz, emergency_notice_intent_at timestamptz, is_current boolean)
  -- staff only（b013_actor 回 member_role ∈ {admin,manager}；否則 42501 或空集）。
  --   回該 org＋ticket 的版本/決定（帶 decided_at）/緊急/約訪/intent 狀態時間軸。
  --   跨 org → 空集。flag OFF → 空集。intent 欄只表「意圖已記」，非送達。
```

- **寫入沿用既有 gateway，不新增寫入 gateway**：owner 決定＝既有 `app.b013_decide_estimate(p_org,p_session,p_request,p_version,p_decision,p_reason,p_payload_sha256)`（已 GRANT EXECUTE 給 service_role）。reapproval／stale／非指定屋主／currency drift／一版一終局／冪等均由該 gateway 既有邏輯強制（`b013_lock_version` 40001、`42501`、`UNIQUE(org,version)`、命令 ledger）。**本項不改 `b013_decide_estimate`。**
- **純解析／顯示判定不進 SQL**：pending 分類、decision label、intent 狀態文案（「intent recorded」vs「—」）、reapproval 提示等**顯示衍生**集中在 `repair-approval-rules.ts`（pure）；reader gateway 只做 scoped 原子讀取。
- **RLS／授權**：三支 reader `REVOKE ALL` 自 `PUBLIC,anon,authenticated,service_role` 後僅 `GRANT EXECUTE` 給 service_role；表維持零直接 service_role 表權（延續 B-013 開放問題 1 採行之較嚴模型）；helper（`b013_actor`／`b013_approvals_enabled`）維持 private，reader 以 DEFINER 身分呼叫。

---

## UI

- **`src/app/o/approvals/page.tsx`（EDIT；flag OFF byte-identical）**：維持既有 `requireCurrentConsent(undefined,"page")`→`getSession()`→`brandV2EnabledForOrg(session.orgId)`→`makeT(session.locale)` 序與 `data-v2-page` 判定。新增 **flag 分岔**：解析 `repair_approvals`（server-side resolver，與 gateway 同語義）：
  - **OFF**：`return` 與今日**完全相同**的 JSX（`<h2>{t("i_approvals")}</h2><p>{t("i_no_approvals")}</p>`），**不呼任何 reader**、不引入任何新節點／屬性 → 逐 byte 等同今日 placeholder（以 §驗證 的 OFF golden 測試鎖定）。
  - **ON**：呼 `ownerPending(session)`；無待決列 → 仍顯示空狀態（可沿用 `i_no_approvals`）；有列 → render brand-v2 approval cards。
- **`src/app/o/approvals/approval-cards.tsx`（新）**：brand-v2 owner approval card（`CAP-O-01/02/08`）：顯示 version_no、amount（依 currency/minor_unit 格式化）、work_scope、evidence refs（**僅 ref id／count，不取 bytes**）、captured_threshold 與 threshold_source、submitted_at；決定表單（核准／拒絕／要求補充；後二者需理由）post 至 owner-repair-decision route。緊急例外區塊：category/reason/photo refs ＋ 通知狀態標籤 **「intent recorded」（決不「sent」）**。reapproval：清單只含當前版本，superseded 不出現（UI 無「重用舊核准」入口）。
- **`src/app/o/approvals/[ticketId]/page.tsx`（新；flag-gated）**：owner history 檢視（呼 `ownerHistory`），顯示該 ticket 中屋主曾為指定 principal 的版本/決定/緊急時間軸；flag OFF 時此路由回與 placeholder 一致之空狀態（或 404-safe，不洩結構）。
- **manager minimal view（新；flag-gated 區塊）**：於既有 manager 修繕/工單詳情面（**路徑 待核——confirm against code，不發明**）插入一個 **僅 flag ON 時 render** 的最小區塊，呼 `managerApprovalView(session,{ticketId})` 顯示該版本帶 `decided_at` 的決定（Acceptance #2）＋緊急/intent 狀態。flag OFF 時該區塊不 render，既有詳情頁輸出不變。
- **`src/app/api/owner-repair-decision/route.ts`（新；production caller）**：POST；`requireCurrentConsent`＋`getSession`（比照 `owner-repair-policy/route.ts` idiom）；server 鑄 `request_id`；呼 `decideEstimate`；回傳 gateway 結果（`recorded`／`rejected_conflict`／`rejected_disabled`／`rejected_invalid`）。flag OFF 時 gateway 回 `rejected_disabled`、零狀態變更；OFF UI 不渲染決定入口，故一般使用者不可達。
- **i18n**：新增 approval card／decision／emergency／intent-status copy keys（approve/reject/request-information、threshold、amount、emergency reason、「intent recorded」等），**文案取自已核准 brand-v2 copy deck（CAP-O-01/02/08）；最終字串 待核，不自創法律/通知用語**。

---

## Flag

- **不新增 flag、reuse registry。** 單一控制 ＝ `REPAIR_APPROVALS*`（proposal 名，`*` 標記）**reconcile 既有 `repair_approvals` 全域控制**（platform enabled ∧ allowlist ∧ org feature flag，缺一即 OFF），default OFF ＝今日。**沿用，不建第二個競爭開關**（BO 明示）。
- **本項不涉 `vendor_dispatch`**：owner 決定端不派工、不呼 `b013_record_appointment`／`b013_dispatch_allowed`；`vendor_dispatch` 維持 OFF 且**不被本項讀寫**（屬 B-024）。
- **flag 落點**：(1) `/o/approvals` page 與 manager 區塊以 server-side resolver 決定是否 render 新 UI；(2) 三支 reader gateway 進入即 `b013_approvals_enabled` → OFF 回空集；(3) `b013_decide_estimate`（既有）OFF → `rejected_disabled`。**flag 不進純規則模組**（規則保持純函式）。多處一致 fail-closed（defense-in-depth），但 OFF byte-identical 的首要保證是 page short-circuit。
- flag OFF ＝今日：`/o/approvals` 輸出不變、三支 reader 回空、decide route 回 disabled、既有設定切片與 live 修繕模組逐 byte 不變。未來 ON（owner 可見審批）屬本項之使用者可見變更，須走既有 Mode B 判定式、於隔離 local/staging test org 測，default OFF——**啟用不在本 note**。

---

## 錢／權限風險（Class B 判定）

**判定：Class B（跨 org／跨 ticket／跨版本／跨 owner／跨 property 隔離 ＋ 金額門檻 ＋ 偽造核准／誤授權／誤讀外洩 risk）。** 本項是「誰可看到待決、誰可對哪一版作出終局決定、屋主能讀到哪些版本/緊急/通知」的決定與讀取點；錯一步＝跨 org/他 owner 外洩、**對 superseded 版本沿用舊核准**、**非指定屋主冒充決定**、**把『意圖』誤呈為『已送達』**、或 flag OFF 誤洩 UI。**不得改變任何既有授權／金流邊界、不得重建門檻。** 合併前須有獨立審查逐條走完（PRINCIPLES 37 Class B 強制獨立審閱）：

1. **決定寫入複用既有 gateway、不旁路**：owner 決定只經 `b013_decide_estimate`；審查確認本項未新增任何繞過 `b013_lock_version`（stale/head-current 檢）、`actor = designated_principal_id`（42501）、`UNIQUE(org,version)`（一版一終局）、currency drift（40001）、命令冪等的決定路徑。
2. **reapproval／stale 不沿用**（Acceptance #3）：變更估價→新版本→舊版非 head→對舊版決定 `40001`；owner pending／UI 只含當前版本。審查以「V1 pending→decide V1 approved→manager submit V2→decide V1 再次」驗被拒、V1 approved 不授權 V2。
3. **owner reader 嚴格 scope（最高外洩風險之一）**：`b013_owner_pending`／`owner_history` 僅回 `designated_principal_id = actor` 且 session org 內之列；審查確認他 owner、他 property、跨 org、純 staff actor 一律空集，無任何集合式回傳讓某 owner 列舉非己版本（對應 W1/W2/W6 build-side）。
4. **manager reader staff-only、org-scoped**：`b013_manager_view` 僅 admin/manager、僅本 org＋指定 ticket；審查確認跨 org 空集、非 staff 42501/空集、不洩他 org 工單。
5. **門檻 strict `>` 與 provenance 不被本項改動**：pending／policy_qualified 以版本既存 `requires_owner_decision`（generated STORED，strict `>`）呈現；審查確認 reader 不重算門檻、不以當下設定覆寫已快照門檻（Ron 決定：門檻變更只影響新版本）。**本項不重建門檻設定**（Acceptance #1 由既有切片滿足）。
6. **緊急不偽造核准、通知只記意圖**（Acceptance #4）：reader 顯示 emergency 之 category/reason/photo refs ＋ `emergency_owner_notice` **intent 狀態＝「intent recorded」**；審查確認 UI/reader **決不**出現「sent／delivered」、不把緊急呈為屋主已同意、不以緊急移除屋主 pending 的決定權。
7. **靜默永不核准、no-response out of scope**：reader 顯示 `approval_reminder_24h` intent 之存在/時間，**不據此標記為已核准**；審查確認無任何「逾時自動核准」路徑（B-021 spec 明示 out of scope）。
8. **flag OFF fail-closed ＋ UI byte-identical**：OFF → page short-circuit（不呼 reader）、reader 空集、decide route `rejected_disabled`；審查以 OFF golden 確認 `/o/approvals` 逐 byte 等同今日、既有 live/設定模組零位移（對應 W7、§Done）。
9. **冪等與競態**：decide 複用 `(actor,request)` ledger（重放回原結果、payload 變 `rejected_conflict`）；reader 為唯讀，不引入寫入競態；審查確認 route 每次鑄新 request_id 且重試安全。
10. **照片/證據為 ref 快照、非 bytes 證明**：reader 回 evidence/photo **ref（id/count）**，不取 storage bytes、不驗 MIME/hash；審查確認 UI 不宣稱真實照片已驗證、不對 accountant 暴露（本項無 accountant reader），真實 bytes/storage/party-visibility 複檢列為 reader ON-gate（W6）。

**金額／付款對象／租約效力**：owner 決定牽動是否授權修繕支出（L1-RPR／PROP-11 下游），故列 Class B；本項**不改既有 vendor 可見/可寫邊界、不過帳、不改 posted expense、維持 `REPAIR_EXPENSE_STATUS='draft'`**，不動 cost-bearer 分攤。

---

## PROP-11 inherited W1–W7 matrix（B-021）

對 PROP-11 verdict（`5f9cc01`）W1–W7，逐條切分 **B-021 於 reader/decide 啟用這一步能在 build-side 強制者** vs **殘留 runtime ON-gate**。B-021 是 owner 決定端與**讀取啟用**端，故 W6 的 party-visibility 首次有一部分落到 build-side；但本項仍 **BUILD-ONLY（flag OFF）**，不宣稱 reader 對 live 的 PII/storage 已滿足。**不 overclaim**。

| W# | PROP-11 條件（摘） | B-021 build-side 現在做到（SQL／測試） | 測試名 | 殘留 runtime ON-gate |
|---|---|---|---|---|
| **W1** | item/allocation/document/job **ticket agreement**；same-org wrong-ticket | 三支 reader 以 `(org_id,ticket_id)` ＋ session org 篩選；`owner_history`／`manager_view` 收 `p_ticket`，只回該 org＋ticket 列；join `b013_*` 複合 FK；owner reader 另綁 `designated_principal_id = actor` | `b021.pg: owner_history_same_ticket_org`、`manager_view_cross_org_empty` | 與 PROP-11 `repair_cost_items/allocations` 的 join-time agreement **僅在 B-008/B-018 cost reader join 成本列時成立**；**B-021 不讀成本列** |
| **W2** | 以 scoped org 解析 statement-line；due-component soft source | reader 以 session org 解析 actor／owner／ticket；`designated_principal_id`／`property_id` 皆取版本快照、不跨 org 外解 | `b021.pg: owner_pending_scoped_to_designated_principal`、`property_isolation` | `owner_statement_line_id`／due-component soft-source 解析屬 **B-018／B-008 statement reader**，非 B-021 |
| **W3** | NULL-source 冪等＋聚合；payment 冪等另立 | decide 複用 `(actor,request)` ledger（重放/`rejected_conflict`）；reader 唯讀無冪等問題；reminder dedupe 由 B-013 `UNIQUE(org,version,kind)` 已保 | `b021.pg: decide_replay_returns_original`、`decide_payload_change_conflict` | **B-021 無付款** → payment idempotency 不在本項；outbox 真實送達/聚合在 B-028 |
| **W4** | 支援幣別、ceilings、caps、split rounding | reader 原樣呈現版本快照之 currency/minor_unit/amount/threshold；decide 經 `b013_decide_estimate` 重查 currency 未漂移（40001）；pending/policy_qualified 用 generated **strict `>`** | `b021.pg: threshold_equality_above`、`currency_drift_rejected`、unit `pendingClassify` | 業務金額上限／aggregate caps／per-org 幣別設定＝產品 ON-gate；B-021 只讀與比較、不設商業限額、不重建門檻 |
| **W5** | audited transitions、immutable finalized history、attribution、sanitize money/PII | 決定寫不可變 decision（B-013 trigger）＋ `decided_at`／`decided_by` attribution；manager view 回帶時間戳決定；reader 輸出經 sanitize（金額格式化、不回內部 hash/PII 欄） | `b021.pg: decision_visible_to_manager`、unit `managerViewShape` | 正式 audit sink 對 live 的 PII 複檢＝ON-gate；B-021 交付讀取 shape 與決定 attribution |
| **W6** | attachment/storage authz、真實 MIME/hash/photo class、party visibility、accountant 排除 | **party-visibility 首次 build-side**：owner reader 僅見己為指定 principal 之版本/緊急/photo **refs**；manager reader 僅 staff＋本 org；**accountant 無 reader → 不經 B-021 暴露**；photo 以 ref 形狀呈現（reuse `b013_photo_refs` 形狀語義） | `b021.pg: owner_cannot_see_other_owner`、`manager_staff_only`、unit `emergencyPhotoRefShape` | **真實 photo bytes/MIME/hash、storage 授權讀取、accountant cost-photo 排除（PROP-11 `repair_cost_visibility`，屬 B-008/B-018 cost reader）** 仍為 reader/storage ON-gate；B-021 不取 bytes |
| **W7** | 每個 service-role op scoped authz＋完整 DB privilege/isolation/regression | 三支 reader SECURITY DEFINER＋`b013_actor` session 驗＋org 由參數/session；`REVOKE ALL` 含 service_role、僅 reader EXECUTE；無新表/無 table grant；OFF→空集 | `b021.pg: reader_off_fail_closed`、`no_direct_table_grants`（9 gateway/7 table）、`reader_role_definer_only` | **完整 staging regression＋flag flip＋對 live 的 isolation 複驗**＝ON-gate；本項於 disposable clone 驗，不在 hosted apply |

---

## HITL／AFK

- **AFK（agent 可自行完成）**：reader migration DDL（3 函式＋REVOKE/GRANT）撰寫；在已套 B-013 的 disposable PG17 clone 的套用/rollback 驗證；純 TS 顯示/衍生規則與 table-driven 單測；reader service wrapper 與 owner-repair-decision route；`/o/approvals` flag 分岔與 OFF byte-identical golden 測試；brand-v2 card／history／manager minimal 區塊（flag-gated）；schema 靜態 SQL 測試；PG17 整合測試（owner scope、property isolation、threshold equality/above、stale decision、非指定屋主、OFF fail-closed、cross-org、manager 可見決定、emergency visibility）；privilege 掃描 6→9 擴充。
- **HITL（人工定稿／簽核）**：
  - **owner_history 移轉後存取界線**（B-013 開放問題 4／completion-audit「define historical access after transfer; do not invent missing policy」）：本文件採**保守界線**（屋主只見其曾為指定 principal 的版本），需產品確認（§開放問題 1）。
  - **manager minimal view 的宿主路徑／copy**：確認既有 manager 修繕/工單詳情確切路徑與 brand-v2 copy key，不發明（§開放問題 2）。
  - **Class B 獨立審查強制**（PRINCIPLES 37）：合併前獨立審閱逐條走完 §錢／權限風險 1–10（尤重 3 owner reader scope、6 緊急零偽造核准＋intent-not-sent、2 reapproval 不沿用、8 flag-OFF byte-identical），確認既有設定切片與 live 模組零位移。
  - **hosted／staging apply**：Codex 不碰 hosted DB；PE 依 B-013 handoff 流程核對 catalog/roles/grants（含 9 gateway/7 table 不變）、備份還原、counts/grants snapshot、target guard 後套用，提供 exact migration SHA／結果／QA，Ron 通知後方續接。
  - **flag flip／staging owner 資料／live owner-manager UX／reader W6 storage 複檢**：separate decision（CEO/Ron），不在本項。

---

## 驗證

不寫「跑測試」，寫真實介面／真實輸入／可觀察狀態。證據落 `/workspace/e2e/results/B-021/`。

- **Acceptance #1 reconciliation（既有切片，不重建）**：以既有 fixtures 驅 `/o/repair-policy/[id]` 與 `owner-repair-policy/override` route，觀察 owner default／property override 變更後 `b013_policy_commands`＋recordAudit 記 **actor／value／time**，且 threshold 之 currency 綁 owner/org/property config；證據快照至 `results/B-021/acceptance1-threshold-audit.json`。**無新程式碼；僅確認 #1 satisfied 並作為 submit 門檻來源。**
- **單元（純顯示/衍生；table-driven）** `repair-approval-rules.test.ts`（擴充）：
  - `pendingClassify`：version `requires_owner_decision=true`∧無決定∧current → pending；= / < 門檻 → 不列入 pending（policy_qualified，不偽造同意）。
  - `decisionLabel`／`decisionTransitions`（既有）：approve/reject/more_information；reject/more_info 需理由。
  - `intentStatusLabel`：有 `approval_reminder_24h`/`emergency_owner_notice` intent → 「intent recorded」；無 → 「—」；**永不輸出「sent」**。
  - `reapprovalHint`：superseded（非 current）→ 標示需新版本、舊核准不沿用。
  - `emergencyPhotoRefShape`：photo/evidence ref 形狀（1..8／≤8、id 字串）邊界。
- **schema 靜態 SQL 測試** `repair-approval-reads.schema.test.ts`：檢 `20261105180000` 文字含三支 reader、每支 `SECURITY DEFINER`＋`SET search_path`＋`b013_actor`＋`b013_approvals_enabled`、`REVOKE ALL`（含 service_role）後僅 `GRANT EXECUTE` 給 service_role、**無 CREATE TABLE／無 ALTER TABLE／無 table GRANT／無 DROP**、ts > `20261105170000`。
- **gateway/caller 靜態** `repair-approval.gateway.test.ts`（更新 B-013 的 no-caller 斷言）：斷言唯一 production caller ＝ flag-gated owner-repair-decision route ＋ `/o/approvals`/manager 區塊 reader 呼叫；斷言 **flag OFF 時 `/o/approvals` 不呼 reader**（page short-circuit）、decide route 經 gateway fail-closed。
- **UI OFF byte-identical 靜態** `src/app/o/approvals/approvals-off.test.ts`：凍結今日 placeholder 輸出為 golden；斷言 `repair_approvals` OFF 時 `ApprovalsPage` render 與 golden **逐 byte 相同**（含 `data-v2-page` 兩態），且無 reader 被呼叫（mock 斷言 0 calls）。
- **PG17 整合** `e2e/pg/b021-repair-approval-reads.pg.test.ts`（disposable clone，先套 B-013 migration）：
  - `owner_pending_scoped_to_designated_principal`：owner A 只見己當前待決版本；owner B 之不可見；= / < 門檻版本不列入；superseded 不列入。
  - `property_isolation`：owner 只見己 property 之版本；他 property 空集。
  - `owner_history_same_ticket_org`：history 綁 org＋ticket＋指定 principal；錯 ticket／跨 org／他 owner 空集。
  - `owner_cannot_see_other_owner`／`manager_staff_only`：party-visibility；純 staff 呼 owner_pending 空集；非 staff 呼 manager_view 42501/空集。
  - `manager_view_cross_org_empty`：manager 只見本 org 工單。
  - `threshold_equality_above`：amount=threshold → 不需決定、不在 pending；amount=threshold+1 → 需決定、在 pending（經 decide 驗 strict `>`）。
  - `stale_decision_rejected`：對 superseded 版本決定 → `40001`/`rejected_conflict`；superseded 不在 pending。
  - `non_designated_owner_rejected`：非指定屋主決定 → `42501`。
  - `decision_visible_to_manager`：owner approve 當前版本後，`manager_view` 回該版本帶 `decided_at` 的決定。
  - `emergency_visibility`：Admin 緊急後，owner/manager reader 回 category/reason/photo refs ＋ `emergency_owner_notice` intent（occurred_at 存在），且無任何 delivery 欄位（intent-only）。
  - `reader_off_fail_closed`：`repair_approvals` OFF → 三支 reader 回空集、零列；decide route `rejected_disabled`。
  - `decide_replay_returns_original`／`decide_payload_change_conflict`：冪等與 payload 衝突。
- **回歸閘（flag OFF byte-identical）**：`/o/approvals` OFF golden 綠；`repairs.ts`／`vendor-repair.ts`／`domain.ts`／設定切片 characterization 逐欄位相同；B-013 既有 unit/RLS/PG gate 綠（不回退 B-013／PROP-11 任何結果）；privilege 掃描 9 gateway/7 table 綠。
- **feature map**：使用者＝指定屋主於 `/o/approvals` 看待決並決定、manager 於詳情看決定（flag ON 隔離 org）；agent 驅動＝以 fixture 呼 reader／decide；可觀察＝owner 只見己版本、manager 見帶時間戳決定、emergency intent「recorded」非「sent」、flag OFF 時 UI byte-identical ＋ 零新寫入。

---

## 不做什麼

- **不開任何 flag ON、不 seed flag**；`repair_approvals` 維持 OFF ＝今日；**不涉 `vendor_dispatch`**（屬 B-024）。
- **不建任何表、不改任何既有表、不加任何 table grant**；只新增一支 forward-only `20261105180000_b021_repair_approval_reads.sql`（三支讀取 gateway）。
- **不改既有 migration**（`20261105170000` B-013、`20261031100220`/`221` 設定切片、PROP-11）、**不重跑**任何既有 CREATE。
- **不重建門檻設定／owner-editable threshold UI**＝ 既有 `/o/repair-policy` 切片已滿足 Acceptance #1；本項只驗證並以之為 submit 門檻來源。
- **不新增/不改任何寫入 gateway**；owner 決定複用既有 `b013_decide_estimate`，不旁路其 stale/head-current/指定屋主/一版一終局/currency/冪等檢查。
- **不改 `repairs.ts`／`vendor-repair.ts`／`domain.ts`／`repair-rules.ts` 的行為**；不改 B-013 寫入 gateway；`repair-approval.ts` 僅**新增** reader wrapper 與 production caller，flag-OFF 路徑不變。
- **不在 hosted／prod 套用 migration、不 merge main**（待 CEO GO）；hosted apply 由 PE 另行執行。
- **不實作真實 Email／LINE／通知中心送達**＝ messaging／B-028；reader 顯示 event outbox **意圖狀態「intent recorded」、決不「sent／delivered」**。
- **不做 no-response／靜默自動核准**（spec out of scope）；提醒意圖永不轉 approved。
- **不開放 broader owner property access**（spec out of scope）；owner reader 嚴格 scope 到指定 principal 之版本。
- **不做自動付款、不過帳、不改既有 posted expense**；維持 `REPAIR_EXPENSE_STATUS='draft'`；收據/照片為 ref 證據非付款。
- **不取 photo bytes、不驗 MIME/hash、不做 storage 授權讀取、不暴露給 accountant**（本項無 accountant reader）；真實 bytes/storage/accountant 排除屬 cost reader ON-gate（B-008/B-018 消費 PROP-11 `repair_cost_visibility`）。
- **不做 vendor 接受／排程／完成 UI／派工守衛**＝ B-024；本項不呼 `b013_record_appointment`／`b013_dispatch_allowed`。
- **不新增 flag／RLS 以外變更、不建第二個競爭 approvals 開關、不發明不存在的表/flag/函式/路徑名**；manager 區塊宿主路徑與最終 copy 標 **待核**。
- **不宣稱 reader 層 W6 真實 photo/storage/accountant 已滿足；不宣稱 done = 啟用。**
- **不碰 `auth.ts`／`perms.ts`／session 身分面**（PROP-01a/01b 範圍）、**不動 PROP-MF／BO 排序、不碰 messaging**。

---

## 開放問題（可非同步填答）

1. **owner_history 移轉後存取界線**：本文件採「屋主只見其**曾為指定 principal**之版本」（前/新屋主各見己版本，無跨 owner 洩漏）。此為 B-013 開放問題 4／completion-audit「define historical access after transfer」的保守預設，是否即為產品政策？（Ron／B-021 owner）
2. **manager minimal view 宿主與 copy**：既有 manager 修繕/工單詳情的確切路徑（`src/app/m/...` 待核）與 brand-v2 decision-status copy key？（Ron／PE，confirm against code）
3. **讀取 gateway 命名**：三支 reader 採 `app.b013_owner_pending`／`b013_owner_history`／`b013_manager_view`（兌現 B-013 保留名，由 B-021 migration 交付）是否定案，或改 `b021_` 前綴？建議維持 `b013_`（同一 shared 契約、privilege 掃描集中）。（Ron／CEO）
4. **decide production caller 形態**：採 API route `src/app/api/owner-repair-decision/route.ts`（比照既有 owner-repair-* route）或 server action？建議 route 以符既有 idiom。（PE）
5. **owner reader 的 policy_qualified 版本可見性**：= / < 門檻版本不需屋主決定，是否仍於 owner history 顯示（供屋主知悉）或全然隱藏？本文件：pending 不含、history 含（唯讀、標 policy_qualified）。（產品確認）
6. **manager_view 的 appointment 欄**：B-021 不建 vendor UI，但 manager_view 回 appointment 狀態欄位（唯讀）以供後續 B-024；確認此唯讀暴露不需 `vendor_dispatch` ON（本文件：appointment 欄在 `repair_approvals` ON 即可讀，不依 `vendor_dispatch`）。（PE／B-024 owner）
7. **B-021 相對 B-013 的 stacked-PR 合併順序**：B-013 PR #28 仍 `verifying`；B-021 stack 於其上，merge 等 B-013 done＋CEO GO。若 B-013 schema 於 QA 變更，B-021 reader migration 依最終 SHA 重綁——確認此 stacked 流程。（PE／Ron）

---

## 判定：PROCEED（BUILD-ONLY）

**PROCEED。** 本設計把 B-021 由 `partial` 推進至 `done（build-only / flag-OFF）`：交付一支 forward-only migration（**僅三支 service-only SECURITY DEFINER 讀取 gateway，不建表/不改表/不加 table grant，flag OFF 回空集 fail-closed**）、owner 決定 production caller（複用既有 `b013_decide_estimate`，reapproval/stale/非指定屋主/一版一終局/currency/冪等全由既有 gateway 強制）、flag-gated brand-v2 owner approval cards ＋ minimal manager view（**flag OFF 時 `/o/approvals` 逐 byte 等同今日 placeholder**）、純顯示規則擴充，並對 PROP-11 W1–W7 明確切分 build-side 已做（含 W6 party-visibility 首次落地於 owner/manager reader scope）vs reader/storage/flag ON-gate。Acceptance：#1 由既有設定切片滿足（reconciliation 驗證、不重建）、#2/#3/#4 於 flag-ON 隔離 org 以整合＋UI 測試可觀察。**未觸及任何 STOP 條件**（無 flag ON、無 seed、無建表/無 table grant、無 hosted apply、無 main merge、無真實送達/自動付款、無偽造核准、無繞過 owner 核准、既有設定/live 模組 flag-OFF 零位移）。啟用（flag flip、staging owner 資料、live owner/manager UX、reader 對 live 的 W6 storage/PII 複檢）為 separate decision，明列不 overclaim。

---

## Implementation checklist for Codex（exact files）

**新建檔**
- `supabase/migrations/20261105180000_b021_repair_approval_reads.sql`（ts > `20261105170000`）：三支讀取 gateway `app.b013_owner_pending(uuid,uuid)`／`app.b013_owner_history(uuid,uuid,uuid)`／`app.b013_manager_view(uuid,uuid,uuid)`，每支 `SECURITY DEFINER`＋`SET search_path=pg_catalog,public,app,pg_temp`＋入口 `b013_actor` session 驗＋`b013_approvals_enabled` OFF 回空集＋owner reader 綁 `designated_principal_id = actor`＋org/ticket scope；每支 `REVOKE ALL ... FROM PUBLIC,anon,authenticated,service_role` 後 `GRANT EXECUTE ... TO service_role`。完整 `BEGIN…COMMIT`、`SET LOCAL lock_timeout/statement_timeout`、**無 CREATE/ALTER TABLE、無 table GRANT、無 DROP/down 腳本、無 flag seed**。
- `src/app/api/owner-repair-decision/route.ts`（production caller；POST；`requireCurrentConsent`＋`getSession`，比照 `owner-repair-policy/route.ts`；server 鑄 `request_id`；呼 `decideEstimate`；回 gateway 結果；flag OFF 經 gateway `rejected_disabled`）。
- `src/app/o/approvals/approval-cards.tsx`（brand-v2 owner approval card；version/amount/scope/evidence refs/threshold/submitted_at；approve/reject/more_information 表單；emergency 區塊 category/reason/photo refs ＋「intent recorded」；僅 flag ON render）。
- `src/app/o/approvals/[ticketId]/page.tsx`（owner history 檢視，呼 `ownerHistory`；flag-gated；OFF 回安全空狀態、不洩結構）。
- manager minimal view 區塊（flag-gated；宿主路徑 **待核 confirm against code**，例如既有 manager 修繕/工單詳情；呼 `managerApprovalView`，顯示帶 `decided_at` 決定＋緊急/intent 狀態）。

**編輯檔（flag-OFF byte-identical；僅 flag ON 新增路徑）**
- `src/app/o/approvals/page.tsx`：加 `repair_approvals` flag 分岔。**OFF 分支 return 與今日完全相同之 JSX、不呼 reader**；ON 分支呼 `ownerPending` render cards。
- `src/server/repair-approval.ts`：新增 reader wrapper `ownerPending(session)`／`ownerHistory(session,{ticketId})`／`managerApprovalView(session,{ticketId})`（呼三支 reader，jsonResult/SETOF 解析）；更新模組 doc（現有 flag-gated production caller）；既有 `decideEstimate` 等不改、flag-OFF 路徑不變。
- `src/server/repair-approval-rules.ts`（pure）：新增 `pendingClassify`／`intentStatusLabel`（永不「sent」）／`reapprovalHint`／`decisionLabel`／`emergencyPhotoRefShape`；沿用 `repair-rules.ts` idiom、無 I/O。
- i18n catalog：新增 approval card／decision／emergency／intent-status copy keys（文案自 brand-v2 copy deck，最終字串 待核）。

**測試檔**
- `src/server/repair-approval-rules.test.ts`（擴充 unit：pendingClassify／intentStatusLabel／reapprovalHint／decisionLabel／emergencyPhotoRefShape）。
- `src/server/repair-approval-reads.schema.test.ts`（static SQL：三 reader SECURITY DEFINER／search_path／b013_actor／b013_approvals_enabled／REVOKE 含 service_role＋僅 GRANT EXECUTE／無 CREATE/ALTER TABLE／無 table GRANT／ts 次序）。
- `src/server/repair-approval.gateway.test.ts`（更新：唯一 production caller ＝ flag-gated owner route ＋ reader；flag OFF `/o/approvals` 不呼 reader；decide route fail-closed）。
- `src/app/o/approvals/approvals-off.test.ts`（UI OFF byte-identical：凍結今日 placeholder golden、斷言 OFF render 相同、reader 0 calls）。
- `e2e/pg/b021-repair-approval-reads.pg.test.ts`（PG17 整合，disposable clone 先套 B-013：owner_pending_scoped_to_designated_principal、property_isolation、owner_history_same_ticket_org、owner_cannot_see_other_owner、manager_staff_only、manager_view_cross_org_empty、threshold_equality_above、stale_decision_rejected、non_designated_owner_rejected、decision_visible_to_manager、emergency_visibility、reader_off_fail_closed、decide_replay_returns_original、decide_payload_change_conflict）。

**不動（flag-OFF byte-identical；僅 flag ON 新增 reader/UI 路徑）**
- `src/server/repairs.ts`、`vendor-repair.ts`、`domain.ts`、`repair-rules.ts`；B-013 migration `20261105170000` 與其 6 寫入 gateway（含 `b013_decide_estimate`）；設定切片 `20261031100220`/`221` 與 `repair-owner-policy.ts`/`repair-owner-override.ts`/其 route/pages；PROP-11 migration 與 `repair-cost.ts`；`auth.ts`/`perms.ts`/session 身分面。

**manifest／test registry 必須更新**
- `scripts/write-pr-migrations.mjs`：新增 `20261105180000_b021_repair_approval_reads.sql` 的 **classification entry**（reader-only、additive、no table/grant change）。
- `lease-rules.test.ts`（migration list）：將新 migration加入清單／ordering 檢查（`supabase/migrations` 目錄序）；**不重跑既有已套用檔**。
- `repair-owner-default.integration.test.ts` ／ `repair-owner-override.integration.test.ts`（privilege 掃描）：擴充 service_role-EXECUTE gateway 清單由 **6 → 9**（新增 `b013_owner_pending`／`b013_owner_history`／`b013_manager_view` 之明確名）；斷言 **7 張 `app.b013_*` 表仍無任何直接 grant（anon/authenticated/service_role 皆零表權）**、helper（`b013_actor`／`b013_approvals_enabled`／`b013_replay`／`b013_store_result`／`b013_lock_version`／`b013_photo_refs`）仍 private、其餘一切仍 private。
- `repair-approval.gateway.test.ts`（見上，no-caller 斷言更新）。
- 證據輸出目錄 `/workspace/e2e/results/B-021/`（schema diff、PG17 結果、OFF byte-identical golden、Acceptance #1 reconciliation 快照、9-gateway/7-table counts/grants snapshot）。

**合併前**
- Class B 獨立審查逐條走 §錢／權限風險 1–10（重點 3 owner reader scope、6 緊急零偽造核准＋intent-not-sent、2 reapproval 不沿用、8 flag-OFF byte-identical、9 冪等）。
- disposable PG17 clone（先套 B-013）驗 reader 套用/rollback/REVOKE-GRANT/OFF-空集；**不碰 hosted/prod**。
- flags OFF、不 merge main（待 CEO GO）；B-021 stack 於 B-013 PR #28 之上，hosted apply、flag flip、staging owner 資料、live owner/manager UX、reader W6 storage 複檢皆為 separate decision，Ron/PE 核。

## Addendum (PE, B-013 QA r1 ON-gates folded into B-021 build pass)
- Readers take `(p_org, p_live, p_env, p_session, ...)` and verify org/environment pairing exactly like `app.b013_owner_context` (live: org=live & live_org_id NULL; sandbox: org.live_org_id=p_live; organizations.environment = p_env) in addition to `b013_actor`. Write gateways' `b013_actor` env binding stays an ON-gate (not changed here).
- Appointment→vendor job invariant: additive `BEFORE INSERT` trigger on `app.b013_repair_appointments` asserting `repair_vendor_jobs.org_id/ticket_id` = row org/ticket (raises 23503), closing the single-column-FK gap at DB level.
- Reader projections expose photo refs as `id` only (strip extra fields) — storage authz remains ON-gate.

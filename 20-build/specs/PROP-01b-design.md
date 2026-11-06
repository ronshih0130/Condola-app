# 設計說明 — PROP-01b（L1-ID Wave B）

> 存成 `20-build/specs/PROP-01b-design.md`。
> 範本：`template-design-note.md`（CEO 2026-11-03 核准）。用詞以 /GLOSSARY.md 為準（org／staff／portal／live／sandbox／vendor token）。
> Stack：`feat/b-032-regional-formats` @ `7e38cea`（含 `main` @ `b9ef5fe` SEG2）。此 SHA 為本設計之 baseline；不 rebase、不 merge main。
> 類別：**B（權限／隔離 risk）**。相依：**PROP-01a（L1-ID staff／portal 身分解析單一入口，已完成）**——本項為其 Wave B 的**平行姊妹**：為 vendor token 身分面建立對等的具名解析入口。消費端／閘：**PROP-10（L1-VEN，V-12＋V-13 硬閘；FR-P0-04 自動歸戶／login-home）** 與 **B-026**（vendor 單案 token acceptance，待核）。涵蓋能力：`CAP-V-11`（vendor 帳號身分面）、`CAP-V-13`（登入歸戶身分連結）**皆待核**。
> **判定：PROCEED（BUILD-ONLY）。** 本設計交付「vendor token 身分面」的**單一具名解析入口**（平行 PROP-01a `resolveIdentity`）＋登入歸戶的 **resolver/stub 基礎**；**reuse 既有 `token_hash`／vendor link／`repair_vendor_jobs` 檢查、一概不取消**；**不**實作自動歸戶／login-home（＝PROP-10／FR-P0-04）；**無新 flag ON、無新 flag seed、無 migration**（除非不可避免則 forward-only＋grants fail-closed，見 §資料表）；**不 merge main（待 CEO GO）**、不動 PROP-MF／BO 排序、不碰 messaging。未觸及任何 STOP 條件。

## 使用者故事／能力 ID

- **覆蓋**：L1-ID（Wave B 切片）、`CAP-V-11`／`CAP-V-13`（皆待核）之**前置基礎**——把「目前這張 `/v/[token]` 請求的 vendor → 哪一個案件／哪一個 org／可寫或唯讀／是否可被登入歸戶」的解析，收斂成**單一、具名、可單測、有文件契約**的伺服器端入口 `resolveVendorIdentity(...)`，供 PROP-10 的自動歸戶（V-13）與 B-026 的 vendor UI 在穩定介面上施作，而非各自重算 token_hash／capability 或伸手進 `/v/[token]` loader 內部。
- 對應 proposals：`PROP-01b`（proposal only；非 B id）。關聯 B 項：`B-026`（vendor 單案 token acceptance，待核；若採納擴充其 acceptance、不新開 B）、連 `B-024`／`B-031`／`B-035`（待核；見 arch §8 L1-VEN）。
- **對應既有程式**：`vendor-link-rules.ts`（`VENDOR_LINK_ENABLED` kill switch、`vendorLinkOn` flag gate、`vendorLinkCapability` 效力判定、`vendorLinkSafeView` 顯示 allowlist）、`repair_vendor_jobs`／`repair_vendor_secrets`（`token_hash`／active／revoked／expiry）、`/v/[token]` route。
- **刻意不覆蓋**：
  - **自動歸戶／接續未結案的實際寫入**＋**歸戶紀錄（含誤歸戶可追溯）**＝ `PROP-10`／`CAP-V-13`／FR-P0-04；本項只給 PROP-10 一個**可消費的解析結果＋`linkable` 旗標**，**不執行任何歸戶寫入**；
  - **V-12＋V-13 硬閘的實際放行**（登入後自動接續、login-home 落點）＝ PROP-10；
  - vendor **帳號註冊／登入流程本身**（signup、`signInWithLine` 的 vendor 分支）；
  - B-026 的 **vendor 可見 UI**（單案頁面、歷史清單阻擋畫面）；
  - 權限矩陣（`perms.ts`）、staff／portal 身分（PROP-01a 已完成之 `resolveIdentity`）任何列為或結果。

## Done means

一句話：**所有 `/v/[token]` vendor token 存取皆經由同一個具名入口 `resolveVendorIdentity(...)` 解析出 `{ kind:"vendor", jobId, orgId, capability, tokenHash, linkable }`，且對 stack `7e38cea` 的每一種輸入組合（token 有效／撤銷／到期／不存在 × 案件狀態 × kill/flag gate）解析結果與今日 `/v/[token]` 內嵌邏輯逐欄位相同**——同一個 `token_hash` 比對、同一份 `vendorLinkCapability`（write／read_only／invalid）判定、同一個「單案綁定、不授予歷史清單、跨 org／跨案件拒絕」行為；而 PROP-10 日後可直接消費此入口與 `linkable` 旗標做歸戶，無須重算。

- **Staging（stack SHA）**：在 `feat/b-032-regional-formats @ 7e38cea` 上 build、綠燈、部署 staging；QA packet 附上（見 §驗證）。
- **flags OFF**：`VENDOR_LINK_ENABLED` 維持 `false`、`vendor_link` flag 不新增、不 seed ON；flag OFF ＝今日行為。本項**不新增任何使用者可見行為**（既有 `/v/[token]` 行為逐欄位不變、僅改由具名入口計算），故不需新 gate。
- 可觀察：以有效 token 開 `/v/[token]`，看到的頁面（`vendorLinkSafeView` 投影、可寫／唯讀、404 vs 過期訊息）與重構前**逐畫面不可區分**；staff／portal／`getSession()` 路徑**完全未碰**。

## 端到端 tracer bullet

最小可行、**只走 vendor token 面**的一條路徑（本 SHA 後）：

1. vendor 持 URL `/v/<token>`（無 session cookie、非 staff／portal）請求該頁。
2. route／loader 讀 path param `token`、算 `now`；**既有 gate 原位不動**：`VENDOR_LINK_ENABLED` kill switch ＋ `vendorLinkOn(killSwitch, featureFlags)`（fail-closed；任一不滿足即視同無存取，與今日相同）。
3. **新：** loader 把 `{ token, now, linkedUserId: null }` 收成 `VendorResolveCtx`，呼叫**單一入口** `resolveVendorIdentity(sql, ctx)`：
   - 以 `token_hash` 查 `repair_vendor_secrets` →（命中）JOIN `repair_vendor_jobs` 取該**單一案件**列（含 `orgId`、ticket status、active、revokedAt、expiresAt）。**SQL 原封搬自今日 loader，WHERE／JOIN 不改。**
   - 以 `vendorLinkCapability({ ticketStatus, active, revokedAt, expiresAt, now })`（**原封呼叫，不改**）得 `write｜read_only｜invalid`。
   - 計 `linkable`（純衍生，不寫任何關聯）；組 `{ kind:"vendor", jobId, orgId, capability, tokenHash, linkable }` 回傳。
   - token_hash 查無 → 回 `null`（＝今日「此 token 不存在」）；查有但效力 invalid → 回 `capability:"invalid"` 的解析（＝今日「過期／撤銷」而非 404）。**此 null vs invalid 的區分必須與今日相同。**
4. loader 以解析結果決定顯示：命中且 `write`／`read_only` → 以 `vendorLinkSafeView(jobRow)`（**原位、原行為**）投影顯示 allowlist 欄位；`invalid` → 過期／撤銷畫面；`null` → 404。**此副作用／投影邏輯留在 loader，不進 resolver。**
5. **可觀察結果**：有效 token 看到同一案件、同一組 safe-view 欄位、同一份可寫／唯讀狀態；**單案 token 看不到任何歷史清單、看不到他案、看不到跨 org 任何資料**（與今日相同）。
6. **登入歸戶基礎（stub，本 SHA 不觸發）**：`resolveVendorIdentity` 的 `linkable` 旗標與（未來帶入的）`linkedUserId` 是 PROP-10 歸戶的唯一消費點；本 SHA 不提供任何歸戶寫入函式。

> 本 B 項不需拆多條對外狀態；BUILD-ORDER 單一狀態欄位維持一項（build-only / flag-OFF）。

## Caller-first 介面

**呼叫端怎麼用（先）**，以及**與 PROP-01a 的關鍵差異**：

| | PROP-01a `resolveIdentity`（staff／portal） | PROP-01b `resolveVendorIdentity`（vendor，本項） |
|---|---|---|
| 身分來源 | **已登入** session cookie → `userId` | **未登入** URL path 的 `token`（無 userId） |
| 鍵 | `(userId, ctx)` | `(ctx.token)`（登入歸戶時可選帶 `linkedUserId`） |
| 回傳 | `IdentityResolution`（`Session` 的 org 子集） | `VendorIdentityResolution`（**非** `Session`；單案綁定） |
| 是否成 `Session` | 是（經 `readSessionOn` 組出 `Session`，`kind∈{staff,tenant,owner}`） | **否**。`Session.kind` **不**擴充 "vendor"；vendor 不經 `getSession()`、不觸 `org_members`、不進 `perms`／nav |
| org 授權 | active live membership → org／role | **無 membership**；只讀該案 `orgId` 供上游定位，**不授予該 org 任何其他資料** |

- **PROP-10（消費端）怎麼用**：在它需要「這張 token → 哪一案／哪一 org／可寫否／可否歸戶」時，呼叫**同一顆具名核心** `resolveVendorIdentity(...)`，消費其契約與 `linkable`；歸戶（把 `linkedUserId` 寫入關聯＋留可追溯歸戶紀錄）由 PROP-10 施作，**不在本入口內**。
- **B-026（消費端）怎麼用**：vendor 單案 UI 以 `capability` 決定可寫／唯讀、以 `jobId` 限定單案、以 `vendorLinkSafeView` 投影——皆基於本入口結果，不重算 token_hash。
- **摩擦訊號檢核**：若 PROP-10 發現必須繞過此入口自行查 `repair_vendor_secrets`／`repair_vendor_jobs` 才能判斷歸戶，視為契約欄位不足的訊號，回頭補契約（例如 `linkable` 的語義、或增一個不寫入的「可歸戶候選」衍生欄位），而非讓消費端繞彎。

**反推簽章（proposed；函式／模組名 待核，標記為新建）**：

```ts
// 新檔 src/server/vendor-identity.ts（路徑待核）
import type { VendorLinkCapability } from "./vendor-link-rules";

export type VendorIdentityResolution = {
  kind: "vendor";
  /** 單案綁定：此 token 僅解析到這一個案件；不授予歷史清單、不跨案。 */
  jobId: string;
  /** 該案所屬 org（供上游 RLS／稽核定位；不授予該 org 任何其他資料、不產生 membership）。 */
  orgId: string;
  /** reuse vendor-link-rules.ts：write｜read_only｜invalid（來自 vendorLinkCapability）。 */
  capability: VendorLinkCapability;
  /** 對應 repair_vendor_secrets 的雜湊；絕不含明文 token，絕不入 log。 */
  tokenHash: string;
  /** 登入歸戶基礎（stub 旗標）：此解析是否「可被」登入使用者歸戶（有效 token ∧ 未結案）。
   *  本 SHA 只計算與回報、不執行任何歸戶寫入；歸戶寫入與紀錄＝PROP-10／V-13。 */
  linkable: boolean;
};

export type VendorResolveCtx = {
  token: string;              // 來自 /v/[token] 的明文 token（path param）
  now: Date;                  // 效期／撤銷判定時點（注入以利單測）
  linkedUserId?: string | null; // 登入歸戶基礎：若呼叫端已登入可帶入；本 SHA 僅用於計 linkable，不寫關聯。預設 null
};

/** 單一 vendor 身分解析入口（平行 resolveIdentity）。
 *  token_hash 查 repair_vendor_secrets → JOIN repair_vendor_jobs → vendorLinkCapability。
 *  純解析：不寫歸戶、不觸 org_members、不呼 resolveIdentity、絕不回傳 Session。
 *  token 不存在 → null；存在但效力不足 → capability:"invalid" 的解析（不等於 null）。 */
export function resolveVendorIdentity(
  sql: SqlClient, ctx: VendorResolveCtx,
): Promise<VendorIdentityResolution | null>;
```

- **kill switch／flag gate 不進 resolver**：`VENDOR_LINK_ENABLED`／`vendorLinkOn` 維持在 loader／route 原位（fail-closed、原行為），與 PROP-01a 把 `touch`／consent／seed 留在 `session.ts` 的切法一致——resolver 保持「純解析」，避免被誤用時旁生寫入或 gate 位移。
- **`vendorLinkSafeView` 不進 resolver**：顯示投影留在 loader，原位原行為（該檔自述「never forward source objects」原則不破壞）。

## 資料表與 RLS

- **無新增／變更資料表、欄位、索引、RLS policy。** 本 SHA 純建立具名解析入口＋抽取既有 token_hash／capability 邏輯。
- 讀取的既有表（SQL 原封搬移，WHERE／JOIN／ORDER BY 不變）：`repair_vendor_secrets`（`token_hash`／`revoked_at`／`expires_at`／`active`）、`repair_vendor_jobs`（案件狀態／`org_id`／顯示欄位）。
- **Migration**：**無**。歸戶紀錄表（「vendor 身分 ↔ 未結案案件」連結＋**誤歸戶可追溯**紀錄）是**寫入路徑**，屬 PROP-10／V-13，本 SHA 不實作、不建表。
  - **若** Class B 審查判定「foundation 無此表則 PROP-10 無法安全接」而**不可避免**：限**一張 additive、forward-only、re-runnable** 的表（舊碼可跑新 schema），**grants fail-closed**（預設無授權、顯式授予最小讀寫），**不 seed、不開任何 flag ON**；本 SHA 仍**不寫入**該表（只建結構供 PROP-10 用）。此選項列為開放問題，預設**不採**。
- **Flag**：**不新增 flag、reuse registry**。`vendor_link` flag ＋ `VENDOR_LINK_ENABLED` kill switch 維持現狀、fail-closed（`vendorLinkOn`：`killSwitch !== true` 或 flag 非 `true`/"true" → `false`）。本項為「具名入口化＋行為保持」，無新使用者可見行為 → 不需新 gate；flag OFF ＝今日。PROP-10 日後若引入自動歸戶／login-home 的使用者可見變更，須走既有 Mode B 判定式（arch §5：平台 `enabled` ∧ allowlist ∧ org override，缺一即 OFF）、default OFF——但那屬 PROP-10，不在本 note。

## 錢／權限風險（Class B 判定）

**判定：Class B（跨 org／跨案件隔離＋誤歸戶 risk）。** 本入口是 vendor 存取的「token → 案件／org／可寫否／可歸戶否」決定點；解析錯＝跨 org／跨案件外洩或**誤歸戶**（把案件接到錯的登入者）。**不得改變任何既有授權／效力結果。** 審查須逐條檢視：

1. **單案綁定、不授予歷史清單**：一張 token 只解析到**一個** `jobId`；`resolveVendorIdentity` 絕不回傳案件清單、絕不讓 vendor 列舉同 org 其他案（arch：「單案 token 不授予歷史清單」）。審查確認回傳型別無集合、SQL 以 token_hash 唯一定位單列。
2. **跨 org／跨案件拒絕**：`orgId` 僅供上游定位，**不授予該 org 任何其他資料、不產生 membership、不轉成 staff／portal `Session`**。審查確認 resolver 未呼 `resolveIdentity`／`resolveStaffOrg`／`resolvePortalOrg`、未讀 `org_members`。
3. **`token_hash` 比對完整性**：以雜湊比對、不以明文；`tokenHash` 與明文 `token` **絕不入 log／不入錯誤訊息**。審查對照今日 SQL 的 hash 計算與比對一字不差。
4. **效力判定不得放寬**：`vendorLinkCapability` 的 `invalid` 條件（`!active ∨ revokedAt!==null ∨ 非有限 expiry/now ∨ now>=expiry`）**原封保留**；可寫狀態清單（`open｜triaged｜assigned｜in_progress｜on_hold｜resolved`）**一字不差**，其餘狀態為 `read_only`。抽取後任何重排即越權。
5. **null vs invalid 語義**：token 不存在回 `null`（404），存在但效力不足回 `capability:"invalid"`（過期／撤銷畫面）。反轉或混淆會洩漏「此 token 是否存在」或讓過期 token 誤顯有效。
6. **誤歸戶（最高風險，login-link 基礎）**：本 SHA **不得**執行任何歸戶寫入。`linkable` 僅為衍生旗標、`linkedUserId` 僅用於計算 `linkable`，**不寫任何 vendor↔user／vendor↔job 關聯**。審查確認本模組無任何 INSERT／UPDATE 到歸戶關聯；歸戶（含三情境 token 共存、誤歸戶可追溯紀錄）一律 PROP-10。
7. **三情境 token 共存**（首次／臨時、緊急、既有未結案舊連結）：同一案件可有多個 `repair_vendor_secrets` 列；每張 token 以**自己的** secret 列獨立判定效力，一張過期／撤銷**不得**影響另一張有效 token 的解析，反之亦然。審查以多列 fixture 驗證互不污染。
8. **kill switch／flag fail-closed 未位移**：`VENDOR_LINK_ENABLED=false` 與 `vendorLinkOn` 留原位、原行為；本 SHA 不新增繞過 gate 的路徑。

**金額／付款對象／租約效力**：本入口不直接涉及金流；但 vendor 可寫案件可能牽動修繕費用與負擔方（L1-RPR／FR-P0-01/03/05 下游），故列 Class B，不改既有 vendor 可見／可寫邊界。

## HITL／AFK

- **AFK（agent 可自行完成）**：既有 token_hash／capability 邏輯的**抽取＋具名入口化＋行為保持**，可由 pre/post characterization golden 自動驗（見 §驗證）；單測 table-driven 可自動跑。
- **HITL（人工定稿／簽核）**：
  - **契約形狀**（`VendorIdentityResolution`／`VendorResolveCtx`／`linkable` 語義、是否擴 `Session.kind`）——本文件定稿為「**不**擴 `Session.kind`、vendor 不成 `Session`」，待開放問題回填即轉 AFK。
  - **Class B 獨立審查強制**（PRINCIPLES 37）：合併前須有獨立審閱逐條走完上節 1–8（尤其第 6 誤歸戶「零寫入」、第 1/2 單案／跨 org），確認 `vendor-link-rules.ts` 行為零位移。此標記不改變 BUILD-ORDER 的 B 項順序或分工，僅為執行提示。
  - **是否需歸戶表**（§資料表 fallback）＝人工判定；預設不採，採則需 CEO／Ron 核。

## 驗證方式與可觀察證據

不寫「跑測試」，寫真實介面／真實輸入／可觀察狀態：

- **Golden／characterization 比對（核心證據）**：對 stack `7e38cea`，以一組真實輸入矩陣——（token∈{不存在／有效／已撤銷（`revoked_at`）／已過期（`now>=expires_at`）／`active=false`}）×（案件狀態∈{可寫清單各狀態／非可寫狀態}）×（kill/flag gate∈{OFF／ON}）×（同案多 token 共存∈{單張／三情境共存}）——分別取「重構前 `/v/[token]` 內嵌邏輯」計算出的 `{jobId, orgId, capability, 顯示 null/invalid/命中}` 作為 golden，驗「重構後 `resolveVendorIdentity`」逐欄位相等。
  - **單案 token 不得解析出任何他案或清單**（第 1 條）；
  - **跨 org token 不得解析出他 org 任何資料**（第 2 條）；
  - **三情境共存**：一張撤銷／過期不得影響另一張有效（第 7 條）；
  - **null vs invalid** 區分與今日相同（第 5 條）。
- **真實畫面走查（staging）**：
  - 有效 token 開 `/v/[token]`：顯示同一案件、同一組 `vendorLinkSafeView` 欄位、同一可寫／唯讀狀態（與 baseline 不可區分）；
  - 撤銷／過期 token → 過期訊息（非 404）；不存在 token → 404；
  - gate OFF（`VENDOR_LINK_ENABLED=false`／flag 關）→ 與今日同樣無存取。
- **feature map（如何走到／如何驅動／什麼可觀察）**：使用者＝持 token URL 開 `/v/[token]`；agent 驅動＝以 fixture `VendorResolveCtx` 直接呼 `resolveVendorIdentity`；可觀察狀態＝回傳解析欄位與頁面投影／可寫狀態與 baseline 不可區分，且**無任何歸戶關聯被寫入**（查 DB 無新關聯列）。
- **不經 staff／portal**：全部證據走 vendor token 面，不觸 `getSession()`／`resolveIdentity`。
- **回歸閘**：既有 vendor-link 相關測試綠（`vendorLinkCapability`／`vendorLinkOn`／`vendorLinkSafeView` 結果不變）；staff／portal 的 `perms.test.ts`、`session-identity.integration.test.ts`、PROP-01a 的 `identity.test.ts` **不受影響**（本項不碰該路徑）。

## 不做什麼

- **不實作自動歸戶／接續未結案（登入後 auto-attribution）**＝ PROP-10／`CAP-V-13`／FR-P0-04。本 SHA 只給 `linkable` 旗標＋可消費的解析結果；**零歸戶寫入**。
- **不實作 V-12＋V-13 硬閘放行、不做 login-home／落點**＝ PROP-10。
- **不建歸戶紀錄表、不寫誤歸戶追溯紀錄**（寫入路徑屬 PROP-10；本項預設不建表，見 §資料表 fallback）。
- **不做 vendor 帳號註冊／登入流程**（signup、`signInWithLine` 的 vendor 分支）；不碰 `auth.ts`。
- **不做 B-026 的 vendor 可見 UI**（單案頁面、歷史清單阻擋畫面）；本項只給其後端解析契約。
- **不擴 `Session.kind` 為 "vendor"**（會波及 `perms`／nav／`assertStaff`）；vendor 不經 `getSession()`、不成 `Session`、不觸 `org_members`。
- **不改 `vendor-link-rules.ts` 任何行為**：`VENDOR_LINK_ENABLED`、`vendorLinkOn`、`vendorLinkCapability`（含效力條件與可寫狀態清單）、`vendorLinkSafeView`、`renderableTypeFields` 輸出一律不變（僅呼叫／複用）。
- **不取消既有檢查**：`token_hash`／active／revoked／expiry／單案綁定／跨 org 拒絕一概保留。
- **不新增 migration／flag／RLS**（除 §資料表 fallback 且經核）；**不 seed flag ON、不 merge main（待 CEO GO）**、不動 PROP-MF／BO 排序、不碰 messaging。
- **不發明不存在的表／flag／函式名**；新建函式名／模組路徑標 **待核**。

## 開放問題（可非同步填答）

1. **單一入口命名**：`resolveVendorIdentity` / `VendorIdentityResolution` / `VendorResolveCtx` / 新檔 `src/server/vendor-identity.ts` 可否定案？（Ron／CEO）
2. **`linkable` 語義**：定為「有效 token（capability≠invalid）∧ 案件未結案」是否足夠供 PROP-10 歸戶判斷？是否需另一不寫入的「可歸戶候選」欄位？（Ron／PROP-10 owner）
3. **是否建歸戶表（§資料表 fallback）**：PROP-10 能否以「無表、只消費解析＋`linkable`」起步，歸戶表留 PROP-10 自建？若必須在本 SHA 先建 additive 表，確認 forward-only＋grants fail-closed＋不 seed／不開 flag？（Ron／CEO）
4. **`/v/[token]` 是否即時改走具名入口**：本 SHA 行為保持地 rewire loader → `resolveVendorIdentity`（取 golden 證據），或先只新增入口供 PROP-10／測試、loader 暫不動？建議前者（與 PROP-01a rewire `readSessionOn` 一致）。（PE／Ron）
5. **「不新增 flag」確認**：行為保持、flag OFF＝今日，確認不需任何新 gate？`VENDOR_LINK_ENABLED` 續維持 `false`？（CEO per arch §5）
6. **B 項連結**：PROP-01b ↔ `B-026`（及連 `B-024`／`B-031`／`B-035`）的「待核」連結是否確認？（Ron）

---
來源：10-product/step4-architecture/architecture-v0.md §8（L1-ID／L1-VEN、V-12＋V-13、三身分面）；build-order-proposal-v0 §4.3／§4.5（邊界、Wave B 硬閘）；replan §3.2／§5、step3 §3A.4（token 共存／歸戶）；vendor-id §2／§3；code：`vendor-link-rules.ts`、`types.ts`（`Session`）、PROP-01a-design.md（平行入口範式）。用詞以 /GLOSSARY.md 為準。

## Implementation checklist for Codex

- **新建 `src/server/vendor-identity.ts`（路徑待核）**：`VendorIdentityResolution`、`VendorResolveCtx` 型別；`resolveVendorIdentity(sql, ctx)`——`token_hash` 查 `repair_vendor_secrets` →（命中）JOIN `repair_vendor_jobs` 取**單一案件**列 → `vendorLinkCapability(...)`（原封呼叫）得 capability → 計 `linkable`（純衍生，**零寫入**）→ 組回傳；token 不存在回 `null`，存在但效力不足回 `capability:"invalid"`。SQL 一字不改自今日 `/v/[token]` loader。
- **改 `/v/[token]` route／loader**（若採開放問題 4 前者）：把 `token`／`now`／`linkedUserId:null` 收成 `ctx` → 呼 `resolveVendorIdentity`；**保留** `VENDOR_LINK_ENABLED`／`vendorLinkOn` gate 於原位（fail-closed）、`vendorLinkSafeView` 顯示投影於原位、null/invalid/命中分支行為原樣。
- **不動**：`vendor-link-rules.ts`（僅呼叫／複用，型別新增放 `vendor-identity.ts`）、`session.ts`／`identity.ts`（PROP-01a）、`org-scope.ts`、`portal-role.ts`、`perms.ts`、`middleware.ts`、`types.ts`（**不擴 `Session.kind`**）、`auth.ts`。
- **零歸戶寫入**：本模組不得有任何 INSERT／UPDATE 到 vendor↔user／vendor↔job 關聯；`linkedUserId` 僅計 `linkable`。
- **無 migration、無新 flag、無新 flag seed、無 RLS 變更**（除 §資料表 fallback 且經核：forward-only＋grants fail-closed＋不 seed）。
- **新單測 `vendor-identity.test.ts`**：table-driven 覆蓋 §驗證矩陣——單案綁定（不回清單）、跨 org／跨案件拒絕、`token_hash` 效力（active／revoked／expired／不存在）、可寫狀態清單一字不差、`null` vs `invalid` 區分、三情境 token 共存互不污染、`linkable` 衍生正確、**不回傳 `Session`／不觸 `org_members`**。
- **回歸**：既有 `vendorLinkCapability`／`vendorLinkOn`／`vendorLinkSafeView` 測試綠；staff／portal 的 `perms.test.ts`、`session-identity.integration.test.ts`、PROP-01a `identity.test.ts` 不受影響。
- **建議補** pre/post characterization 比對（fixture `ctx` → `{jobId, orgId, capability, null/invalid/命中}` golden 相等）。
- **合併前**：Class B 獨立審查逐條走 §錢／權限風險 1–8（重點 6 誤歸戶零寫入、1/2 單案＋跨 org、7 token 共存）；證據走 vendor token 面、不經 `getSession()`；staging 部署於 `7e38cea`＋QA packet；**flags OFF、不 merge main（待 CEO GO）**。

## ON-blocker (QA r2, 2026-11-05) — build-only done @ `8706459`
- Before `VENDOR_LINK_ENABLED`: switch bare `digest()` in `resolveVendorIdentity` SQL to `pg_catalog.sha256(convert_to(...))`, or prove service_role search_path resolves pgcrypto deterministically.

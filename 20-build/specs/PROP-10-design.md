# 設計說明 — PROP-10（L1-VEN：vendor token＋登入歸戶身分連結基礎）

> 存成 `20-build/specs/PROP-10-design.md`。
> 範本：`template-design-note.md`（CEO 2026-11-03 核准）。用詞以 /GLOSSARY.md 為準（org／staff／portal／live／sandbox／vendor token）。
> Stack：`feat/prop-01b-vendor-identity` @ `ead2ae3`（含 B-032 ＋ `main` @ `b9ef5fe` SEG2 ＋ PROP-01b `resolveVendorIdentity`＋`linkable`）。此 SHA 為本設計之 baseline；**不 rebase、不 merge main（待 CEO GO）**。
> 類別：**B（跨 org／跨案件隔離＋誤歸戶 risk）**。相依：**PROP-01a**（staff／portal 身分解析單一入口 `resolveIdentity`／`getSession`，build-only done/verifying）＋ **PROP-01b**（vendor token 身分解析單一入口 `resolveVendorIdentity`＋`linkable`，build-only done/verifying）。涵蓋能力：`CAP-V-12`／`CAP-V-13`（Wave B 硬閘，共同通過；皆待核）、連 `CAP-V-02`（vendor 單案 token acceptance，細設延後）；對應 `FR-P0-04`（登入後自動歸戶／login-home）。消費端／後續：V-13 實際放行階段、B-026（vendor 單案 UI）。
> **判定：PROCEED（BUILD-ONLY）。** 本設計交付 FR-P0-04 的**歸戶基礎**——以 PROP-01b 的 `resolveVendorIdentity`＋`linkable` 為唯一消費點，建立「可持久化的**歸戶紀錄形狀**（durable attribution record shape，含誤歸戶可追溯欄位）＋**純推導、零寫入的 write-path stub** `planVendorAttribution`＋V-12／V-13 硬閘的 **inert wiring（fail-closed）**」。**不**實作自動接續未結案的實際寫入、**不**做 login-home 落點、**不**翻任何閘 ON；**reuse** PROP-01b 的 SQL／hash／`vendorLinkCapability`／`linkable` 語義一字不改、**reuse** `vendorLinkOn` 既有閘（**無新 flag、無 flag seed、無 migration**，除不可避免則 forward-only＋grants fail-closed，見 §資料表，預設不採）；**不擴 `Session.kind` 為 "vendor"**、**不 merge main**、不動 PROP-MF／BO 排序、不碰 messaging。未觸及任何 STOP 條件。

## 使用者故事／能力 ID

- **覆蓋**：L1-VEN（Wave B 硬閘切片）、`CAP-V-12`／`CAP-V-13`（皆待核）之**歸戶基礎**——把「一張有效、未結案的 vendor token，在**已登入**使用者造訪時，*會被*歸戶到哪個 `userId`、產生哪一筆可持久化、可被稽核／可被反轉（誤歸戶可追溯）的歸戶紀錄」這件事，收斂成**單一、具名、可單測、有文件契約**的伺服器端推導入口 `planVendorAttribution(...)`，供 V-13 實際放行階段在穩定介面上落實寫入，而非各自重算 `token_hash`／capability／linkable 或在 `/v/[token]` loader 內臨時拼歸戶邏輯。
- **消費 PROP-01b**：唯一輸入是 `resolveVendorIdentity(...)` 回傳的 `VendorIdentityResolution`（`{ kind, jobId, orgId, ticketId, capability, tokenHash, linkable }`）。**不重算 hash、不重判 capability、不重算 linkable**；三者語義以 PROP-01b 為準，本項只**讀**。
- 對應 proposals：`PROP-10`（PROPOSAL-derived L1 item，非 B id）。關聯 B 項：`B-026`（vendor 單案 UI，待核；本項只給其後端歸戶契約）、連 `B-024`／`B-031`／`B-035`（待核；arch §8 L1-VEN）。
- **對應既有程式**：`vendor-identity.ts`（`resolveVendorIdentity`／`VendorIdentityResolution`／`VendorResolveCtx`，PROP-01b 已建、本項不改）、`vendor-link-rules.ts`（`VENDOR_LINK_ENABLED` kill switch、`vendorLinkOn` flag gate、`vendorLinkCapability`；本項僅**呼叫 `vendorLinkOn`** 取閘狀態，不改）、`session.ts`／`identity.ts`（PROP-01a `getSession`／`resolveIdentity`，取登入 `userId`；不改）、`/v/[token]` route／loader。
- **刻意不覆蓋**：
  - **自動接續未結案的實際寫入**（把 `linkedUserId` 真正寫入歸戶關聯）＝ V-13 實際放行階段；本項只**推導**該筆紀錄、**零寫入**；
  - **V-12＋V-13 硬閘的實際放行**（登入後自動接續、login-home 落點／redirect）＝ V-13；本項只給 **inert wiring**（閘 OFF 時推導結果為 `gated`、不動作）；
  - vendor **帳號註冊／登入流程**（signup、`signInWithLine` 的 vendor 分支）＝不碰 `auth.ts`；
  - PROP-01b 已交付的解析（token→案件／org／可寫否／linkable）——本項**不重做**，只消費；
  - B-026 的 vendor 可見 UI；權限矩陣（`perms.ts`）、staff／portal 身分路徑。

## Done means

一句話：**對 stack `ead2ae3` 的每一種輸入組合（`resolveVendorIdentity` 回傳 ∈ {null／`invalid`／`read_only`／`write`，`linkable`∈{true,false}} × 登入 `userId`∈{有／無} × 閘 `vendorLinkOn`∈{OFF（今日）／ON}），`planVendorAttribution(...)` 推導出一個確定性的 `VendorAttributionPlan`，且在閘 OFF（今日）時對任何輸入一律回 `status:"gated"`、不產生任何寫入、`/v/[token]` 頁面與 PROP-01b baseline 逐畫面不可區分**——沒有自動接續、沒有 login-home redirect、DB 查無任何歸戶關聯新列；而 V-13 日後可直接消費 `plan.record`（歸戶紀錄形狀）落實寫入，無須重算 hash／capability／linkable。

- **Staging（stack SHA）**：在 `feat/prop-01b-vendor-identity @ ead2ae3` 上 build、綠燈、部署 staging；QA packet 附上（見 §驗證）。
- **flags OFF**：`VENDOR_LINK_ENABLED` 維持 `false`、`vendor_link` flag 不新增、不 seed ON；`vendorLinkOn(false, flags) === false`（fail-closed）＝今日。本項**不新增任何使用者可見行為**（既有 `/v/[token]` 逐欄位不變），故不需新 gate。
- 可觀察：已登入 staff／tenant／owner 開有效、未結案 `/v/[token]`——看到的頁面（`vendorLinkSafeView` 投影、可寫／唯讀）與 PROP-01b **逐畫面不可區分**；**無自動歸戶、無 redirect、DB 無歸戶關聯列**；未登入造訪與今日相同；staff／portal `getSession()` 回傳 `Session` **完全未碰**（僅被讀取 `userId`）。

## 端到端 tracer bullet

最小可行、**走 vendor token 面＋已登入消費端**的一條路徑（本 SHA 後）：

1. **已登入** 使用者（持 `SESSION_COOKIE`，`getSession()` 回出正常 `Session`，`kind∈{staff,tenant,owner}`）造訪 `/v/<token>`（或 LINE 登入後導回此 token）。
2. loader／route：**既有閘原位不動**——`VENDOR_LINK_ENABLED` kill switch ＋ `vendorLinkOn(killSwitch, featureFlags)`（fail-closed；今日 `false`）。
3. loader 呼 **PROP-01b 入口**（不改）：`resolveVendorIdentity(sql, { token, now, linkedUserId: null })` → 取 `VendorIdentityResolution`（含 `jobId`／`orgId`／`ticketId`／`capability`／`tokenHash`／`linkable`）。*（以 `linkedUserId:null` 評估候選性，`linkable` 即「此解析*可被*歸戶」。）*
4. **新：** loader 取 `gateOn = vendorLinkOn(VENDOR_LINK_ENABLED, featureFlags)`（今日 `false`）與 `session.userId`，呼叫**單一歸戶推導入口** `planVendorAttribution(resolution, session.userId, now, gateOn, source)`：
   - `gateOn === false` → 回 `{ status:"gated" }`（＝今日；**不寫、不 redirect**）；
   - `resolution === null` ／ `resolution.linkable === false` → `{ status:"not_linkable" }`；
   - `session.userId == null` → `{ status:"no_user" }`；
   - 皆通過 → `{ status:"attributable", record }`，`record` ＝由 `resolution`＋`userId`＋`now`＋`source` **純推導**出的 `VendorAttributionRecord`（**不寫入**）。
5. loader 以 plan 決定動作：本 SHA 因 `gateOn=false` 恆為 `gated` → **沿用 PROP-01b 的顯示路徑**（`vendorLinkSafeView` 投影、可寫／唯讀、null/invalid 分支原位原行為），**不做任何歸戶寫入、不 redirect 到 login-home**。
6. **可觀察結果**：有效、未結案 token 的頁面與 PROP-01b 不可區分；**無自動接續、無 login-home 落點、DB 查無歸戶關聯新列**；三情境共存 token 各自解析各自案件，互不污染（PROP-01b 第 7 條，本項不破壞）。
7. **V-13 放行基礎（inert，本 SHA 不觸發）**：`planVendorAttribution` 的 `attributable` 分支與 `plan.record` 是 V-13 歸戶寫入的唯一消費點；本 SHA 不提供任何 commit／persist 函式。

> 本 B 項不需拆多條對外狀態；BUILD-ORDER 單一狀態欄位維持一項（build-only / flag-OFF）。

## Caller-first 介面

**呼叫端（未來的 V-13 放行、以及本 SHA 的 loader）怎麼用（先）**：

- **loader（本 SHA）**：`getSession()`（PROP-01a）取 `userId` → `resolveVendorIdentity`（PROP-01b）取 resolution → `vendorLinkOn`（既有）取 `gateOn` → `planVendorAttribution(...)` 取 plan。因 `gateOn=false`，plan 恆 `gated`，loader 行為與 PROP-01b 相同。
- **V-13（未來消費端）**：當硬閘放行、`gateOn=true` 時，消費 `plan.status==="attributable"` 的 `plan.record` 落實**持久化寫入＋誤歸戶可追溯紀錄＋login-home 落點**——寫入／redirect／冪等／supersede 皆由 V-13 施作，**不在本入口內**（本入口純推導、零寫入）。
- **摩擦訊號檢核**：若 V-13 發現必須繞過此入口自行查 `repair_vendor_*` 或自行重算 `linkable`／capability 才能歸戶，視為契約欄位不足的訊號——回頭補 `VendorAttributionRecord`／`VendorAttributionPlan` 的欄位或 `source` 推導，而非讓消費端繞彎重算 PROP-01b 已定之語義。

**關鍵邊界：歸戶 ≠ vendor Session。** 被歸戶者是**已登入使用者的真實 `Session`**（staff／tenant／owner，來自 `getSession()`）；vendor token **不**因歸戶變成登入身分、**不**擴 `Session.kind` 為 "vendor"、**不**觸 `org_members`、**不**產生 membership。歸戶紀錄只是「vendor 案件 ↔ 既有登入 user」的一筆**連結資料**，不授予任何一方對另一方 org 的存取。

**反推簽章（proposed；函式／模組名 待核，標記為新建）**：

```ts
// 新檔 src/server/vendor-attribution.ts（路徑待核）
import type { VendorIdentityResolution } from "./vendor-identity";
import type { VendorLinkCapability } from "./vendor-link-rules";

/** 三情境 token 來源（審計用；僅標示此次歸戶出自哪一張共存 token，不改變解析）。 */
export type VendorAttributionSource =
  | "first_temp"          // 首次／臨時
  | "emergency"           // 緊急
  | "existing_open_job";  // 既有未結案舊連結

/** 可持久化的歸戶紀錄形狀（durable record shape）。本 SHA 只「推導」不「寫入」。
 *  誤歸戶可追溯：以 (tokenHash, jobId, attributedUserId) 唯一定位；forward-only，
 *  反轉／supersede 由 V-13 落實階段追加（本 SHA 預留語義、不寫、不建表預設）。 */
export type VendorAttributionRecord = {
  jobId: string;
  orgId: string;
  ticketId: string;
  /** 驅動此次歸戶的那一張 token（三情境共存時絕不跨張）。來自 resolution.tokenHash。 */
  tokenHash: string;
  /** 被歸戶的登入使用者（來自 getSession()／resolveIdentity 的 userId；非 vendor Session）。 */
  attributedUserId: string;
  attributedAt: Date;
  /** 歸戶當下的 token 效力快照（誤歸戶追溯用；直接取 resolution.capability，不重算）。 */
  capabilityAtWrite: VendorLinkCapability;
  /** 歸戶當下 linkable 判定快照（直接取 resolution.linkable，不重算）。 */
  linkableAtWrite: boolean;
  source: VendorAttributionSource;
};

export type VendorAttributionPlan =
  | { status: "attributable"; record: VendorAttributionRecord } // 可歸戶：V-13 消費 record
  | { status: "gated" }         // V-12＋V-13 閘未開（vendorLinkOn=false）＝今日
  | { status: "not_linkable" }  // resolution 為 null 或 linkable=false
  | { status: "no_user" };      // 無登入 userId 可歸

/** 單一歸戶推導入口（write-path stub）：由既有解析＋登入 userId 推導「會寫入什麼」，
 *  但 **永不寫入**（本模組無任何 INSERT／UPDATE）。fail-closed：gateOn 預設來源為
 *  vendorLinkOn(VENDOR_LINK_ENABLED, flags)，今日 === false → 恆 "gated"。
 *  不呼 resolveVendorIdentity、不 hash、不重算 capability/linkable、不回傳 Session。 */
export function planVendorAttribution(
  resolution: VendorIdentityResolution | null,
  linkedUserId: string | null,
  now: Date,
  gateOn: boolean,
  source: VendorAttributionSource,
): VendorAttributionPlan;
```

- **閘不進 planner 做 I/O**：`gateOn` 由呼叫端以既有 `vendorLinkOn(...)` 算好傳入（與 PROP-01b 把 kill switch／flag gate 留在 loader 的切法一致）；planner 只做純函式判定，避免被誤用時旁生寫入或 gate 位移。
- **無 commit/persist 函式**：本 SHA 刻意**不**提供任何 `commitVendorAttribution`／`persist*`。write-path「stub」＝「可被推導、但尚無寫入實作」的路徑；寫入實作＝V-13。

## 資料表與 RLS

- **預設：無新增／變更資料表、欄位、索引、RLS policy、migration。** 本 SHA 純建立歸戶**推導**入口＋歸戶**紀錄形狀（型別）**；`VendorAttributionRecord` 只是 TypeScript 契約，不落地。
- 讀取的既有表：**無新增讀取**。本入口不自行查 DB——其輸入 `resolution` 已由 PROP-01b 的 `resolveVendorIdentity`（查 `repair_vendor_secrets`／`repair_vendor_jobs`／`maintenance_tickets`）提供；本模組**不重查、不 hash、不 JOIN**。
- **歸戶紀錄表（寫入路徑）＝ V-13**：「vendor 案件 ↔ 登入 user」連結＋誤歸戶可追溯紀錄的**實際落地與寫入**屬 V-13，本 SHA 不實作、不建表、不寫入。
  - **§資料表 fallback（若 Class B 審查判定「基礎無此表則 V-13 無法安全接」而不可避免）**：限**一張 additive、forward-only、re-runnable** 的表（例 `vendor_job_attributions`：`job_id`／`org_id`／`ticket_id`／`token_hash`／`attributed_user_id`／`attributed_at`／`capability_at_write`／`linkable_at_write`／`source`／`superseded_by`(nullable，forward-only 反轉指標)／`created_at`），**RLS org-scoped**（`org_id` policy），**grants fail-closed**（預設 `REVOKE ALL`、顯式授予最小、本 SHA 因無寫入路徑故不授任何 role 寫權），**不 seed、不開任何 flag ON**；本 SHA 仍**零寫入**（只建結構供 V-13 用）。**此選項列為開放問題，預設不採**（與 PROP-01b §資料表 fallback 一致）。

## Flag

- **不新增 flag、reuse registry**（BO row：`— (no new flag; reuse registry)`）。V-12／V-13 的硬閘 wiring **reuse 既有** `VENDOR_LINK_ENABLED` kill switch ＋ `vendorLinkOn(killSwitch, featureFlags)`（`vendor_link` flag）：`killSwitch !== true` 或 flag 非 `true`/"true" → `false`（fail-closed）。今日 `VENDOR_LINK_ENABLED=false` → `vendorLinkOn` 恆 `false` → `planVendorAttribution` 恆 `gated`。
- 本項為「歸戶推導入口化＋紀錄形狀＋inert 閘 wiring」，**無新使用者可見行為** → **不需新 gate**；flag OFF ＝今日。
- V-13 日後引入自動接續／login-home 的使用者可見變更時，須走既有 Mode B 判定式（arch §5：平台 `enabled` ∧ allowlist ∧ org override，缺一即 OFF）、default OFF——但那屬 V-13，不在本 note。**本 SHA 不翻任何閘 ON、不 seed flag。**

## 錢／權限風險（Class B 判定）

**判定：Class B（跨 org／跨案件隔離＋誤歸戶 risk）。** 歸戶是「把一個 vendor 案件接到某個登入身分」的決定點；推導錯＝未來（V-13 放行時）誤歸戶（案件接到錯的人）或跨 org／跨案件外洩。**本 SHA 不得產生任何寫入，且不得改變 PROP-01b 任何解析結果。** 審查須逐條檢視：

1. **零寫入（最高風險）**：`planVendorAttribution` 及整個 `vendor-attribution.ts` **不得**有任何 INSERT／UPDATE／DELETE，不得呼叫任何寫入 helper。審查確認本模組為純函式、無 `sql` 寫入、無副作用；DB 查驗任何呼叫後皆無歸戶關聯新列。
2. **閘 fail-closed、不位移**：`gateOn` 一律由既有 `vendorLinkOn(VENDOR_LINK_ENABLED, flags)` 提供；今日恆 `false` → plan 恆 `gated`。審查確認 planner 無「繞過閘」的分支、無預設 `gateOn=true`、呼叫端未 hard-code `true`。
3. **誤歸戶可追溯（紀錄形狀完整）**：`VendorAttributionRecord` 必須攜足以追溯／反轉的欄位——`tokenHash`（哪張 token）＋`jobId`／`ticketId`／`orgId`＋`attributedUserId`＋`attributedAt`＋`capabilityAtWrite`／`linkableAtWrite` 快照＋`source`；fallback 表另含 `superseded_by`（forward-only 反轉）。審查確認形狀足以在 V-13 寫入後唯一定位並反轉一筆誤歸戶。
4. **三情境 token 共存不交叉污染**：首次／臨時、緊急、既有未結案舊連結可同案多張 token（PROP-01b 第 7 條）；每次 plan 只引用**傳入那一個 `resolution`** 的 `tokenHash`／`jobId`，`source` 僅標示該張來源，**絕不**合併或引用另一張共存 token 的 hash／job。審查以同案多 resolution fixture 驗 plan 互不污染。
5. **linkable／capability／hash 不被重算、不被放寬**：本入口**消費** PROP-01b 的 `resolution.linkable`／`resolution.capability`／`resolution.tokenHash`，**不得**重新 hash、不得重判 capability、不得自造「更寬」的 linkable。`linkableAtWrite`／`capabilityAtWrite` 直接拷貝 resolution 欄位。審查確認無任何重算路徑。
6. **不成 vendor Session、不擴 `Session.kind`**：`attributedUserId` 取自既有 `getSession()` 的登入 user；歸戶**不**把 vendor token 變成登入身分、**不**觸 `org_members`、**不**產生 membership、**不**回傳 `Session`。審查確認本模組未呼 `resolveIdentity`／未讀 `org_members`／未改 `types.ts` 的 `Session.kind`。
7. **跨 org 不授權**：登入 user 的 org 可能異於 `resolution.orgId`；歸戶只是「連結」一筆資料，**不**授予該 user 對 vendor 案件 org 的任何存取、**不**授予 vendor 對 user org 的任何存取（授權仍走各自既有 RLS／`assertPerm`）。審查確認 plan／record 不產生任何授權提升。
8. **`not_linkable`／`gated`／`no_user` 區分**：`resolution==null`／`linkable=false` → `not_linkable`；閘關 → `gated`；無 userId → `no_user`。三者不得混淆或反轉（例如把 `gated` 誤判為 `attributable`）。審查以矩陣 fixture 對照。
9. **冪等／重複歸戶（防線，V-13 實作但本 SHA 預留）**：同一案件已被歸戶後再次 plan，本 SHA 仍純推導（不寫故無重複落地）；V-13 寫入時須以 `(tokenHash, jobId, attributedUserId)` 冪等＋`superseded_by` 反轉。審查確認紀錄形狀已預留此語義。

**金額／付款對象／租約效力**：本入口不直接涉及金流；但歸戶後 vendor 案件可能牽動修繕費用與負擔方（L1-RPR／FR-P0-01/03/05 下游），故列 Class B，不改既有 vendor 可見／可寫邊界、不提前放行任何寫入。

## HITL／AFK

- **AFK（agent 可自行完成）**：純函式 `planVendorAttribution`＋型別＋table-driven 單測＋`/v/[token]` characterization（行為保持、zero-write 自動驗）。
- **HITL（人工定稿／簽核）**：
  - **契約形狀**（`VendorAttributionRecord` 欄位、`VendorAttributionSource` 列舉、`VendorAttributionPlan` 狀態、是否擴 `Session.kind`）——本文件定稿為「**不**擴 `Session.kind`、歸戶綁既有登入 `Session`」，待開放問題回填即轉 AFK。
  - **是否建歸戶表**（§資料表 fallback）＝人工判定；預設不採，採則需 CEO／Ron 核（forward-only＋grants fail-closed＋不 seed／不開 flag／零寫入）。
  - **`source` 三情境可否由既有欄位推導**（開放問題 3）＝Ron／PROP-01b owner 判定；不可推導則 `source` 延後至 V-13。
  - **Class B 獨立審查強制**（PRINCIPLES 37）：合併前須有獨立審閱逐條走完上節 1–9（尤其第 1 零寫入、第 4 三情境不污染、第 6 不成 Session、第 7 跨 org 不授權），確認 PROP-01b `resolveVendorIdentity`／`vendor-link-rules.ts` 行為零位移。此標記不改變 BUILD-ORDER 的 B 項順序或分工。

## 驗證方式與可觀察證據

不寫「跑測試」，寫真實介面／真實輸入／可觀察狀態：

- **Table-driven 單測（核心證據）** `vendor-attribution.test.ts`：對 stack `ead2ae3`，以輸入矩陣——（`resolution`∈{null／`capability:"invalid"`／`read_only`＋`linkable:false`／`write`＋`linkable:true`／`write` 但 ticket closed→`linkable:false`}）×（`linkedUserId`∈{有／null}）×（`gateOn`∈{false（今日）／true}）×（`source`∈三情境）——驗 `planVendorAttribution` 回傳：
  - `gateOn=false` → **恆 `gated`**（今日 invariant，最重要）；
  - `linkable=false`／`resolution=null` → `not_linkable`；`linkedUserId=null` → `no_user`；
  - `gateOn=true` ∧ `linkable=true` ∧ 有 user → `attributable`，且 `record` 逐欄位 == 由 resolution／userId／now／source **純拷貝推導**（`tokenHash`／`capabilityAtWrite`／`linkableAtWrite` 直接等於 resolution 對應欄位）；
  - **零寫入**：任何呼叫後，mock `sql` 無任何 INSERT／UPDATE 被呼叫（第 1 條）；
  - **三情境不污染**：同案多 resolution（各自 `tokenHash`）分別 plan，`record.tokenHash` 各自對應、絕不交叉（第 4 條）。
- **真實畫面走查（staging）**：
  - 已登入 user 開有效、未結案 `/v/[token]`：頁面與 PROP-01b baseline **逐畫面不可區分**（`vendorLinkSafeView`、可寫／唯讀）；**無自動接續、無 login-home redirect**；
  - 撤銷／過期／不存在 token → 行為與 PROP-01b 相同（過期訊息／404）；
  - gate OFF（`VENDOR_LINK_ENABLED=false`）→ 與今日同樣無歸戶、無存取變化。
- **DB 證據**：上述走查後，查歸戶關聯（若未建表則查任何 vendor↔user／vendor↔job 關聯）**無新列**；確認 build-only／flag-OFF 下 FR-P0-04 歸戶**未發生**。
- **feature map（如何走到／如何驅動／什麼可觀察）**：使用者＝已登入持 token URL 開 `/v/[token]`；agent 驅動＝以 fixture `resolution`＋`userId`＋`gateOn` 直接呼 `planVendorAttribution`；可觀察狀態＝回傳 plan 狀態與（若 attributable）推導 record 欄位，且**無任何歸戶關聯被寫入**、頁面與 baseline 不可區分。
- **回歸閘**：PROP-01b `vendor-identity.test.ts`（`resolveVendorIdentity`／`linkable`）綠且**未修改**；`vendorLinkCapability`／`vendorLinkOn`／`vendorLinkSafeView` 測試綠；PROP-01a `identity.test.ts`、`perms.test.ts`、`session-identity.integration.test.ts` **不受影響**（本項不碰該路徑，僅讀 `getSession()` 的 `userId`）。

## 不做什麼

- **不實作自動接續未結案的實際寫入／login-home 落點／redirect**＝ V-13 實際放行階段。本 SHA 只推導 plan／record，**零寫入、零 redirect**。
- **不翻任何閘 ON、不放行 V-12＋V-13 硬閘**；只給 inert wiring（閘 OFF→`gated`）。
- **不建歸戶紀錄表、不寫誤歸戶追溯紀錄**（預設不建表，見 §資料表 fallback；寫入屬 V-13）。
- **不重算 PROP-01b 語義**：不重 hash token、不重判 `vendorLinkCapability`、不重算 `linkable`、不改 `resolveVendorIdentity` 的 SQL／JOIN／回傳；本項只**讀** resolution。
- **不擴 `Session.kind` 為 "vendor"**（會波及 `perms`／nav／`assertStaff`）；歸戶綁既有登入 `Session`，vendor 不成 `Session`、不觸 `org_members`、不產生 membership。
- **不做 vendor 帳號註冊／登入流程**（signup、`signInWithLine` vendor 分支）；不碰 `auth.ts`。
- **不改 `vendor-identity.ts`／`vendor-link-rules.ts` 任何行為**（僅呼叫 `vendorLinkOn` 取閘、讀 `VendorIdentityResolution`）。
- **不做 B-026 vendor 可見 UI**；只給其後端歸戶契約。
- **不新增 migration／flag／RLS**（除 §資料表 fallback 且經核：forward-only＋grants fail-closed＋不 seed＋零寫入）；**不 seed flag ON、不 merge main（待 CEO GO）**、不動 PROP-MF／BO 排序、不碰 messaging。
- **不發明不存在的表／flag／函式名**；新建函式名／模組路徑標 **待核**。

## 開放問題（可非同步填答）

1. **單一入口命名**：`planVendorAttribution` / `VendorAttributionRecord` / `VendorAttributionPlan` / `VendorAttributionSource` / 新檔 `src/server/vendor-attribution.ts` 可否定案？（Ron／CEO）
2. **是否建歸戶表（§資料表 fallback）**：V-13 能否以「無表、只消費 plan＋record 形狀」起步，歸戶表留 V-13 自建？若必須在本 SHA 先建 additive 表，確認 forward-only＋grants fail-closed＋不 seed／不開 flag＋**零寫入**？（Ron／CEO）——**預設不建表。**
3. **`source` 三情境推導**：首次／臨時、緊急、既有未結案舊連結可否由既有 `repair_vendor_secrets`／`repair_vendor_jobs` 欄位推導？若不可，`source` 延後至 V-13、本 SHA 由呼叫端顯式傳入或先不帶？（Ron／PROP-01b owner）
4. **`linkable` 語義是否足夠**：PROP-01b 的 `linkable`（`capability≠invalid` ∧ ticket 非 closed/cancelled ∧ `linkedUserId===null`）是否足供歸戶候選判斷？是否需另一不寫入的「可歸戶候選」衍生欄位，或需區分「已被他人歸戶」vs「尚未歸戶」？（Ron／PROP-01b owner）
5. **write-path stub 形狀**：維持**純 planner、無 commit 函式**（預設，寫入全留 V-13），或需一個顯式 `commitVendorAttribution(...)` inert stub（flags OFF 時 no-op／throw NotImplemented）以固化介面？建議前者。（PE／Ron）
6. **`/v/[token]` 是否即時 wire**：本 SHA 行為保持地在 loader 加 `planVendorAttribution`（恆 `gated`、取 characterization 證據），或先只新增入口供 V-13／測試、loader 暫不動？建議前者（與 PROP-01b rewire loader 一致）。（PE／Ron）
7. **「不新增 flag／不擴 Session」確認**：reuse `vendorLinkOn`、`VENDOR_LINK_ENABLED` 續 `false`、歸戶不成 vendor Session、不擴 `Session.kind`——確認？（CEO per arch §5；Ron）
8. **B 項連結**：PROP-10 ↔ `B-026`（及連 `B-024`／`B-031`／`B-035`）的「待核」連結是否確認？（Ron）

---
來源：10-product/step4-architecture/architecture-v0.md §8（L1-VEN、V-12＋V-13 共同通過硬閘、三身分面、`/v/[token]` 登入歸戶 absent、歸戶紀錄含誤歸戶可追溯 L84）；build-order-proposal-v0 §4.3／§4.5（邊界、Wave B 硬閘）；replan §3.2／§5、step3 §3A.4（三情境 token 共存／歸戶）；vendor-id §2／§4；code：`vendor-identity.ts`（`resolveVendorIdentity`／`linkable`）、`vendor-link-rules.ts`（`vendorLinkOn`／`VENDOR_LINK_ENABLED`）、`types.ts`（`Session`）、PROP-01b-design.md（平行解析入口範式）、PROP-01a-design.md（單一入口範式）。用詞以 /GLOSSARY.md 為準。

## Implementation checklist for Codex

- **新建 `src/server/vendor-attribution.ts`（路徑待核）**：`VendorAttributionSource`、`VendorAttributionRecord`、`VendorAttributionPlan` 型別；`planVendorAttribution(resolution, linkedUserId, now, gateOn, source)`——純函式；`gateOn=false`→`gated`；`resolution==null`／`linkable=false`→`not_linkable`；`linkedUserId==null`→`no_user`；皆通過→`{status:"attributable", record}`，`record` 由 resolution／userId／now／source **純拷貝推導**（`tokenHash`／`capabilityAtWrite`／`linkableAtWrite` 直接取 resolution 欄位）。**零 DB 存取、零寫入、不 hash、不重算 capability/linkable、不回傳 Session。**
- **消費 PROP-01b**：輸入為 `resolveVendorIdentity(...)` 回傳的 `VendorIdentityResolution`；**不**改 `vendor-identity.ts`、不重算其語義。
- **改 `/v/[token]` route／loader**（若採開放問題 6 前者）：`getSession()` 取 `userId` → `resolveVendorIdentity(sql, {token, now, linkedUserId:null})` → `gateOn = vendorLinkOn(VENDOR_LINK_ENABLED, featureFlags)` → `planVendorAttribution(...)`；因 `gateOn=false` 恆 `gated`，**保留** PROP-01b 的 `VENDOR_LINK_ENABLED`／`vendorLinkOn` gate、`vendorLinkSafeView` 投影、null/invalid/命中分支原位原行為；**不 redirect、不寫入**。
- **不動**：`vendor-identity.ts`、`vendor-link-rules.ts`（僅呼叫 `vendorLinkOn`）、`session.ts`／`identity.ts`（PROP-01a；僅讀 `userId`）、`org-scope.ts`、`portal-role.ts`、`perms.ts`、`middleware.ts`、`types.ts`（**不擴 `Session.kind`**）、`auth.ts`。
- **零歸戶寫入**：本模組不得有任何 INSERT／UPDATE／DELETE、不得呼任何寫入 helper；不提供 commit/persist 函式（寫入＝V-13）。
- **無 migration、無新 flag、無新 flag seed、無 RLS 變更**（除 §資料表 fallback 且經核：forward-only＋grants fail-closed＋不 seed＋零寫入）。
- **新單測 `vendor-attribution.test.ts`**：table-driven 覆蓋 §驗證矩陣——`gateOn=false` 恆 `gated`、`not_linkable`／`no_user`／`attributable` 區分、record 逐欄位純拷貝、**零寫入（mock sql 無 INSERT/UPDATE）**、三情境 token 共存 `record.tokenHash` 不交叉、**不回傳 `Session`／不觸 `org_members`**。
- **回歸**：PROP-01b `vendor-identity.test.ts` 綠且未改；`vendorLinkCapability`／`vendorLinkOn`／`vendorLinkSafeView` 綠；PROP-01a `identity.test.ts`、`perms.test.ts`、`session-identity.integration.test.ts` 不受影響。
- **建議補** `/v/[token]` pre/post characterization 比對（fixture → 頁面投影／分支與 PROP-01b baseline 逐欄位相等，且 DB 無歸戶新列）。
- **合併前**：Class B 獨立審查逐條走 §錢／權限風險 1–9（重點 1 零寫入、4 三情境不污染、6 不成 Session／不擴 `Session.kind`、7 跨 org 不授權、5 不重算 PROP-01b 語義）；證據走 vendor token 面＋已登入消費端、不改 `getSession()` 行為；staging 部署於 `ead2ae3`＋QA packet；**flags OFF、不翻閘 ON、不 merge main（待 CEO GO）**。

## ON-blockers (QA r2, 2026-11-05) — build-only done @ `c3f7fab`
- V-12/V-13 Wave B hard gate stays ON-blocking.
- Move `planVendorAttribution` after the post-state capability check, before any live attribution INSERT.

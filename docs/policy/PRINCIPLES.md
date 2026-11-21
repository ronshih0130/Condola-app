# Condola 核心原則（Ron 與 CEO 討論定案，持續累積；各 bot 每回合跟 RULES.md 一起讀）
最後更新：2026-11-12 19:10（每晚反思：新增 63 官網小狀態快速迭代、64 Repo 一律 private、65 Mac mini 雙軌分工）

## 發布與 flag
1. 大功能先以 flag 關閉的狀態上 prod（dark launch）；低風險修正可以直接上線並開啟。（10/27）
2. 三階段推進：internal（測試組織）→ ea（early access，設計夥伴）→ ga（全用戶）。每推進一階都要 CEO GO；涉及法律或付費的功能，推到 GA 前要給 Ron 看。（10/27）
3. 可以針對單一組織 override 強制開或關；每個 flag 都要有全域一鍵關閉。（10/27）
4. 測試組織在 prod 預設開所有功能，不再加額外限制。測試組織名單由 CEO 核准。（10/27）
5. flag 衛生：flag 集中登記，寫清楚負責人和到期日。發布用的 flag 在 GA 穩定 14 天後，連同舊程式一起刪掉。過期 flag 先由 CI 警告，過期超過 7 天才讓 CI 失敗。長期 kill switch 每季檢查一次。（10/27）
15. 組織 override 由 CEO 核准並寫入 audit_log；設計夥伴的 override 預設 30 天、可續期。任何人都能緊急關閉，解除關閉要 QA 確認原因、CEO 核准。（10/27）

## 上線品質
6. 衝刺期（到 11/9 design partner 開始前，Ron 10/27 12:20）：改用 release train。PE 維護一條疊在 prod 上的整合分支，QA 簽核過的項目合進去一次，不用每件重新 rebase。準備好就發車，不等發布窗口，也沒有每天的批次上限。每次發車的合併 sha 都要完整 CI、test:rls、Codex delta review 和 QA 重新簽核，再加 CEO GO 和 T+0/T+15。某一項沒過就拿掉、重簽後照樣發車。有 migration 的項目要證明舊程式能跑在新 schema 上，不然單獨發車。部署時 flag 預設 OFF；Class B flag 打開前要有 QA 一行確認，打開後跑 T+0/T+15，回滾就是關 flag。原因不明就是 NO-GO，先回滾；DB 採 fix-forward。（10/26，10/27 修訂）
7. gate 以直接 HTTP 探測為準：版本、登入、主要頁面 200、0 個 5xx，失敗就回滾一次。Cloudflare 日誌類檢查（Observability、tail、R2 Logpush、掃描）只記錄、不擋發布，日誌問題卡住的發布直接推 prod；flag 預設 OFF、不寫 prod DB 的條件不變。（10/27，Ron 10/28 18:46 修訂）
8. prod 測試由外部 LLM 撰寫並執行，產出 verdict；bot 只負責判讀和決策。（10/26）
16. 會刪資料的功能（例如清除排程）先以 flag 關閉上線；開啟前要 QA 核准，第一次只跑 dry-run 計數、符合預期才真刪。退回不支援該 flag 的舊版時，要一併停掉 scheduler 和 runner，只關 flag 不夠。（10/27）

## 資料、AI 與法遵
9. 真實客戶資料、正式環境資料、證件照片（身分證、居留證、護照、駕照）、身分證號、銀行帳號、密碼和金鑰都可以經 llm-route 送外部 LLM，不遮罩、不擋（Ron 10/27 15:14、15:25）；未經 Ron 同意不得恢復過濾。密鑰仍不得貼進群組、DM 或任何聊天訊息。隱私權政策以概括方式揭露「委託第三方 AI 處理」，不用逐項列細節（Ron 10/27 15:28）。
10. 敏感資料採最小權限，例如會計看不到工單照片。（10/26）
11. 電子簽約：盡到驗證責任即可，不等更細的法規。公證和身分驗證失敗都改走手動上傳租約。審閱期本身保留；審閱期內的撤銷由租客和管理方直接溝通，租客端產品不另外明說。（10/27）
12. 開源授權：LGPL 套件不修改、獨立載入，並附上聲明，就可以繼續使用。（10/27）
17. 證件照保存鎖定 90 天：已成立的租約從租約結束日起算，無固定期限的租約從實際終止或搬離日起算（租約進行中不倒數），未成立、取消或作廢的從上傳日起算；公司不能自行調整。（10/27，10/28 修訂）
18. 我們自己保管的備份副本 14 天內清除；託管平台內部備份依供應商機制；交給第三方 AI 處理的資料依各供應商的保存政策。（10/27）
19. 設計夥伴開始使用前，onboarding 要讓他們看到並同意最新的隱私權政策和合約；同意紀錄只增不改，保存文件版本和全文雜湊。（10/27）

## 協作
13. 回報 Ron 之前，先查最新的 verdict 和 status，不用記憶中的舊狀態回答。（10/27）
14. 只有 Ron 能決定的事才找 Ron（法律立場、商業取捨、帳號金鑰）；其他由 CEO 直接決定。（10/27）
20. 排優先順序以 /workspace/ops/ROADMAP.md 為準（P1 四大 app 與設計夥伴 → P2 用量定價與 UX → P3 全球化 → P4 用戶端 AI）；新功能預留用量計量，不把台灣寫死。（10/27）
21. 雙軌開發：GitHub `ronshih0130/Condola-app` 是唯一真實來源（Ron 11/03，取代 10/27 Origin 規定）；cut-over 完成前，Origin 分支 `mode-b-repair-override-prep` 為最新，cut-over 後 Origin 唯讀；Ron 的 Mac 平常只推 staging，正式發布照常走 QA、CEO GO 和 T+0/T+15。（10/27）
22. 驗證證據保留 1 週，暫不搬 R2；容量不足時由 Ron 核准縮減。清理時不刪 verdict、status、issue、進行中項目和程式產出。（10/27）
23. llm-route 一般任務用各 CLI 預設模型，只有任務明確指定強／中／弱時才指定；Codex 額度不是上線限制，快用完時由 CEO 請 Ron 重置。（10/27）
24. 產品文案「租客」「房客」都可以用。（10/27）
25. 產品策略與決策集中在 /workspace/condola-hub/（INDEX.md 為入口，決策記在 11-decisions/DECISIONS.md）；hub 是私有 GitHub repo，每晚 23:00 推 GitHub 後同步到 Google Drive「Condola Hub」資料夾，同名檔直接覆蓋、不留舊版，機密一律排除。（10/28，Ron 10/29 17:50 修訂）
26. 文案修改跟功能一起批次上線，不單獨發。（10/28）
27. 品牌 v2 和網站文案以使命宣言為核心：「當房東不該這麼累。」（condola-hub/01-mission/mission-v0.1.md）。（10/28）
28. Box 不穩時發版：途中 box 斷線或卡住即暫停；恢復後先直接探測 /api/version 與主要頁面確認線上實際版本，再決定繼續或回滾，不憑推測續推。（Ron 10/28 21:18）
29. 卡點靈活調度（Ron 10/28 21:44 檢討）：同一問題失敗 2 次即換路（降級為參考、換驗證法或繞過），禁止第 3 次原樣重試；只有真實用戶傷害（5xx、版本錯、資料錯）擋發版，證據管道問題只記錄；任何卡點超過 1 小時無進展，CEO 主動裁決；先判斷是否我方問題，外部平台限制直接繞開；每晚反思統計重試輪數，同件事超過 3 輪標紅。
29a. 外部平台若屬暫時性問題：標記 PENDING，間隔至少數小時再重試一次（最多 2 次），期間其他工作照推、不阻塞；仍失敗即依 29 換路或降級。禁止連續 loop 重試。（Ron 10/28 21:45）
30. LINE 存取是 MVP 必備：租客、廠商、屋主都要能經 LINE 使用 Condola，與四大 app 同列優先。（Ron 10/29 14:51）
31. 官網文案以用戶為中心；搜尋結果／網址列標題用「租多啦｜房屋出租的萬事通」，「當房東不該這麼累。」只用在內文和頁面標題。（Ron 10/29 14:22）
32. prod 可以直接建立測試帳號，但一定要帶正確的內部測試標記，不用另經 CEO 核准。（Ron 10/29 11:55）
33. prod 上 flag OFF 的功能，各自通過 QA 驗收就各自打開，不等發布窗口、不湊批次。（Ron 10/29）
34. Mode B 資料庫：Mac 上的 Codex 一律不跑 DB migration，只寫 handoff 檔；PE 從 box 套用到 staging（永不碰 prod），套用前先查現有 schema 與 migration 歷史，計畫與結果寫進 condola-hub/20-build/staging-db-plan.md。（Ron 10/30）
35. Mode B 開發不等人：Codex 依 BUILD-ORDER.md 順序連續做 B 項，每項跑完整 gate、push 並回報 SHA；卡住的寫進 BLOCKED.md 後跳過；DB 部分交 PE、非 DB 部分照做；不上 prod、不合併 main、flag 維持 OFF。（Ron 10/30）
36. 設計夥伴啟動看範圍不看日期：須同時滿足 Wave A 開放判定（Q3 B∧C 且 D＝A∧B）、Wave B 硬閘（V-12＋V-13 共同通過）、B-001–B-005，以及租客、廠商、屋主三端 LINE 的 B-033–B-039 全部完成（含 B-037–039 推播）。開發照 hub main 的 BUILD-ORDER v2（52 項，35484f3）範圍和順序逐項做，順序變更只能由 CEO／Ron 提案核准；每項 Claude 寫細設計 → llm-route 寫碼 → 依序上 staging → QA diff-only，全部上 staging 後一次演練、批次上 prod（flag OFF，CEO GO）。（Ron 11/02 00:28，11/03 14:31 修訂；11/05 01:59 採用 BUILD-ORDER v2 並加 B-037–039 為啟動條件）
37. 每個 B 項分工：Claude（llm-route）開工前寫簡短設計說明，DB／金流變更做 Class B 審查；Codex 依 BUILD-ORDER 和設計說明實作、跑完整 gate、每項回報 SHA；PE 套 staging；QA 由外部模型經 llm-route 寫測試、跑測試、出 verdict，QA 只核對；高風險項（金流、權限、租約、DB）另由 Claude 做第二次獨立審查，但自己寫設計說明的項目改由別的模型驗收；CEO 決定 GO/NO-GO。（Ron 11/03 14:44）
38. QA 發現的低優先事項，只要不阻塞核心 MVP 上線，就記進 /workspace/condola-hub/20-build/LOW-PRIORITY-QUEUE.md（附 B 項、SHA、描述），不阻擋 GO，之後有空再一起處理；阻塞 MVP 的，以及金流、權限、資料外洩相關問題，照常擋。重點是讓核心能力的 MVP 上線。（Ron 11/04 01:29）
39. 減少 QA↔研發來回（Ron 11/04 01:48 檢討）：(a) 每項第一輪 QA 一次列完所有發現，之後各輪只能核對已列條件，不再加新條件，除非碰到金流、權限、外洩或資料遺失；(b) 文件和備註措辭不單獨出 FAIL，只標低優先，交給 PE 一起修，進 LOW-PRIORITY-QUEUE；(c) 只改文件、證據的 commit 不會讓 verdict 作廢，只有程式碼或 migration 變更才作廢；(d) 研發一次修完所有阻塞條件後才送下一輪，每項 QA 最多 2 輪，第 3 輪起交 CEO 裁決；(e) 同一項分 functional、notes、UI 證據多次審查的作法，合併成一次審查。
38a. 補充（Ron 11/04 02:17）：如果研發本來就在修某個核心阻塞項，順手把相關的低優先事項一起修掉沒問題。核心阻塞項要在第一輪一次評估到位，避免多輪循環一直冒出新條件。
40. 代碼開發也一律交給外部 LLM，用 llm-route 呼叫 Codex 或 Claude，不走 Cursor（cloud agent、Cursor 裡的 AI）。Grok Bot 只負責指揮、決策和核對，避免消耗共用的總額度。（Ron 11/04 12:24）
41. 批次發版（Ron 11/04 09:28）：Codex 做完的 B 項依序上 staging，只做 diff 驗收；全部上 staging 後跑一次全新 PG16 端到端彩排，CEO GO 後一次批次上 prod（flag OFF），取代逐項上 prod。
42. 雙軌並行（Ron 11/04）：Mac mini 上 Codex/Claude 本地開發與 Grok Bot 的線上 QA、發版同時進行，不互相暫停；靠分支隔離、claim.sh 鎖、只有 PE 碰 staging，同一 B 項不同時讓 Claude 和 Codex 改。規則寫在 20-build/AGENTS.md（CLAUDE.md 指向它）。
43. 分段合 main（Ron 11/05 08:56，為 token 效率）：QA diff-only 通過的項目每累積 3～5 項合進 main 一次，只跑 CI（unit、型別、build，不用 LLM、不跑 e2e），合併前 CEO 核對 CI 綠燈；main 不等於 prod，旗標維持 OFF。完整 e2e 只在全部上 staging 後、上 prod 前的 fresh PG17 演練跑一次；prod T+0/T+15 只做核心路徑精簡 smoke。上 prod 仍需 CEO GO。第一次分段合併前先把 GitHub main 補到 4aff923。
44. Step4 兩層架構：共用架構（資料模型、權限、前後端切分、跨 app 規則）一次做完；各能力的細設計由 Claude 只在該項開工時才寫，不提前批次寫完。（Ron 11/05 01:34）
45. 定期報告必含產品能力四項（Ron 11/05 19:39）：每晚反思報告與每週回顧一律列出（1）本區間開發的產品能力、（2）目前開放狀態（區分已對真實用戶開亮 vs 僅在 staging／main／prod 但 flag OFF）、（3）何時與滿足什麼條件會進一步開亮、（4）next step 要研發的產品能力；本質複雜工作不計入浪費（11/05 19:32）。
46. 開發一律以 GitHub 為準，不回 Cursor Origin；各 bot 的 PR、合併、CI 都走 GitHub，不要再切回 Origin。（Ron 11/08 確認；GitHub repo 11/08 10:14 起改為 public）
47. 本條取代 11/08「CI 只用 GitHub-hosted runner、不接 box／Mac self-hosted runner、不加購」的規定：CI 改到 Ron 的 Mac mini 上的自架 runner（self-hosted runner）；上線順序固定不可調換——先在 Mac mini 把自架 runner 架好，再與 GitHub-hosted CI 並行試跑（shadow），兩者結果一致後、經 CEO 對「確切 SHA」給 GO，才把必要檢查（required checks）切到 Mac mini，等 CEO 確認自架 runner 跑綠之後，最後一步才由 Ron 親自把 repo 轉為 private（轉 private 不得提前）；公開期間必須全部採取以下保護措施：自架 job 只跑 push 到 main 或 `workflow_dispatch`，絕不跑 pull_request、pull_request_target，也絕不跑 fork；若帳號支援 runner group 則使用只限本 repo 的 runner group 並加上專用 label（個人帳號的 repo 層級 runner 本身已只服務該一個 repo，runner group 屬組織功能、個人 repo 不一定有）；workflow 權限僅 `permissions: contents: read`；不注入任何密鑰（含 prod 密鑰）；資料庫只用合成資料（synthetic DB only）。必要檢查（required checks）的切換與 repo 可見性變更仍由 Ron 親自決定（切換必要檢查前仍須 CEO 對確切 SHA 另給 GO；轉 private 不得提前）；時程閘門為 workflow 的改動須等 RLS P0 修補已上 prod 且 T+15 通過之後才做；並行試跑的 PR、以及之後「切換必要檢查」，各自需要 CEO 對確切 SHA 另給一次 GO（兩次分開，不是一次）；既有 prod／flag 驗收 GO 門檻不變。（Ron 11/12 09:04、09:05、10:07；CEO 10:07 裁定可開始做；CEO 15:40 確認該例外並補上公開期間防護；時間皆為 PT）
48. Ron 的 4 個內部 org（理想／完美 live 與 sandbox）全是測試資料：旗標在 QA 0 阻塞、無真實外部副作用時可直接在 4 個 org 一起開，不必先限 sandbox；但對外部對象仍維持 0 真實發送，真實用戶上線的阻塞項照擋。（Ron 11/09 00:43）
49. 設計夥伴啟動不訂死日期：在 Ron 4 個內部 org 先跑；V-12＋V-13、B-001～005、LINE 推播 B-037～039 完成，且 Ron 親自通過 LINE 驗收後，才由 CEO 提新的啟動日期給 Ron 拍板。（Ron 11/09 09:59）
50. Human／User centric design 是公司 mission 之一，也是最重要的設計原則（Ron 11/09 23:03）。R&D 的工作從用戶體驗出發：每個頁面、按鈕、流程先講清楚目的與使用情境再設計，不盲目設計；先研究競爭對手和用戶體驗，以研究結果驅動設計；設計前用 grill-me 多輪反問 Ron，把框架講清楚。PE／Codex 實作時不得自行新增沒有用戶目的的頁面或按鈕。
51. 正式產品開發流程（Ron 11/10 14:40）：開發任何能力都必須照 10 步流程走，任何 bot 討論新能力時都要主動引導 Ron 跑過流程。1 問題與用戶（Persona、競品／UX 研究）→ 2 grill-me 釐清框架（決策紀錄）→ 3 User Journey／User Story＋驗收條件 → 4 Feature 規格與 BUILD-ORDER → 5 UX／UI 設計（每頁每按鈕寫目的並對應 story）→ 6 System Design＋非作者 QA 安全審查 → 7 實作（design note 先行、測試由驗收條件產生、不得新增無 story 的頁面／按鈕）→ 8 驗證（CI、換模型非作者 QA、staging 四角色 E2E）→ 9 上線（CEO exact GO、flag OFF、T+0／T+15、內部 org、rollback）→ 10 驗收與回饋。第 1、2、3 步原則上不得跳過；沒有 Persona、沒有 Ron 確認的決策紀錄、沒有 story 與驗收條件，就不進入設計或實作。每步用固定模板、有進出檢查清單，PR 與測試要能追溯到 story／Persona。正式文件：condola-hub/01-mission/dev-workflow.md（R&D 撰寫並維護模板）。
52. 前端變更必須有 mockup（Ron 11/10 15:04）：流程第 5 步的必要產出，Ron 審過才進第 7 步實作。新頁面／新流程：可點擊 mockup（Figma 或 staging 上的簡易 HTML prototype），含空白、載入、錯誤、成功各狀態與手機版；既有頁面修改：before／after 靜態 mockup，每個變動元素標註目的與 story ID；純文案或小樣式調整：標註截圖即可。
53. 品牌 v2 響應式規則（Ron 11/10 16:05）：內文 16px；手機用底部分頁＋「更多」；手機主要按鈕固定在底部；所有新頁面與 mockup 依 brand v2 tokens 與 390／768／1280 三種寬度設計。平板（768）先降優先，手機 390 與桌機 1280 為主（Ron 11/11 10:16）。
54. 空白狀態規則（Ron 11/10 17:48–17:51）：每個空白狀態＝插圖＋一句原因＋最多一個主要按鈕；搜尋／篩選無結果一律「清除搜尋」；沒有權限的角色不給無法執行的按鈕，改提示請管理員完成設定。
55. 用量額度與試用門檻由數據決定（Ron 11/10 18:04）：先用約 2 週實際用量＋單位成本建成本模型，R&D 提案各方案額度，Ron 拍板；未定前標「待定」，不先寫死。
56. 不可逆或對外的動作要 Ron 逐次原話同意（Ron 11/10 17:55–18:02）：永久刪除備份／資料、對外部用戶的 SMS／LINE／email 真實發送，都要 Ron 針對該次範圍明確同意；先前的同意不延伸到別的範圍（例如備份清除同意不涵蓋 ID_PURGE）。
57. 設計夥伴逐一加入（Ron 11/10 17:37）：本輪只開 4 個內部 org；三道閘門通過後，由 Ron 一個一個指定設計夥伴 org 加入，不批次開。
58. SMS 需要成本，僅限已核准用途（Ron 11/10 23:42，11/11 00:10 增列改號驗證，**11/11 08:32 Q12＝A 澄清註冊驗證範圍**，**11/11 10:01 建立流程 Q7 增列租客邀請**，**11/11 11:46 CEO 裁決第 4 用途列入白名單**（來源：Ron's own words (R&D DM 10:01, verified by PE in the transcript; see decisions-q.md L16 / grill.md Q7)，原話：「B+簡訊or line or email邀請（簡訊也開放這個場景 ） 但是租客不管用哪種還是可以再註冊時綁定line」））：簡訊只用於「註冊帳號驗證」、「簽約 OTP」、「改號驗證」與「租客邀請」；其中註冊驗證簡訊（`signup_verification`）用於首次註冊驗證，以及加入／蒐集流程裡「第一次證明這支新蒐集手機」的持有驗證（Ron 11/10 23:50：「手機登入簡訊：B，只在首次註冊驗證，之後用 LINE／Google／email 登入」；**Ron 11/11 08:32「Q12：A，歸入註冊驗證」**澄清：已用 LINE／Google／email 註冊的租客，在 B-048a P3m（及其他蒐集路徑）第一次驗證新手機，以及 B-048b 簽約前對尚未驗證號碼的身份核對，也使用 `signup_verification`；這仍不是登入方式，也不開放簡訊登入或簡訊復原；此核對不得改用 `contract_signing_otp`，該用途仍只用於之後的簽署 OTP；P10 上限共用）。已註冊後回訪不得以簡訊登入，之後以 LINE／Google／email 登入；改號驗證簡訊（`phone_change_verification`）在已登入使用者自行改號，或管理員／經理代改租客號碼時，一律發到新號碼，新號 OTP 成功前不變更號碼（Ron 11/11 00:10 Q1＝A；00:21 Q2＝A：「改號 mockup 核准；Q2：A，管理方代改也發 OTP 到新號，驗證前舊號不變」；同一用途，不另開 purpose）；其他場合產品設計若要使用，必須先經 Ron 審批。租客邀請簡訊（`tenant_invite`）：管理方在建立租約時先登記租客聯絡資料（姓名＋手機，email 選填）後，由管理方逐次按下「用簡訊邀請」才發送到該手機，內容只含公司名稱與加入方式，不含任何秘密（OTP、證件、金額、密碼）；不論從簡訊、LINE 或 email 邀請加入，租客註冊時都可綁定 LINE，聯絡資料與帳號的合併由管理方確認（R-b1）；P10 上限共用，對管理方的回應不得透露該號碼是否已是其他帳號（比照 B044-AC-P9）（Ron 11/11 10:01 原話：「B+簡訊or line or email邀請（簡訊也開放這個場景 ） 但是租客不管用哪種還是可以再註冊時綁定line」）。簡訊是否帶連結與 B-044 台灣簡訊網址限制的衝突待定（見 `10-product/create-flows-1111/sms-invite-note.md`）。伺服器端在 SMS adapter（單一入口）以 purpose 白名單強制，允許值僅 `signup_verification`、`contract_signing_otp`、`phone_change_verification` 與 `tenant_invite`；其他或缺少 purpose 一律拒絕並寫入稽核，回傳明確錯誤，不得靜默改發或改走其他通道。白名單為程式常數，變更需 Ron 審批並記入 DECISIONS。對外發送仍須 Ron 針對該次範圍原話同意（PRINCIPLES 56）。
59. 建立流程最少必填（Ron 11/11 09:29–13:08）：建單位只要物件名稱＋整層／分房（單位號碼選填），其餘用「待補」卡片之後補；草稿自動存；進階設定移出建立流程；金流預設帶屋主設定、物件可逐欄覆寫；租約資料原則上在「建立租約」就擋，只有租客可以到送簽前再補並確認。
60. 多登入帳號關聯（Ron 11/11 01:41–02:35）：先證明持有該登入方式再詢問關聯、須用原方式再登入一次才合併；合併進偵測到的既有主帳號，不能自行復原（找客服）；選「先不關聯」後 90 天內不再問；不新增簡訊用途；日常畫面不讓管理公司看到、平台稽核留存；員工兼租客不在伺服器端禁止，靠身分切換與稽核控管。
61. 「今天」首頁只放需要動作的事項（Ron 11/11 17:13）：續租／空租、未讀訊息、維修單、款項確認等；草稿不放首頁。
62. CEO 每天早上約 08:00（PT）檢查 airontech.co@gmail.com，把工作分派給對應 bot（Twilio／技術給 PE）；回信只起草，Ron 同意前不寄出（Ron 11/11 15:48）。
63. 官網小狀態快速迭代（Ron 11/11 23:37）：官網上的小型狀態（例如免費試用按鈕）直接上線，不等功能旗標、不做暫時閘控；對應功能上線前以人工作業補位（例：B-056 前試用由內部人工開通）。
64. Repo 一律 private（Ron 11/12）：condola-hub 已於 11/12 10:12 轉 private；Condola-app 依原則 47，等 Mac mini 自架 runner 跑綠並切換必要檢查後再轉 private。
65. Mac mini 雙軌分工（Ron 11/12 00:28、18:26）：box PE 做完 B-056 之前的項目，Mac mini 上的本機 Claude Code／Codex 從 B-056 起依 BUILD-ORDER 接手，負責合併並交付到 staging，第一步先做技術基礎與領域建模；交接文件與各團隊文件統一歸檔在 hub。

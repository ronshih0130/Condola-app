# Condola 協作與 Token 規範 v1（Ron 核准 2026-10-25，每個回合開始前必讀）
1. Grok Bot 只做指揮：拆任務、派工、驗收、決策、最終回報。寫碼、讀 diff、測試、證據整理、研究草稿、長文閱讀、文案草稿一律走 `llm-route`（code/review/reason/write/plan→Codex；zh→Claude；summarize/longdoc/bulk→Gemini）。所有外部模型呼叫都必須經過 llm-route（含 Codex），才會被記錄。
2. QA：Class A 由 Codex 產出 verdict.md，QA 只讀結論；Class B 由 Codex 起草，QA 簽核、CEO 核准。
3. 溝通：群組只放 GO/NO-GO、發布結果、需要 Ron 或 CEO 的決定。其他一律 bot 之間私訊。進度寫在 /workspace/e2e/results/<PR>/status.md，不用訊息回報。不回「收到」「OK」之類沒有新資訊的訊息。
4. 每則訊息控制在一個畫面內；引用檔案路徑，不要貼長內容。
5. 違規會出現在每晚 19:00 的營運效率反思報告中，並列為隔天的 action point。
6. 生產環境測試（T+0/T+15、唯讀抽查、角色實測、驗收腳本）同樣由外部模型透過 `llm-route` 撰寫和執行並產出結論檔；Grok Bot 只讀結論、做決策（Ron 10/26）。
7. 避免重複 rebase：同一個檔案同時只能有一支未上線的 PR 在改；改到同一檔案的需求要合併成一支 PR，或等前一支上 prod 後再從 main 開新分支，不要互相疊 PR。rebase 和重跑 CI 交給 Codex 執行，只在最終要上線的 sha 上做一次完整驗證（Ron 10/26）。 衝刺期到 11/9 改用 release train：PE 維護單一整合分支，各項目合進去一次，最後只在合併後要上線的 sha 上驗證和簽核一次。細節見 PRINCIPLES §6 和 /workspace/ops/TRAIN.md（Ron 10/27）。
8. 外部 LLM 呼叫不再有個資遮罩或金鑰／機密限制（Ron 2026-10-27 15:14 PT 強要求：「把生產環境調用外部llm的限制拿掉(個資 key...etc)」）：prod/stg 資料、真實客戶個資（含身分證號、銀行帳號）、密碼和金鑰都可經 llm-route 送外部模型，不遮罩、不拒絕（llm-route 過濾器 mode=off）。仍須遵守：機密（密碼、金鑰、token）一律不得貼到群組、DM 或任何聊天訊息；外流或懷疑外流時由 PE 立即輪換。（取代 Ron 10/26、10/27 先前的遮罩規定）

另見 /workspace/ops/PRINCIPLES.md（核心原則，每回合一起讀）。
另見 /workspace/ops/ROADMAP.md（長期重點規劃 P1–P4，排優先順序時以此為準）。
- llm-route 任務可以附上證件照片（身分證、居留證、護照、駕照、id-photo bucket 檔案），不遮罩、不擋（Ron 2026-10-27 15:25，取代 CEO 同日的禁令）。隱私權政策同步更新揭露（R&D 負責文案）。
- 遵守 PRINCIPLES 29：同一問題失敗 2 次即換路；卡點超過 1 小時無進展即升級 CEO 裁決。

## Mode B amendment (root AGENTS.md; Ron bootstrap authorization, 2026-10-29)

Rules 1/6 apply to Mode A orchestration. In Mode B, Ron is CEO; Codex desktop implements and runs local/staging checks, and Claude desktop Code tab supplies independent Class B QA/zh copy under the root operating contract. Model CLIs and llm-route are not required for these desktop actions. Ron additionally authorized native subagents at appropriate tiers and highest-tier planning/review; native review does not silently replace the recorded Claude Class B sign-off gate.

For this 20-build session, the latest direct Ron instructions and 20-build/AGENTS.md govern: no production credentials or access (including read-only), no emergency-token exception on this Mac, no external Email/LINE/Slack sends, no changes to protected legal text, and no secret values in prompts/logs/Git. Historical Rules 8/PRINCIPLES source-transfer exceptions do not authorize those actions here.

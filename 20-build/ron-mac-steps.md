# Ron 的 Mac mini 操作步驟

本包只讓 Codex 建置、測試及推送 staging。**Mac 不得取得任何 prod 金鑰，包括臨時 token、prod DB、ID_DOC 金鑰或備份解密身分。**

## 1. 準備登入與工具

1. 安裝並登入 Codex 桌面 App；若使用 CLI，先完成 CLI 登入。使用你已授權的帳號。
2. 安裝 Git，以及 repo 指定版本的 Node/npm、測試資料庫與必要工具；依 repo 的 toolchain 文件，不自行換版本。
3. 準備 Origin 的 Git 存取權。不要把 Git 密碼、token 或 staging env 貼到 Codex 對話。
4. 先讀 `/workspace/ops/handoff/AGENTS.md` 的現行版本。Mac 若沒有 `/workspace`，使用 repo 內已同步的 canonical 文件；缺檔先記錄，不用舊記憶補齊。

## 2. 從 Origin 取得專案

在 Terminal 執行：

```bash
git clone https://origin.cursor.com/ron-shih/condola-app.git condola-app
cd condola-app
git remote -v
git fetch origin
```

確認 `origin` 是 Origin，不是 GitHub。GitHub 只作鏡像。

先唯讀查看 `ops-lock` 與 HANDOFF。若其他執行者仍持有 repo，不要開始修改或自行搶鎖。依現有 `claim.sh` 流程取得 Mode B ownership；切換模式仍照原 operating contract。

## 3. 只準備 staging 環境

1. 使用 Mac 自己產生的 age identity，只將 public recipient 交給指定維運方。
2. 取得 staging-only 加密 bundle，放在 repo 外的受限位置。
3. 使用 repo 的 `scripts/secrets-run.sh staging -- <cmd>` 注入測試指令。
4. 不把明文 env、age 私鑰或 bundle 放進 Git、提示詞、截圖或 evidence。
5. 不從 box 複製 `/home/box/.secrets/line-prod.env`。LINE staging 應使用獨立測試設定；尚未提供就先跑 mock，並列 BLOCKED。

不要取得或使用任何 prod key。本包不採用原 contract 的緊急 prod token 例外。

## 4. 放入建置包

將整個 `20-build/` 放到 repo 根目錄，保留：

```text
20-build/
  README.md
  AGENTS.md
  BUILD-ORDER.md
  QA-STANDARD.md
  BLOCKED.md
  ron-mac-steps.md
  specs/
```

**不要用本包的 AGENTS.md 覆蓋 repo 根目錄原有 AGENTS.md。**

請由持鎖 session 將文件納入正常分支/checkpoint，避免與 box 同時改同一份 board、handoff 或共用檔案。

## 5. 啟動 Codex

在 Codex 開啟 repo，輸入：

> 請遵守 repo 根目錄 AGENTS.md 的 operating contract，並以 20-build/AGENTS.md 作為本次主提示詞。先讀 README、BUILD-ORDER、QA-STANDARD、BLOCKED 與下一項 spec。完整執行佇列；遇到需 Ron 決定的事項記錄後跳下一項。只做 local/staging，不碰 prod、不取得 prod keys、不寄送外部訊息、不修改法律文案。

若 ownership 或必要腳本尚未就緒，先處理交接，不繞過。

## 6. 監看進度

查看：

- `20-build/BUILD-ORDER.md`：todo、in_progress、verifying、done、blocked、pending。
- `20-build/BLOCKED.md`：需要你的選項、影響與建議。
- `e2e-evidence/B-NNN/status.md`：目前 branch/SHA、下一步。
- `e2e-evidence/B-NNN/verdict.md`：測了什麼、缺什麼。
- staging URL 與 `/api/version`：應符合 verdict 記錄的 SHA。

staging 的 PASS 不代表 prod 已發布，也不代表 flag 已開啟。11/9 是否完成由實際 queue 與證據決定。

## 7. 回答 BLOCKED

針對該列 ID 回覆具體決定，例如：

> B-030：採用列出的方案 A；價格以核准設定文件路徑為準，先完成 staging mock，不串正式付款。

將決定、時間、核准者與來源寫回該列，由 Codex重新檢查依賴後續做。不要在回覆中貼金鑰或 env 值；只提供受限檔案路徑。

真機 LIFF、真實 Email/LINE 收件等驗收由你或獨立 QA 執行，再交付去敏證據路徑；Codex 不自行寄送。

## 8. 暫停或停止

對 Codex 說：

> 暫停。不要開始新項目；完成安全 checkpoint，記錄 branch/SHA、status、verdict、STOP POINT 與下一個指令，依 contract 收尾 staging 工作並釋放 ownership。

等待確認鎖與背景工作已處理後，再關閉 App。若 Mac 無法連線或當機，不直接在另一台搶鎖；依原 contract 確認停機／fencing 後處理。

## 9. 回傳給 Grok Bot 側

由 Ron 傳回：

- Origin branch 與候選 SHA。
- queue、BLOCKED、各 verdict/status 的路徑。
- staging URL、版本及 preflight 結果路徑（在 repo 根目錄執行 `bash scripts/preflight-deploy.sh`，macOS 可用；來源分支 `preflight-script-1029` @ d40f7c4）。
- Class B draft、獨立 QA 簽核與 migration 相容性證據路徑。
- 尚待決定的項目及下一步。

不要傳秘密值。正式發布由 Grok Bot 側走 TRAIN、GATE-B、QA sign、CEO GO、T+0/T+15。ESIGN、MOVE_OUT/ID_PURGE、PAYEE 的啟用由 Ron 決定。

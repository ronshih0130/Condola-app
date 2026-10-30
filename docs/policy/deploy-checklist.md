# Prod 部署前檢查清單
每次 prod 部署前必做；依 RULES.md 進度寫在該 PR 的 status.md。

## 部署前
1. 比對 prod 已套用的 migration 和 repo 是否一致（每次部署前）：用 `/workspace/e2e/prodro.sh` 唯讀取得 prod catalog fingerprint，與用本次部署 commit 的 repo migrations 建出的 scratch DB 比對（方法見 `e2e/results/pr55/prod-migration-order.md`）；列出 repo 有但 prod 沒套用的、prod 有但 repo 沒有的、編號重複的；任何差異未解釋前 NO-GO；結果寫進該 PR 的 status.md；套用 migration 時出現 `skip missing` NOTICE 視為失敗。
1a. **Preflight（強制，CEO 2026-10-29 15:46）**：`cf:build` 後、任何 staging/prod deploy 前，執行 `bash /workspace/e2e/preflight-deploy.sh <worktree>`，必須 `PREFLIGHT PASS`（exit 0）才可部署。檢查：worktree 路徑與 `node_modules` 不得是 symlink（每個 worktree 自己 `npm ci`），`.open-next/server-functions/default/handler.mjs` 必須含 OpenNext patch 標記 `getMiddlewareManifest(){return null}`，且不得引用其他 worktree 的 node_modules。輸出存進該 release 目錄。來源：f1b10fa 全站 500 RCA（e2e/results/favicon-v2/rca/）。部署時不得有 dev server 在同一 worktree 寫 `.next`。
2. 備份：部署前完成一份可還原的資料庫備份並記錄位置。
3. Row counts：記錄部署前關鍵表的 row counts，部署後對照確認無異常流失。
4. Rollback id：記錄可回滾的 commit／部署 id，確保能一鍵退回上一版。
5. T+0/T+15：部署後 T+0 與 T+15 各檢查一次關鍵頁面與 Worker logs，異常即回滾。

來源：I-24；QA 10/26 02:20。

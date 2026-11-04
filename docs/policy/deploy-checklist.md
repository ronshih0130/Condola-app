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

## B-004 rollback

Two paths. Names only. No secret values belong in this file.

A flag is ON only when its environment value is exactly `true`. OFF is the kill: the secret is absent, or the value is anything other than `true`. `true` is the enable string, not the kill.

### Scope

Staging Worker `condola-staging`, Wrangler env `staging`, deploy `scripts/cf-deploy-staging.sh`. Production Worker `condola-prod`, Wrangler env `production`, deploy as in `docs/DEPLOY.md` (`npm run cf:build`, then `npx wrangler deploy --env production`). This note does not run either deploy and does not merge `main`. Flags stay OFF unless an accepted flags-ON check turns them on and then restores them.

### Flag secrets each target carries

| Target | Flag secret names |
| --- | --- |
| Flags-OFF emergency: `wrangler rollback 569555df` | That version's own secret set. It is the path while B-004 flags are already OFF. Do not add `PAPER_LEASE_VERSIONS_ENABLED` for this path. |
| `wrangler rollback e6788e38` | None for B-004. That secret set predates `PAPER_LEASE_VERSIONS_ENABLED`. Do not use this version for a flags-ON rollback. |
| Flags-ON: redeploy `1c8fd07bc1fd78e7a86a00daff994f68e734be4f` (proved on staging Worker `16b745e5`) | `PAPER_LEASE_VERSIONS_ENABLED`. `TENANT_SIGNED_PDF_ENABLED` is not a secret in that source; the constant is hard-coded. |
| Current candidate on `mode-b-repair-override-prep` | `PAPER_LEASE_VERSIONS_ENABLED` and `TENANT_SIGNED_PDF_ENABLED`. Both stay absent, or set to a value that is not `true`. |

### Flags-OFF emergency rollback

`wrangler rollback 569555df` on the Worker that is serving (`condola-staging` or, when production is authorized, `condola-prod`). Do not set B-004 flag secrets. Do not change `platform_settings` or organization flags.

### Flags-ON rollback

Redeploy the old code with the secrets set. Do not use `wrangler rollback e6788e38`.

1. Check out `1c8fd07bc1fd78e7a86a00daff994f68e734be4f`.
2. Build with `npm run cf:build`.
3. Staging: `scripts/cf-deploy-staging.sh` to `condola-staging`. Production, only when authorized: the production deploy in `docs/DEPLOY.md` to `condola-prod`.
4. Set the flag secret `PAPER_LEASE_VERSIONS_ENABLED` on that latest deployment. Do not record the value.
5. Set platform_settings row `tenant_signed_pdf` to JSON true for the tenant read.
6. Set organization flags `paper_lease_versions` and `tenant_signed_pdf` to boolean true on the organization under test only.

If a secret update fails, or the secret attaches only to the latest Worker version and not to a rolled-back version, stop retrying it on the old version. Redeploy the target code so that deployment is the latest version, then set the secret there.

After that redeploy:

- Logged-in staff download of the same signed PDF returns 200.
- Logged-in tenant download of that PDF returns 200.
- The two responses have the same hash.
- A cross-org request returns 404.
- A logged-out request returns 307 to login.
- The old code writes a tenant download audit and writes no staff download audit. The missing staff audit is accepted.

### Roll forward and restore

1. Record, before any change, the audit_log high-water mark and the exact prior value of each B-004 secret, `platform_settings` row, and organization flag (absent or the stored value).
2. Check out the candidate that was serving before the rollback.
3. Build with `npm run cf:build` and deploy that candidate to the same Worker.
4. Restore each flag exactly to the recorded value. If that value was absent or false, leaving it absent or false is the accepted restoration. Do not leave a flag `true`.
5. Final check: `audit_log` has 0 new rows from this procedure after that restore. If the flags-ON proof wrote its one accepted tenant `signed_pdf_downloaded` row, record that row and require 0 further rows.
6. `ops/flags.yaml` still has `PAPER_LEASE_VERSIONS_ENABLED` and `TENANT_SIGNED_PDF_ENABLED` default false.

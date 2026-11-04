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

## B-004 rollback by redeploy

`wrangler rollback e6788e38` is not the B-004 rollback. It restores that version's own secret set, which predates `PAPER_LEASE_VERSIONS_ENABLED`. Use a redeploy of the old SHA with the flag secret set, then roll forward and turn every B-004 switch OFF.

Names only. No secret values belong in this file.

### Flag secrets each target carries

| Target | Flag secret names |
| --- | --- |
| `wrangler rollback` of Worker version `e6788e38` | None for B-004. That secret set predates `PAPER_LEASE_VERSIONS_ENABLED`. `TENANT_SIGNED_PDF_ENABLED` is not a secret in that program. |
| Redeploy of `1c8fd07bc1fd78e7a86a00daff994f68e734be4f` (proved on staging Worker `16b745e5`) | `PAPER_LEASE_VERSIONS_ENABLED`. `TENANT_SIGNED_PDF_ENABLED` is still not a secret; that source hard-codes it. |
| Current candidate on `mode-b-repair-override-prep` | `PAPER_LEASE_VERSIONS_ENABLED` and `TENANT_SIGNED_PDF_ENABLED`. Both stay unset, or any value other than the exact kill-switch string, unless a later accepted check turns one on and then turns it off again. |

### Redeploy the old SHA

1. Check out `1c8fd07bc1fd78e7a86a00daff994f68e734be4f`. Do not merge `main`.
2. Build with `npm run cf:build`.
3. Deploy with `scripts/cf-deploy-staging.sh` (`npx opennextjs-cloudflare deploy --env staging`). Worker name: `condola-staging`.
4. Set the flag secret `PAPER_LEASE_VERSIONS_ENABLED` on that Worker. Do not record the value.
5. Set platform_settings row `tenant_signed_pdf` to JSON true for the tenant read.
6. Set organization flags `paper_lease_versions` and `tenant_signed_pdf` to boolean true on the organization under test only.

### After that redeploy

- Logged-in staff download of the same signed PDF returns 200.
- Logged-in tenant download of that PDF returns 200.
- The two responses have the same hash.
- A cross-org request returns 404.
- A logged-out request returns 307 to login.
- The old code writes a tenant download audit and writes no staff download audit. The missing staff audit is accepted.

### Roll forward

1. Check out the candidate that was serving before the rollback.
2. Build with `npm run cf:build` and deploy `condola-staging` again with `scripts/cf-deploy-staging.sh`.
3. Remove `PAPER_LEASE_VERSIONS_ENABLED` and `TENANT_SIGNED_PDF_ENABLED` from the Worker, or leave them as any value other than the exact kill-switch string.
4. Remove the `tenant_signed_pdf` platform_settings row.
5. Unset organization flags `paper_lease_versions` and `tenant_signed_pdf`.

### Everything OFF

Confirm all of these before calling the rollback finished:

- `PAPER_LEASE_VERSIONS_ENABLED` is absent or not the exact kill-switch string.
- `TENANT_SIGNED_PDF_ENABLED` is absent or not the exact kill-switch string.
- `platform_settings` has no `tenant_signed_pdf` row.
- No organization has `paper_lease_versions` or `tenant_signed_pdf` set.
- `ops/flags.yaml` still has both of those flags default false.

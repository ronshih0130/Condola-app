# B-008 local verification commands

Pinned Node 20 (`/opt/homebrew/opt/node@20/bin`) and PostgreSQL 16 tools were placed first in PATH. The worktree received an independent `npm ci --offline --ignore-scripts --no-audit --no-fund`; no dependency symlink was used.

- On a unique, seeded, disposable local clone of the fresh 80-migration template with the new migration applied: `node --import tsx --test --test-concurrency=1 src/server/statement-preview.integration.test.ts src/server/utility-reconciliation.integration.test.ts` — **9/9 passed**. The two files currently share test flag settings and must run serially or in separate clones.
- `node --import tsx --test src/server/billing-preview-rules.test.ts src/server/utility-reconciliation.test.ts src/server/utility-post.test.ts` — **29/29 passed**.
- `npx tsc --noEmit` and scoped ESLint over changed TS/TSX files — passed; the post-isolation rerun covered domain and the changed integration test.
- `npm run copy:check` — **6/6 passed**.
- `npx playwright test e2e/b008-billing-preview.spec.ts --reporter=line` against a dedicated local synthetic clone and local provider stand-in — **2/2 passed before the subsequent isolation-only fix**. No production services or external sends were used. The final candidate needs a browser rerun.
- `npm run test:unit` — **545/550 passed, 5 failed**, described in status.md. Do not treat as a passed gate.

# Local verification commands

Runtime: Node 20.20.2 and PostgreSQL 16. `DATABASE_URL` was supplied only for the designated loopback disposable cluster and `CONDOLA_RLS_DISPOSABLE=YES`; three synthetic ID fixture values were generated in child process memory. No credential or fixture value is recorded here.

- `npx tsx --test --test-concurrency=1 src/server/bank-matching-rules.test.ts src/server/bank-matching.integration.test.ts src/server/consent-entrypoints.test.ts`: 6/6 passed on a fresh owned clone with the new migration applied. A second owned clone with the migration already installed passed the integration test 1/1.
- `npx tsc --noEmit`: passed. Targeted ESLint for the changed TypeScript files: passed. `npm run copy:check`: 6/6 passed.
- `playwright test --config ../b009-playwright.config.ts e2e/bank-matching.spec.ts --grep <width>px`: 1/1 passed for each of 390 and 1280. The private runner creates separate owned clones, uses loopback-only local servers and synthetic child-process keys, then drops the clones. The final source-only test delta adds an explicit precondition and does not change browser behavior.

The private runner/config are local intermediates, not production tooling or a staging gate. The portable e2e spec uses the shared disposable DB guard, unique fixture identity and restores rollout flags. Earlier local failures and test-harness corrections are preserved in the private sanitized `early-checks.md` referenced by `artifacts.json`.

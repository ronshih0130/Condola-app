# Local verification commands

Runtime: Node 20.20.2 and PostgreSQL 16. `DATABASE_URL` was supplied only for the designated loopback disposable cluster and `CONDOLA_RLS_DISPOSABLE=YES`; three synthetic ID fixture values were generated in child process memory. No credential or fixture value is recorded here.

- `npx tsx --test --test-concurrency=1 src/server/bank-matching-rules.test.ts src/server/bank-matching.integration.test.ts src/server/consent-entrypoints.test.ts`: 6/6 passed on a fresh owned clone with the new migration applied. A second owned clone with the migration already installed passed the integration test 1/1.
- `npx tsc --noEmit`: passed. Targeted ESLint for the changed TypeScript files: passed. `npm run copy:check`: 6/6 passed.
- `playwright test --config ../b009-playwright.config.ts e2e/bank-matching.spec.ts --grep <width>px`: 1/1 passed for each of 390 and 1280. The private runner creates separate owned clones, uses loopback-only local servers and synthetic child-process keys, then drops the clones. The final source-only test delta adds an explicit precondition and does not change browser behavior.

The private runner/config are local intermediates, not production tooling or a staging gate. The portable e2e spec uses the shared disposable DB guard, unique fixture identity and restores rollout flags. Earlier local failures and test-harness corrections are preserved in the private sanitized `early-checks.md` referenced by `artifacts.json`.

## 2026-11-02 exact local checkpoint

From active worktree, each phase awaited before the next, using fresh owned clones:

```sh
python3 ../run-b009-prepared-check.py condola_b009_gate_0107baa b009-gate-driver-0107baa.log python3 ../b009-runtime-driver.py gate
python3 ../run-b009-prepared-check.py condola_b009_build_0107baa b009-build-driver-0107baa.log python3 ../b009-runtime-driver.py build
python3 ../run-b009-prepared-check.py condola_b009_http_0107baa b009-browser-driver-0107baa.log python3 ../b009-runtime-driver.py browser
```

Corrected readback command and its explicit subprocess return/log/source/helper hash receipt: ../b009-corrected-readback-exit-0107baa.json. Original failed readback status was NOT_CAPTURED, not implied success. Actual command/log/receipt bindings and all failure history are in local-runtime-0107baa.json. No --skip-rls or --release; no new proposed SQL executed.

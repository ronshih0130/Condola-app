# B-002 actual move-out UI commands

Pinned Node 20 and PostgreSQL 16 tools were used. Dependencies were installed independently with `npm ci --offline --ignore-scripts --no-audit --no-fund`.

- `node --import tsx --test src/server/move-out-notice.test.ts` — 10/10 passed, including nested cases.
- `node --import tsx --test src/server/b002-retention.integration.test.ts` on a unique seeded disposable core81 clone — 4/4 passed.
- `npx playwright test e2e/b002-actual-moveout.spec.ts --reporter=line` on dedicated seeded disposable core81 clones, once with flag absent and once with exact `true` — OFF 2/2 and ON 2/2 passed after the expected-404 test correction.
- `npx tsc --noEmit` and targeted ESLint for the three production files and test — passed.
- `npm run copy:check` — 6/6 passed.

The initial ON test failed only because its expected cross-org 404 appeared in the generic console-error collector; the corrected test explicitly asserts the 404 and restricts that exception to the navigation. No broad browser gate or staging result is claimed.

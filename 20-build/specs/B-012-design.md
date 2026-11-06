# B-012 L2 design — comparison evidence

## 2026-11-06 local package 1 slice (PT, UTC-08:00)

Scope: package 1 of `/tmp/codex-evidence-B-012.md`, excluding the browser spec, under Claude's delegated local-edit ownership. No product implementation or migration changes are needed by this slice.

### What this proves

- Unit and database tests assert exact current/proposed dates, rent, frequency, payment day and deposit. The fixed comparison uses 2030 → 2031, 10000 → 12345 rent minor units, monthly → quarterly, day 1 → 15 and 20000 → 25000 deposit minor units, at currency scale 2. All six differences are true; identical terms produce six false flags; changing each field alone produces only its corresponding flag.
- Each required field independently rejects omission, empty string and whitespace in both dated and explicit open-ended modes. Only an explicitly supplied empty end date is valid for open-ended mode. Database tests require `invalid` and exact unchanged rows after every rejected request.
- The OFF matrix covers absent/false/string-true global controls, malformed global values/allowlists, missing membership, and absent/false/string-true/null/object/array org flags. Each case requires a null view, unavailable direct server call and authenticated action, no renewal entry, and the real renewal page's Next.js 404 signal. A successful authenticated action with both controls enabled is the positive control.
- The legacy lease page's `leaseDetail` output is byte-identical JSON to its flag-absent baseline on fixed synthetic lease data. This is server-data compatibility, not a browser/HTML baseline comparison.
- Full row snapshots cover every `public` and `app` table, including controls and audit/history rows; only `auth_sessions` is excluded for normal authentication-touch bookkeeping. Assertions detect updates/deletes as well as inserted rows. The checks prove zero domain changes across comparisons and OFF requests.
- Every test restores the original global control row and complete org flags. Separate restoration tests exercise both an absent row and a pre-existing OFF row with nested data, description and a microsecond timestamp, on success and simulated failure. PostgreSQL JSON text avoids JS timestamp precision loss.

### Flags and execution boundary

`lease_renewal` stays OFF in operational defaults. Tests enable both controls only inside a disposable localhost database clone, restore controls after each test, and drop the clone. No hosted environment, migration file, ownership record, git commit or push is touched. Existing migration files are applied only to the authorized local test database for verification.

The two modified test files were already registered: unit via `test:unit`; integration via `test:rls` → `test:rls:b021-base`. No new test file or package registration is required.

### Remaining work

- Package 1 browser coverage: individual rendered comparison rows, screenshots and existing-route HTML/browser baseline. Browser execution is explicitly excluded from this slice.
- Package 2: durable submission, authoritative overlap recheck, concurrent/idempotent replacement protection, linked old/new views, completed replacement with immutable predecessor and tenant isolation. Current comparison overlap remains advisory; this slice does not prove submission rejection or completed replacement.
- Package 3: attributed/versioned notice and intent history, independent party responses, correction concurrency/isolation, unknown-date preservation, and historical early termination. Required schema proposals and their validation remain separate work.
- Independent Claude QA and orchestrator commit remain outside this local implementation pass; these checks are not release or whole-B-012 acceptance.

### Local verification

Target: localhost port 55432, `condola_b_012`; Node 20.20.2 / npm 10.8.2. Stub + all existing migrations and `npm run db:reset` passed. Typecheck, lint (0 errors; 15 warnings in untouched files), copy check and function-privilege gate passed. Focused unit/integration suites include all their pre-existing tests. No product defect found.

Claude re-ran after the r1 positive-control fix (2026-11-06 04:3x PT): `test:unit` 983/983 pass and `renewal-comparison.integration.test.ts` 7/7 pass (`/tmp/b012-unit.log`, `/tmp/b012-integration.log`); Codex QA r2 PASS.

Earlier logs: `/tmp/b012-db-setup.log`, `/tmp/b012-tests.log`, `/tmp/b012-typecheck.log`, `/tmp/b012-lint.log`, `/tmp/b012-copy.log`, `/tmp/b012-function-privileges.log`.

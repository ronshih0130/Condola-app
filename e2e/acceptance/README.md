Acceptance artifacts cover payment records, settlement, moveout, RPC security, copy, and pricing. `acceptance_checklist.md` maps requirements to automation and PM QA.

Files:

- `tests/money.spec.ts`: exact TWD calculations and civil-date boundaries.
- `tests/pricing.spec.ts`: prices, trial lifecycle, reminders, seats, unit changes.
- `tests/payments.e2e.spec.ts`: validation, installments, duplicates, reversal, readonly units, overdue, recipients.
- `tests/settlement.e2e.spec.ts`: statement content, balances, versions, visibility.
- `tests/moveout.e2e.spec.ts`: formula, override, deposit shortfall.
- `tests/rpc-security.spec.ts`: database EXECUTE and organization checks.
- `tests/copy-banned-terms.spec.ts`: whitelist-first scanner and exact production copy.

Install development dependencies `typescript vitest @playwright/test @supabase/supabase-js fast-glob @types/node`, then install Playwright browsers with `npx playwright install`.

Wire the clearly marked imports from `../src/TODO` to real pure functions and the production copy registry. Preserve expected values; adapters normalize signatures and result shapes only. Replace selectors in each `SELECTORS` object and implement isolated QA seed/reset fixtures. E2E files deliberately fail until selectors are wired; they do not claim acceptance through skipped placeholders. Missing adapters cause collection failure.

Run unit/security/copy suites:

```sh
npx vitest run tests/money.spec.ts tests/pricing.spec.ts tests/rpc-security.spec.ts tests/copy-banned-terms.spec.ts
```

Run browser suites:

```sh
npx playwright test tests/payments.e2e.spec.ts tests/settlement.e2e.spec.ts tests/moveout.e2e.spec.ts
```

Configure Vitest to exclude `**/*.e2e.spec.ts` and Playwright `testMatch` to `**/*.e2e.spec.ts` if using unrestricted `npx vitest` or `npx playwright test`.

Environment:

- `E2E_BASE_URL`: isolated QA deployment URL.
- `QA_ADMIN_EMAIL`, `QA_ADMIN_PASSWORD`, `QA_ADMIN_DISPLAY_NAME`.
- `QA_ACCOUNTANT_EMAIL`, `QA_ACCOUNTANT_PASSWORD`.
- `QA_MANAGER_EMAIL`, `QA_MANAGER_PASSWORD`: manager without reversal permission.
- `QA_OWNER_EMAIL`, `QA_OWNER_PASSWORD`, `QA_TENANT_EMAIL`, `QA_TENANT_PASSWORD`.
- `QA_READONLY_PAYMENT_PATH`, `QA_EXISTING_PAYMENT_PATH`.
- `QA_STATEMENT_PATH`, `QA_NEXT_STATEMENT_PATH`, `QA_NEGATIVE_STATEMENT_PATH`, `QA_STATEMENT_PAYMENT_PATH`.
- `QA_OTHER_OWNER_STATEMENT_PATH`, `QA_CROSS_ORG_STATEMENT_PATH`.
- `QA_MOVEOUT_PATH`, `QA_MOVEOUT_SHORTFALL_PATH`.
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `QA_ORG_A_JWT`.
- `QA_RPC_SCHEMA`: defaults to `app`; schema must be exposed to the QA API.
- `QA_RPC_CASES_JSON`: real SQL named arguments for both reversal overloads, invoice helpers and audit RPC; documented in `rpc-security.spec.ts`.
- `COPY_SCAN_GLOB`: defaults to `src/**/*.{ts,tsx,md}`; zero matching files fails.

The security suite uses `describe.skipIf` when required environment is missing. Required CI jobs must validate those variables before running and reject skipped security coverage. Use a real authenticated org A QA JWT with normal application grants, existing org B fixtures, and verified missing IDs. Never use a service-role key. Revoke migrations must be applied before AC15 verification; signature/schema failures are not permission-test successes.

Seed/reset independently for every E2E case, including separate data for role iterations. Replace previous sessions fully when switching identities. Freeze server business time as well as browser time; browser clock installation alone does not control server calculations. QA names are `QA租客A`, `QA物件101`, `QA屋主甲`, and `QA管理員甲`. Fixtures and cleanup must target only isolated QA data.

CI label mapping:

| Label | Required suites |
|---|---|
| `high-risk` | rpc-security + payments + settlement + moveout + money, full suites |
| `has-migration` | rpc-security, including grants/revokes and AC15, + money |
| `copy-change` | copy-banned-terms, including exact production copy assertions |

Run pricing whenever pricing or lifecycle logic changes. Class B always requires PM QA manual checklist sign-off; automated coverage does not replace it. Feature-flag-off behavior, slot deployment, PDFs/exports, scheduler delivery, audit payloads and every RBAC table cell remain explicit manual gates.

Unresolved source conflicts are visible: 已收到 versus banned 已收 has an expected-failure test; half-up at 432.5 is assumed. Move-out rent is capped at one month, so 31 days at 18,000 is 18,000. Trial length is the QA_TRIAL_UNIT and QA_TRIAL_COUNT parameter (calendar-months or days) with no chosen default. Handled rent counts company-directed rent only. The brief-required P04 summary is asserted alongside the supplemental required-field copy; PMk must decide their distinct triggers. The supplied combined statement footer is asserted; PMk should confirm its relationship to the supplemental unified disclaimer. Annual midyear unit-increase billing remains deferred and must not be invented.

No secrets belong in committed files, logs, screenshots, traces, or reports. These artifacts have not been executed against an application or database.

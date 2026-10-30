# Captured rent-line service period — local scoped evidence

Base: 70527ca; isolated worktree with a new owned clone of `condola_core90_fresh` on loopback PostgreSQL 16. The current captured first-invoice calculation supplies the rent line's inclusive service period. Legacy uncaptured rent and non-rent lines remain NULL; repeat issuance preserves the existing invoice. No historical invoice is rewritten.

- Actual captured full month, partial, one day on the 31st, non-prorated mid-month, capped lease end, zero invoice and OFF legacy: 7/7, private log `work/rent-period-v3.log`.
- Existing first-period integration: 5/5, private log `work/rent-period-first-period.log`.
- Existing e-sign integration: 2/2, private log `work/rent-period-esign.log`.
- TypeScript and focused ESLint: PASS. First initial seed setup failed because of the test runner's module-export form; no application test ran in that attempt, private log `work/rent-period-seed.log`.
- Native independent source review: scoped PASS on source 1b547e0cea7732f01e05955d437071952fc5fb36 and earlier five-case test f9a75e0cbcabf58b6d2a13861f7af2a16d5ed071. Two additional test cases are pending independent review.

These local checks do not establish staging behavior, complete B008/B011 acceptance, or an authoritative settlement outcome. The test requires the shared explicit disposable database guard, demo mode and synthetic fixture keys supplied by the runner; runner registration is separate.

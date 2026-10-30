# B-008 first-period local checkpoint

Updated: 2026-10-29T22:40:32-07:00. Mode B; branch `mode-b-billing-prep`, parent `090c1e2`. Session `ec2add82-fdbb-453c-b705-16057ea4208d`. Status: **PARTIAL / NO-GO**.

Ron resolved the first-period question: monthly rent / 30 × inclusive days. A whole calendar month is charged as a whole month, and the existing TWD/USD unit is rounded once at the end. The nullable, DB-derived source snapshot binds the choice, currency, rent and contractual dates; absent snapshots preserve the legacy full-rent behavior, including historical boolean=true. Turning the feature OFF does not reverse a captured source. The billing summary is displayed separately from the PDF and is not represented as PDF-bound or signed.

**Native independent scoped review: PASS**, after three P2 findings were fixed: (1) reject protected pre-sign end-date changes and check source before either activation path; (2) persist calculated first-period bounds for captured invoices, preserving legacy bounds; (3) reject capture when a same-lease e-sign disposal tombstone remains after evidence removal. The final review covered the actual repository partial-signing-to-disposal path and observed transaction lock edges. This is not whole-B008, staging, Class B, or release approval.

**Reconstructed verification notes:** five pure calculator/plan cases and five owned-clone DB integration cases passed, including both activation paths, flag OFF, strict scope/role/flag checks, forged metadata denial, both signing orders, case creation, and actual partially-signed case disposal. PostgreSQL `pg_blocking_pids` established the expected waiter/holder edges. Focused ESLint and Node 20 TypeScript checks passed. No raw terminal logs were retained. The migration was applied only to local disposable clones, not staging.

**Browser raw evidence, pre-final backend fixes:** 390px wizard and saved edit passed; 1280px was interrupted while awaiting navigation and is NOT a pass. Trace shows the fixture lease and its two local demo records committed; the incomplete response cause is UNKNOWN. Both sizes must be rerun on the exact integrated candidate. Screenshots/trace remain in ignored `test-results`; retention is unconfirmed and no trace is committed.

| Raw private artifact | bytes | SHA-256 |
| --- | ---: | --- |
| 390 wizard PNG | 60210 | `f3e2413516b368565aa2e13c8ada988bf8c51de6dd99d73f8474e23572e5b624` |
| 390 edit PNG | 141133 | `7f32e1328bb8ad2857b1dcfcbbf3f790835e92ab5a4ca31b0f3743a9307fd43e` |
| 1280 wizard PNG, interrupted case | 99087 | `2b88f7a96e08fc6d8240113b64ac5f3b2b24cc5a98f8141f2e509a9ec6f50a1b` |
| 1280 interrupted trace ZIP | 6564483 | `e3f4592cd0ed16fd847952f861f663acea92a01897d8154599b60cb96e679c78` |

**Outstanding:** deployment DB login/function-owner compatibility and consent boundary proof; exact-candidate full gates and both-width browser rerun; full billing-generation preview; B001 automatic activation and invoice hook (separately approved, not implemented in this checkpoint); staging and independent Claude review. No provider messages, production access, or activation.

## Bound source and test blobs

Git blob SHA-1 values, read from the frozen working tree; these are content identifiers, not test-run artifacts.

| Path | Git blob |
| --- | --- |
| `src/app/m/leases/[id]/page.tsx` | `c7948e9814dbee15366ec34e155774c7d4c6efe7` |
| `src/app/m/leases/new/page.tsx` | `10b5caf53d160684db2e80b0c483cc2a6c90fb93` |
| `src/app/t/lease/page.tsx` | `c66b2a1eac72a1dcce35c51748a4a3af1c4297c5` |
| `src/components/lease-terms-form.tsx` | `63a2f11f946f26233946fb5e348e78be3c441fe2` |
| `src/components/lease-wizard.tsx` | `733816336c8e578f0953dc43769385ac29562184` |
| `src/components/first-period-summary.tsx` | `4a081e2e350345c52b5ae8bb2d946232b234448c` |
| `src/i18n/first-period.ts` | `bc434b48bbb0945b8cf15b5808890e7c9893dcb2` |
| `src/server/actions.ts` | `7b0edb5c57b6d982a696be13dd1ff1ba73b225b9` |
| `src/server/domain.ts` | `078f10216ce8ba77bfe7491b8bb4fd6c34683d58` |
| `src/server/lease-form.ts` | `3d8352b4ab27e59eec5356a2e20fe5bb4293d336` |
| `src/server/queries.ts` | `0f10662d64dc9666d5c78230bbad4b92cb1d2c39` |
| `src/server/first-invoice-plan.ts` | `45670457c996ffa860b3ca21d140fd436dbc2149` |
| `src/server/first-period-calculation.ts` | `ad0525448f9991c50199c512e77ee4e4d6089d9c` |
| `supabase/migrations/20261031100210_b008_first_period_basis.sql` | `e0f46b22d8c713c49a03142fd91be2598f023cfb` |
| `src/server/first-invoice-plan.test.ts` | `61f68c1c94cf3f99838eef92c56017804c6ff650` |
| `src/server/first-period-calculation.test.ts` | `1211aac8b8685d2cefa2a9f08426baf6f0904c27` |
| `src/server/first-period.integration.test.ts` | `69b7315b6dd9b36e25ca21f7a614c6c8ab87b7b1` |
| `e2e/b008-first-period.spec.ts` | `798903a48636a3b7bfa7a981e3151da2f953c99c` |

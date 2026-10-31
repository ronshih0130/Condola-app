# B008 current status

Updated 2026-10-30T17:58:16.504496-07:00. Candidate `4b8228f995a29a56ac89bb86b4a8b2e7e12adfe8`, branch `mode-b-repair-override-prep`. **IN PROGRESS / scoped local preview PASS**, not whole-B008 acceptance.

[Current checkpoint](checkpoint-4b8228f.md): shared first-invoice preview and supported read-only monthly rent planning;611unit/373RLS+1approved historicalSKIP, builds/originalpreflight/Worker1 and6browser/22screens PASS. Native independent scope PASS. Global billing controls restoredOFF; no operational activation or DB migration.

Remaining: actual monthly generation/full-bill parity and writer-invariant design; exact staging/owner/catalog/old-code/rollback and ClaudeClassB acceptance. [Non-executable DB research](monthly-db-research.md) is not apply-ready. Eligible nonDB design/application work continues; do not park the whole item or label it done.

STOP POINT: WORKING; next: `cat ../B008-monthly-writer-contract-v2.md`; owner: Ron modeB3099AC86/Codex.

## Historical checkpoint (superseded status, evidence scope retained)

> Latest local integration checkpoint (2026-10-30T03:05:16.071480-07:00): candidate `4e43104f45c3acf0dae76e40c7b577bd7ffb8ea6`; see [core89 local verification](../integration/core89-local-verification.md). Whole-feature verdict remains INCOMPLETE/NO-GO; dated records below retain their original scope. This link supplies no staging/Claude/release waiver.

# B-008 statement and utility checkpoint

Updated: 2026-10-29T21:37:33-07:00. Branch `mode-b-billing-prep`, based on `2c3bff5eca75b83100fab8a4117c36b5562d384c`.

B-008 is **PARTIAL**. A single read-only statement calculator now supplies the amount preview and issuance, with source identifiers and versions, per-property amounts, deposit exclusions and unattributed amounts. The global `billing_previews` allowlist plus exact org opt-in default OFF; OFF preview stays metadata-only and issuance without a preview fingerprint retains read-committed isolation. An enabled issuance requires a matching fingerprint. Fingerprinted issuance uses a serializable snapshot; sources committing afterward may serialize after issuance. Existing issued statements are not recomputed. The scoped close screen reads saved utility runs, shows the recorded bill and components, and surfaces an unexplained difference or unknown source data; it does not create a utility draft or change close policy.

Native independent highest-tier review PASS on the final reviewed source hashes, as reported by the repository coordinator. Focused Node 20 checks: 9/9 serial local database tests, 29/29 unit tests, targeted typecheck/lint and 6/6 copy tests passed. Two browser tests at 390/1280 passed before the subsequent isolation-only fix; they must be repeated for the final combined candidate. Private synthetic screenshot paths, sizes, hashes and unconfirmed retention are in `browser-artifacts.json`.

The broader `npm run test:unit` run failed 5 of 550 tests: unregistered 100208 migration classification and migration-list expectation, two existing ID-photo source assertions, and the staging-bundle smoke (missing migration classification and a refused default local 5432 connection). This is recorded as a failure, with no baseline waiver. The test bundle's attempted default database connection was unintended and refused. Registrations and final integration are coordinator-owned.

Ron subsequently decided that partial first-month rent is monthly rent divided by 30 and multiplied by inclusive days. The local first-period checkpoint implements that decision with a versioned source, one shared calculator and separate billing summaries; see `first-period.md`. Legacy leases without a basis keep full-rent behavior, and a captured basis survives flag OFF. The summary is separate from the lease PDF and is not claimed to be PDF-bound or signed. Full billing-generation preview remains incomplete. Historical stored utility bills may be calculated rather than manually entered; the source does not distinguish all cases.

STOP POINT: reviewed partial local candidate; next: coordinator serial integration, exact-candidate gates and both-width first-period browser rerun, verify deployment ownership of the private capture function, independent Claude QA and B001 financial-hook integration; owner: Ron/Codex.

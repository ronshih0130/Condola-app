# B-006 diagnostic slice

Updated 2026-10-29T17:35:49.004414-07:00. State: in_progress / PARTIAL; not done.

Source rows/fields/reasons are preserved through CSV logical records and sparse XLSX declared rows. Source metadata is bounded and separate from compact rows; flag OFF retains legacy compact positions and preview/CSV paths. With both deployment and active-organization opt-in, diagnostics show original rows and merge local/preview/commit errors into counts/status and exported reasons. CSV export continues using existing formula-neutralizing writer.

Node20.20.2/npm10.8.2: focused actual-reader/import tests 20/20; typecheck and focused lint PASS. Final browser ON/OFF at 390/1280: 4 passed (23.1s), zero captured console/page errors or5xx, export source rows3/6 and same-value start/end date attribution verified. Screenshots inspected and recorded in screenshots.json. Uses synthetic data and mocked preview/commit responses; proves UI and diagnostics, not database import writes.

Highest-tier native independent static review: focused code-scope PASS after two rounds resolving source compaction, commit-only statuses and whitespace/invalid XML row-ID handling. No whole-item acceptance implied. No legal text modifications.

Remaining: jurisdiction-specific formats; authorized real sample; posted DB counts and corrected-file resubmission; full exact-candidate gate; staging version/auth/browser acceptance. Flags default OFF; no staging activation/deployment.

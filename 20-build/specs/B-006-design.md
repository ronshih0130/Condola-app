# B-006 — JIT L2 設計稿：匯入錯誤明細與地區來源格式（Class A；evidence + gap test）

> Author: Claude (Mac overnight, 2026-11-06 PT). Layer-2 design for hub `20-build/specs/B-006.md`. Flag `IMPORT_ERROR_DETAILS_ENABLED` (deployment env) × `organizations.feature_flags.import_error_details` stays OFF. No product code change. Branch cut from #36 (`d374bb6`).

## Evidence (independent Codex evidence review, read-only, HEAD d374bb6)

| Clause | Status | Evidence |
|---|---|---|
| A1 original row numbers, fields, reasons, correction formats traceable | covered | `src/lib/spreadsheet.ts` sparse/quoted numbering; `owner-import.ts` mapping/export; `import-wizard.tsx` preview; tests `import.test.ts` (row/field/reason export, CSV/XLSX numbering), e2e `import-diagnostics.spec.ts`, `import-real-resubmit.spec.ts` |
| A2 corrected resubmission does not duplicate | covered | `owner-import.ts` reuse, `import-batch.ts` serialized commit; `import.test.ts`, `import.integration.test.ts` (non-mutating preview, single lease after repeat), e2e resubmit totals |
| A3 configured jurisdiction controls regional dates | **partial → closed here** | context `import-region-context.ts`, TW-only profile `import-region.ts`; new `src/server/b006-regional-date.integration.test.ts`: TW/TWD org, ROC `116/01/05`→`117/01/05` persisted as `2027-01-05`/`2028-01-05`; same fixture under US/US-CA/USD ⇒ `im_region_unavailable`, zero records |
| Whole-unit/room relationships and counts | covered | `owner-import.ts` / `import-batch.ts`; `import.test.ts`, e2e relationship counts |
| Flag OFF keeps legacy page | covered server-side; browser residual | `import-region.integration.test.ts` (org OFF legacy import; env `"false"` ⇒ no region); page only loads a region when env is exactly `"true"`. Residual: a browser assertion with the deployment switch unset/`"false"` (e2e runs on labelled CI only) — logged, not run from the Mac |

## Residuals (carried from `e2e-evidence/B-006/status.md`, unchanged)

Source coverage above is not executed acceptance. Still open: (1) an authorized de-identified customer sample or Ron's disposition of it (no customer file is invented); (2) exact staging app/version/auth/browser acceptance (PE/QA); (3) the browser-level deployment-OFF assertion (labelled CI e2e); (4) the fresh Class A Codex verdict on the final SHA; (5) format limitations recorded in `e2e-evidence/B-006/status.md` stay unverified — US/other regional formats (only TW/TWD is supported; non-TW profiles are refused, which is not format support), Excel 1904-date workbooks, and ambiguous decimal/date inputs. Production is out of scope.

## Done means (this slice)

A3 now has a direct integration proof (persisted Gregorian dates under the configured TW jurisdiction; refusal under a non-TW profile with an organization-wide zero-write footprint (incl. `import_jobs` and full `listing_terms` contents)); all other clauses map to existing tests; residuals above stay open.

## Cross-review (Codex Class A)

r1 FAIL (zero-write proof too narrow; residuals omitted) → fixed; r2: cleanup resolved; footprint extended to `import_jobs` + `listing_terms` contents and format residuals recorded **after r2** (not re-reviewed; 2-round cap — a fresh Class A verdict on the final SHA remains residual (4)).

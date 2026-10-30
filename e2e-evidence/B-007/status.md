> Latest local integration checkpoint (2026-10-30T03:05:16.071480-07:00): candidate `4e43104f45c3acf0dae76e40c7b577bd7ffb8ea6`; see [core89 local verification](../integration/core89-local-verification.md). Whole-feature verdict remains INCOMPLETE/NO-GO; dated records below retain their original scope. This link supplies no staging/Claude/release waiver.

# B-007 regional deposit checkpoint

Updated: 2026-10-29T20:18:15.779671-07:00; branch mode-b-build; Ron/Codex.

Ron approved replacing the single named fixed CHECK for local/staging, preserving OFF behavior, original data and historical migrations. New100205 supplies one read-only regional rule resolver shared by UI/server/database enforcement. Platform allowlist+org boolean defaultOFF; no duplicate switch. ON uses configured org/jurisdiction/effective-date policy and no global Taiwan fallback. OFF keeps the prior two-month reason requirement.

Database checks amounts versus months, zero-rent and nonmonthly basis, currency rounding, current actor and database-stamped new override time; unchanged historical metadata retains exact timestamp precision. Property/target/date changes recheck. Malformed caps fail closed; numeric strings remain compatible and explicitJSONnull means no cap. Consent guard precedes action work. The write helper serializes against global/org configuration, including missing/renamed/deleted/truncated global setting. Trusted actual service-role and table-owner paths are preserved; forged JWT role does not grant access.

Native highest independent static review PASS on final migration616af821a0c41681258c2b0d6ab47004ed8d91f1 and integrationbaaf5dfc4ec9612b214625973f305c0ebd44b3e6. Fresh local clone: focused DB3/3, existing deposit path1/1 selected, type/lint and focused policy/consent/copy checks passed. Actual manager-first/tenant-final signLease regression passes. Exact combined gates, fresh-vs-upgrade catalog, HTTP/browser390/1280, staging and independent ClaudeClassB remain pending. Feature not activated.

STOP POINT: implementation prepared; next: combined code/check registration, exact candidate gate and regional UI checks; owner: Ron/Codex.

Browser checkpoint 2026-10-29T20:32:56.312999-07:00: full local matrix8/8 at390/1280; validates wizard/save/edit metadata and rule-check source/outcome/amounts. No unexpected browser/page/HTTP errors. Mobile over-cap layout fixed by two scoped display:block styles; affectedTW cases2/2 rechecked with vertical geometry/overflow and visual inspection. Private synthetic screenshots manifest in browser-artifacts.json. Summary reason label uses the existing generic configured-limit caption rather than implying a universal two-month threshold. Committed test now uses the shared explicit-disposable guard at module scope, preserving portable CI ports; the manual runner still targeted its dedicated private clone. These checks precede final B003 integration, so final combined evidence remains pending.

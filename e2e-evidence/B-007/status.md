# B-007 regional deposit checkpoint

Updated: 2026-10-29T20:18:15.779671-07:00; branch mode-b-build; Ron/Codex.

Ron approved replacing the single named fixed CHECK for local/staging, preserving OFF behavior, original data and historical migrations. New100205 supplies one read-only regional rule resolver shared by UI/server/database enforcement. Platform allowlist+org boolean defaultOFF; no duplicate switch. ON uses configured org/jurisdiction/effective-date policy and no global Taiwan fallback. OFF keeps the prior two-month reason requirement.

Database checks amounts versus months, zero-rent and nonmonthly basis, currency rounding, current actor and database-stamped new override time; unchanged historical metadata retains exact timestamp precision. Property/target/date changes recheck. Malformed caps fail closed; numeric strings remain compatible and explicitJSONnull means no cap. Consent guard precedes action work. The write helper serializes against global/org configuration, including missing/renamed/deleted/truncated global setting. Trusted actual service-role and table-owner paths are preserved; forged JWT role does not grant access.

Native highest independent static review PASS on final migration616af821a0c41681258c2b0d6ab47004ed8d91f1 and integrationbaaf5dfc4ec9612b214625973f305c0ebd44b3e6. Fresh local clone: focused DB3/3, existing deposit path1/1 selected, type/lint and focused policy/consent/copy checks passed. Actual manager-first/tenant-final signLease regression passes. Exact combined gates, fresh-vs-upgrade catalog, HTTP/browser390/1280, staging and independent ClaudeClassB remain pending. Feature not activated.

STOP POINT: implementation prepared; next: combined code/check registration, exact candidate gate and regional UI checks; owner: Ron/Codex.

# B-002 acceptance — local scoped checkpoint

Candidate `71acf06d7675e99ef83cf20c545a2c56d775ccf3`, recorded 2026-10-30T14:28:52.121390-07:00. Whole item INCOMPLETE; no staging/release/activation approval.

| Given / When / Then | Evidence and scope |
|---|---|
| Active indefinite lease does not start retention countdown | Existing ID/move-out/B002 retention suites executed within this exact candidate's full RLS gate. Unknown historical origins remain held; no backfill. One separately approved lost-history fixture is skipped. |
| Fixed-term end or actual indefinite end/move-out plus90days | Current known-provenance boundary and move-out suites pass in full gate. Same valid HTTP token works before date change and denies afterward; independent expired object also denies. Existing later-of-two rule preserved, not newly decided. |
| Unsigned/cancelled/void uses upload-date origin | Existing retention integration coverage executed within full gate; this new HTTP fixture is formed fixed-term, not a substitute unsigned fixture. |
| OFF/missing/invalid and dry_run delete nothing | Actual cron HTTP route -> real runner: six OFF-compatible calls have zero work/no summary; two dry_run calls each preview2documents+1expiredslot, no deletion, full storage-state hash unchanged and one matching audit each. Restores original setting absence. |
| Authenticated/anonymous expired-link and authorization | Real positive decoded JPEG/private-no-store/nosniff; expired HMAC/object, anonymous valid/expired, different actual principal, actual sandbox scope and same-token post-date denial. Consent separately returns403. No successful download audit on denials. |
| Fixed admin policy and restricted role | Actual settings at390/1280 show90 without editable retention input; manager redirects to permission page. Two screenshots inspected by root. No legal/notice edits. |

[Exact manifest and private artifact hashes](http-boundary-71acf06.json). Gate599unit+358RLS PASS/1prior-approved historical SKIP; builds/preflight/Worker1 and serial browser1 PASS. Fresh source/config/runner are bound to the candidate. Initial failures remain preserved.

Not proved: HTTP upload or token issuance UI; HTTP mode-read-error injection (NOT_RUN, existing mocked unit guard is separate); destructive purge/backups through this focused HTTP proof; actual approved old-runner rollback compatibility; staged app/version; independent Claude acceptance. Existing old UI evidence remains dated, not transferred to this SHA. B012's prospective notice workflow and whole CAP-M-13 are not claimed.

Scope clarification: existing full RLS purge tests used ON and synthetic deletion only on disposable local fixtures. New focused HTTP proof never uses ON or deletes; no operational/production purge or backup action occurred.

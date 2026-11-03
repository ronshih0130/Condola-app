# B018 native bootstrap decision and diagnostic checkpoint

Recorded 2026-11-03T15:48:33-08:00; branch `mode-b-repair-override-prep`.

Tested application code remains `1c8fd07bc1fd78e7a86a00daff994f68e734be4f`. Its full code gate passed 651 unit and 476 RLS tests, zero failures, with only the previously approved lost-history fixture skip. This checkpoint changes evidence/documentation only; it does not transfer browser or feature acceptance to a new candidate.

## Actual results remain failed

- Original EN390 browser focus: FAIL before payment cases. Financial lineage for that original clone remains UNVERIFIED/quarantined; controls were restored OFF. Receipt SHA `940065e3aada47142f4d34a4303b8bf8fd6b2f4f6f0ab02b2af62c5d1f5e62d3`.
- Later OFF-only login diagnostic: both native and enabled arms verified the expected tenant identity. Native had two webpack failures identified by CDP as `csp`. Enabled had canceled Fetch requests, including the login POST and a `/t` request; these remain failures. The successful `/t` observation was Fetch, not a Document navigation. Receipt SHA `4cea32d7046e67bbb25259247889dd73390ccad8262284e4b7ad2f69b63b5e25`.
- That later diagnostic's separate fresh pre-finance baseline was verified unchanged. This does not establish the earlier clone's financial lineage. Actual effective application CSP was not captured; neither presence nor absence is established from the application diagnostic.
- Separate inert control A, with no app, auth or database: JS-off produced one failed script request represented by both observers; JS-on loaded and executed the same script. Both documents had positively observed absent CSP. Overall strict result remains FAIL, receipt SHA `7cd906ed32251d290d0212add77f15d2ee52a5333657c9e511460dccb31f60c1`. This supports a narrowly configured negative control, not a conclusion that all application failures were harmless.

Independent actual-result reviews and exact raw receipt/manifest hashes are in [manifest.json](manifest.json). Original artifacts remain under the workspace's `work/` diagnostic directories. No original log or FAIL was overwritten.

## Ron's explicit criterion decision

Ron selected the bounded negative criterion in reply to `call_e0f9782f2f0345179dc7af62b7432b1e`. [Decision record](b018-native-bootstrap-ron-decision-20261103.json) binds the [reviewed proposal](B018-native-bootstrap-criterion-decision-20261103.txt), SHA `9e42d1bc0bb4a1080e8067dfd228b648022f97de559983d2e59cb02186580aec`.

Only specified native HTML login bootstrap scripts with exact document/request correlation, complete policy evidence and a same-asset positive counterpart can qualify prospectively. All ordinary enabled-login cancellations, payment-screen, HTTP, console, unknown, cleanup or recovery errors remain fatal. Historical failures do not change. This does not approve an unreviewed implementation or a run.

Independent review rejected proposal-v2 integration: it circularly required completed finance before admitting the bootstrap needed to begin finance; its asset witness also lacked the actual per-render native binding. The replacement separates provisional native admission from the independently recovered final aggregate, uses complete parent-owned immutable journals, and initially supports only positively observed absent CSP. Present or unknown policy remains unavailable. The replacement classifier/collector and exact future freeze still require independent review.

## Remaining work

1. Complete and independently review the replacement classifier, actual PW/CDP producer and recovery integration. Verify both blocked and enabled render mappings to frozen webpack bytes; synthetic classifier tests do not prove those witnesses exist.
2. Independently freeze one fresh isolated focus and run it. Keep raw strict FAIL visible for any qualified negative pair; every other error remains fatal. Require independent finance/control recovery and real process-close evidence.
3. Only after applicable focus evidence, obtain explicit build-only authorization and run builds/full browser matrix. Existing code-only gate does not authorize a build or staging acceptance.
4. Separate public-reason source package was copied with exact hashes to Downloads. It remains unparsed, unapplied, target UNVERIFIED and NOT_APPLY_READY. PE non-Mac validation/application and Codex application integration remain.

B018 stays **in_progress / whole feature INCOMPLETE / release NO-GO**. No new B ID, migration, operational flag activation, main merge, production, external message or legal-copy edit.

STOP POINT: criterion decision recorded; replacement implementation in progress; next: independent source review of bounded classifier/producer before any new browser execution; owner: Codex/Ron.

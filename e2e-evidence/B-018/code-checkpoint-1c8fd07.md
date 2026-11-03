# B018 tenant payment history — scoped code checkpoint

Tested `1c8fd07bc1fd78e7a86a00daff994f68e734be4f`. **CODE_GATE_GO / BROWSER_FAIL_PENDING / WHOLE_B018_INCOMPLETE.**

Implemented behind default-OFF history controls: personal payment reports with original/current values and decisions, rejected re-report history, pagination/direct links, shared home/payment balance and status, and ended-lease read-only history. Signed utility credits remain visible without changing owner-statement allocation or unsigned payee eligibility. Issued pending-signature deposit balances and their existing report action remain available.

Full clean code gate passed 651 unit and 476 RLS tests, zero failures. One previously approved historical b888ccd fixture remains skipped; no new test skip or assertion relaxation. Eleven steps and three drained code-gate children verified. Focused 35-unit and 9-case actual database targets passed first. [Gate summary](tenant-history-code-gate-1c8fd07.md), [independent code verdict](b018-code-checkpoint-astra-1c8fd07.md), [immutable evidence](tenant-history-runtime-1c8fd07.json).

Strict EN390 browser focus failed before the payment journey: six JS-disabled sign-in script requests failed; why remains unverified. All three sign-ins completed, but there is no payment-screen acceptance. Independent recovery quarantined the clone and did not verify financial lineage; controls were read back unchanged/OFF. The receipt proves its recorded Node groups drained, not every detached Chromium abnormal-exit case. The 21-file failure archive is retained. A new bounded login comparison is under source review; no unchanged rerun, error waiver, build or full matrix occurred.

Separate public reversal reasons were approved by Ron. The source-reviewed inactive SQL/PE handoff/seed compatibility patch and hashes were copied to `/Users/ron/Downloads/condola-bootstrap/`. SQL and patch remain unapplied and target-unverified. PE must validate/apply on non-Mac with approved staging plan and restore-backed proof. Codex must then integrate the explicit public field, keep the original staff note private and validate the new behavior. Historical missing reasons stay unavailable; no retrospective copying.

No whole feature, staging, Claude/Class B, pilot or release acceptance. No production access, main merge, migration execution, external messaging or operational flag activation.

STOP POINT: code checkpoint ready to publish; next: Origin push, same-owner renewal, canonical mirror and direct-ref verification; then independently reviewed OFF-only login diagnostic and remaining B017 stages; owner: Codex/Ron.

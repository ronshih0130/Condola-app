# B-002 actual move-out UI checkpoint

Updated: 2026-10-29T21:48:00-07:00. Branch `mode-b-moveout-ui-prep`, based on `56460d5b57eb950e0b1aed4ee26d724d2f6a0dd1`.

The lease summary now lets authorized admins/managers record and correct the actual move-out date with an optional note through the existing session-derived action and transaction. It distinguishes the actual date from a recorded contract end date and points to the existing admin-only audit history. Other staff do not receive the control. `MOVE_OUT_NOTICE_ENABLED` is the sole control: the existing helper requires exact `true` and defaults OFF; no production flag was changed. The UI does not alter lease status or decide a new legal rule.

Native highest-tier independent static review PASS on the three final production blobs, as reported by the repository coordinator. The only subsequent test delta narrows expected console handling to the explicitly asserted cross-org 404. On unique private core81 clones, existing retention integration passed 4/4, notice unit passed 10/10 and browser OFF 2/2 plus ON 2/2 passed at 390/1280. The first ON browser attempt passed the business assertions but failed the console check on its deliberate cross-org 404; the rerun explicitly asserted that 404 and passed. Typecheck, targeted lint and copy 6/6 passed. No real provider or external message was used.

Whole B-002 remains INCOMPLETE: final combined candidate and staging checks, expired-token HTTP and old-runner rollback evidence, independent Claude QA and release/activation decisions remain pending. CAP-M-13's prospective notice/source, documents and bilateral confirmation are not represented by this actual-date field. Screenshots are private synthetic evidence with retention unconfirmed; see `browser-artifacts.json`.

STOP POINT: reviewed local UI checkpoint; next: coordinator integration and exact-candidate gate, pending B-002 HTTP/rollback/QA evidence; owner: Ron/Codex.

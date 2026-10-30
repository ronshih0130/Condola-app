# Mode B bootstrap acceptance

Recorded: 2026-10-29T17:13:29.182087-07:00
Receiving coordinator: Ron / Codex desktop; model and quota: unknown.
Ownership-session UUID: `3099AC86-6AF0-4681-9944-304E930BFDC2`.
Origin baseline: `c6843a522fcfe4a6ad1aa74bb3e4fd18c56796df`, branch `mode-b-bootstrap`.

## Authority and ownership
Ron explicitly reported that CEO had notified Mode A to stop condola-app development based on Ron's 2026-10-29 16:15 PT Mode B decision, and instructed `CLAIM_BOOTSTRAP=YES`. There is no previous departure record; this is a bootstrap, not proof of a historic release/freeze. The supplied README-context-pack.md likewise states no filled HANDOFF or release record exists.

Canonical claim.sh successfully created ops-lock at `f544d0165ce6fe59d14a974e0b245183524a127a`: repo ACTIVE, B/Ron, generation 1; prod/staging initialized RELEASED. No break-glass or competing holder override. Production operations/versions/rollback and departed executor job state are UNKNOWN beyond Ron's reported stop instruction; no production queries permitted to resolve these unknowns. Staging claim not yet acquired; no deployment.

## Sources and protected setup
Context archive verified against supplied SHA-256 `9a344a2200e3a19be1a21dbcfcfea5904859d77d3403d91d5008d16884e821ec`. README-context-pack.md maps box condola-hub paths to local hub/. Policies remain canonical under docs/policy with ops/ thin symlink pointers. Actual TRAIN and full feature lane code are still unavailable; no replacement policy invented.

Replacement staging bundle verified against supplied SHA-256 `3736f2fb75e27ff7a75d77c01f72608168a47885cb4f78564e1dc69fe156684b`, installed outside all checkouts with restricted permissions. Original secrets-run.sh passes `staging -- true` and allowlist names. URLs/JWT project refs agree; read-only staging DB SELECT 1 passed. No plaintext secrets displayed/persisted; no env or age material committed. This proves decryption and DB connectivity, not app deployment or browser acceptance.

## Reconciliation and next work
Hub cites B-001 e-sign 028ab9a, B-003 payee 389ff74, B-004 paper/download dcc104d and associated migrations; absent from current Origin and local objects. B-002 also cites missing purge/move-out history. Do not duplicate these undisclosed schemas or claim their historical verdicts as current PASS.
B-005 independent verification proceeds: resumable trial state has a concrete empty-settings defect and can reuse existing organization settings, with no migration or legal copy change. Invitation-team lane overlap remains pending. Reserve paths in ops/board.md.

Native independent review supports bootstrap prerequisites only; Class B independent Claude desktop QA remains required and unperformed. No production authority, no external messages, no legal-copy edits. Mirror authentication/state: unknown; no GitHub writes made.

STOP POINT: repo ownership ACTIVE, context reconciled, staging DB read-only verification PASS; next: focused B-005 local PostgreSQL verification; owner: Ron/Codex. Full queue remains active and incomplete.

## Active source-reconciliation checkpoint 2026-10-29T18:03:33.428084-07:00

Integration worktree is work/mode-b-build, branch mode-b-build. User-supplied c011e91 code source is preserved through explicit two-parent bridge53391dd; both oldOrigin2bedb89 and source5d8b002 are reachable. No live production verification claimed. All7 incoming refs were atomically pushed and exact remote SHAs read back.

32 shared migration files keep exact oldOrigin bytes;39 additional source files preserve exact supplied bytes (12 Version-comment differences documented). Source-integrity independent review PASS at8cbb9e5; no supplied path loss, legal implementation and all2243 existing locale values preserved. Local B005/B006 replay evidence awaits fresh combined acceptance.

Fresh71-file migration replay executed. Independently old32 schema with synthetic seed upgraded through39 additional files; organization/property/lease/payment counts unchanged. Catalog and previous-code compatibility still pending; no shared staging schema change. Combined gate8cbb: pinned install/type/lint/copy/PostgreSQL/flag checks PASS; unit FAIL (missing historical migration classification, now being corrected), RLS FAIL (missing b888ccd fixture, requested from Ron). No baseline failure waived.

Staging DB connectivity PASS; REST metadata401, actual API configuration UNKNOWN. Updated staging bundle requested only by protected path+hash. Local test-only encryption material generated in memory where required for synthetic seed; never obtained from maintenance/production, never printed or stored in Git.

STOP POINT: repo claim remains ACTIVE B/Ron, child staging/prod claims not acquired; next: commit and verify B001 RPC/RLS security and packaging corrections on exact candidate, then continue B002–B004 using recovered lanes; owner: Ron/Codex. Full39-item goal remains active and incomplete.

Staging auth resolution: service_role with apikey + Authorization verified zero-row organizations REST read HTTP200; app-profile metadata returned406/PGRST106 (app schema not exposed). Earlier anonymous401 did not prove invalid keys; existing bundle retained. No customer rows returned, no schema mutation.

Provided historical SQL comparison: eabd6c26bb9fa785e255343a73bb316d665b3b3584bedc78f514e4bc95dffd19 equals current1820 migration; PR9e9b2295f0140e3b06e3f585ccf564816d98f7e00efbf0bea7f02d3147b69363b9 differs only in helper permissions/comment. Both alreadyenforce nonnull deletion clock and819200-bytephoto cap. Neither proves original b888 nullable/2MBoldstate. PR9e adopted only as explicitly labeled privilege-upgrade fixture; original legacy data-state coverage remainsUNKNOWN andfailclosed. No synthetic historical schema or missingcommit identity fabricated. Portable tests now stay on explicitly opted-in localtarget anduniqueowned scratch DBs.

## CEO historical-fixture disposition 2026-10-29T18:23:41.724477-07:00

Source: Ron's direct chat relaying CEO decision, 2026-10-29. b888ccd is irretrievable; stop chasing. Neither supplied exact-hash variant matches the old nullable/oversized data state, so ONLY the test "a database with the older 20261022180000 upgrades forward, then accepts the same file again" is SKIPPED with reason "historical commit lost". Its body is retained; no substitute historical schema fabricated. The separately labeled exact-hash PR9e privilege-upgrade test passed and remains active. All other checks continue. This is not proof of the untested legacy state or a waiver for other failures, staging checks, independent QA or production activation.

Checkpoint 2026-10-29T18:58:23.481493-07:00: fresh72 versus old32+39+1 logical catalog PASS; ID migration harness restored catalog PASS,7passed/1CEO-authorized historical skip. Preparing exact candidate gate and B003 audited payee scope. Prior missing-code and staging-key suspicions are resolved as recorded above; whole-lane acceptance remains incomplete. STOP POINT: repo ACTIVE B/Ron; next: pinned clean candidate gate on owned loopback PostgreSQL16, then integrate audited payee delta; owner: Ron/Codex.

Local prerequisite checkpoint: gate2e37631 unit524/524 PASS; RLS stopped at obsolete consent timeout assertion (historical SQL already RESETs). Corrected test5/5 and remaining chain0. Five historical-replay files now use owned unique test DB clones; full source catalog+table fingerprints unchanged after all5files. Mirror dry-run originally rejected canonical multiline claim output; parser now requires current effectiveACTIVE, rawACTIVE and exacthost/session. Negative ownership checks passed; dry-run authenticated successfully and planned80refs into currentlyemptyprivateGitHubmirror. No GitHub push yet. New clean combined gate remains required.

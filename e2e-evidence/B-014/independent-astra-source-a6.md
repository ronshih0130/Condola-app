# B-014 revised source review before candidate freeze

**Source GO for isolated a6 runtime only.** Reviewed the working source against the previously tested immutable code `6c9d4d0bdf78436206c57b9e244e42cf225b7a9e` under coordinator ownership `3099AC86-6AF0-4681-9944-304E930BFDC2`. Independent Astra/high requested, actual model identity unobservable. Recorded 2026-11-02T16:48:41-08:00. No tests or DB operations were run by this reviewer.

| Changed source | Git blob |
|---|---|
| `src/server/owner-transfer-input.ts` | `3ae25aa8ecca17dcd6140878e3f075ef0a669dc2` |
| `src/server/owner-transfer-input.test.ts` | `e84cdaebb394d13d756985257b388b1d5332de9c` |
| `src/server/owner-transfers.ts` | `a2f68b993826eb17b3b74ecf80a25e96b9d049c9` |
| `src/server/owner-transfers.integration.test.ts` | `c36eef9478268fe6287984b7000ed8d560ed3f1c` |
| `src/server/owner-transfer-actions.ts` | `2d9f8b6a8c2a996fb9782504a1a7f48d33db9b13` |
| `src/components/owner-transfers.tsx` | `c042fcf1c73bd0e8ae5f7ef06b37210711929b9e` |
| `src/app/m/statements/transfers/page.tsx` | `a0d134c26e05f62f0b1553f4ac005cee62911db4` |
| `e2e/b014-owner-transfers.spec.ts` | `6fdec690a63b29a01a7049232c8bd4c0acd1769d` |

The other 60 source blobs match a5. The 68-entry map has SHA-256 `284661f6faf70199f7acdb99e3811244922478d2c70ce6628281286a8615b584` when encoded as a compact, key-sorted JSON object. Freeze these exact pins and verify them against the immutable candidate tree before running.

- Both transfer and reversal pass the original rendered actor, selected org, live parent and environment. Both service entry points compare them to the fresh canonical session before ledger operations. Matching scope supplies no authorization. Existing staff/role, feature controls, authenticated RLS and per-org locking continue to control admission. Session ID is deliberately excluded from the client expectation so a new session for the same actor/scope can retry. Scope mismatch retains the pending key. Pending payloads restore only when their saved scope matches. Legacy unscoped payloads remain untouched and fail closed; compatibility with pending production tabs is a separate hosted decision.
- The recovery parser distinguishes an absent storage key from parsed JSON null. Both key types reject present null/wrong types and invalid shapes. Missing/invalid scope is rejected. The test plan checks both null keys, original malformed JSON, disabled controls and unchanged ledger snapshots.
- On valid-current-authority inputs, the service checks the exact prior record and UUID collision before checking current owner/date eligibility. Definitive failure before insertion now returns an editable invalid result. Unknown operation, scope mismatch or database failure retains the pending key. Existing committed replay including roster/scale drift remains available under the original actor.
- Browser source covers a genuine cookie switch on a second page without navigating the original mounted form before stale first-submit, restored never-committed retry or reversal. It checks DOM connectivity, concrete command absence, unchanged org transaction/entry/audit snapshots, same-actor retries, wrong-date rejection and selected-account reset. The helper clears cookies on every sign-in. Preliminary spec `bc592c4c58526850eeb039026be4d311f8583e8d` therefore lost the EN locale on the intentional old-page reload. Corrected spec `6fdec690a63b29a01a7049232c8bd4c0acd1769d` explicitly restores the selected locale on the other page and leaves the old tab mounted. The manager layout uses an enclosing div around the transfer main.
- Three new helpers normalize to their exact reviewed a5 equivalents after only the four file-reference substitutions and the first authority-comment line. The prior files remain unchanged. Verified SHA-256s follow.

  - `run-b014-owner-final-check-a6.py` · `4354b01ff80af132f261a5ac0a475e5a1cecadd7cedb8e74d7c3b8fd6a6e265e`
  - `b014-owner-runtime-driver-a6.py` · `a2bfae58823040bb834c422b31d43ef6df52e2b2094d8e1fa07f316369f69e85`
  - `b014-owner-control-readback-a6.py` · `e34d8733407b89e41ed6f82b2df5746a11fa85a27ef20300810a51d3e5f9cf7b`

This permits the coordinator to freeze and run the local suite. It provides no run results on the new source. Keep a5's independent NO-GO and historical unknown/unproven failures intact. Pending free-text privacy/retention, hosted mixed versions, generic/direct writers and final-check-to-commit races, owner projection, financial reporting, staging and acceptance remain open.

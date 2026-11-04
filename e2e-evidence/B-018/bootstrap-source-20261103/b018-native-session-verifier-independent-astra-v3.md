# Independent review of b018-native-session-verifier-v3

**COMPONENT SOURCE GO for a trusted-parent, repeatable-read fixture snapshot only**

## Provenance and clone boundary

verifier.cjs 17–46 now requires a canonical 12-hex run, derived exact local clone DSN, private measured app tree, unchanged source-lock hash, matching candidate and webpack plan. It checks listed Git blob identities and the three explicit canonical helper digests before import, and repeats source checks over the attempt. Parent must independently verify the lock came from the correct candidate, full dependency and loader integrity, empty baseline, real start time and actual exclusive endpoint. A matching digest or a count of paths alone cannot authenticate the lock.

## Actual snapshot and one-shot proof

verifier.cjs 48–89, 132–149 binds the slot to the fixed context/actor/mode before I/O. A failed slot stays consumed, a repeated slot enters the violation ledger, a SID is reserved synchronously and the private HMAC covers the run, lock, exact scope, actor, mode and SID/token evidence. The transaction checks its actual endpoint and read-only mode, selects the matching newly created valid SID and current consent, then commits. The final query shares that snapshot. Live post-drain revocation, expiry, recovery and actor lineage require separate fresh readback.

## Identity and scope controls

verifier.cjs 90–131 uses the canonical staff-first resolution, independently rejects active live/orphan staff membership for tenant fallback, and checks the finite OFF partner settings using separate presence, object type and actual false value. The normalized portal selectors match the pinned session.ts and portal-role.ts logic for these /t fixtures with no lease override. The caller must prove cookie scope and token at the actual measured request, use one verifier instance, and independently consume the final six-outcome ledger. A post-response cookie snapshot alone cannot do that. No standalone verifier source blocker found within this trust boundary.

## Verification

All four manifest members checked. All three explicit helper hashes matched local source. Node syntax passed. Pure extracted pre-I/O logic rejected an incorrect mode, consumed that slot, rejected its retry and admitted the correctly paired separate slot to the next validation. The verifier was not invoked, no application module was imported, and no database, SQL parser, process or network was used.

Manifest d59ece040786ed2a841094237f7d83d74dad758a311163507d30f2022d1eeb98

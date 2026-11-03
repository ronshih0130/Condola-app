# B016 regional company profile proposal v2

**SOURCE_GO** for the frozen inactive proposal. Both v1 source findings are closed. The SQL changes are confined to the gateway runtime setting and the two conditionals. The handoff adds the adapter contention contract. All seven current bindings and all ten archived v1 bindings match their recorded sizes and SHA-256 hashes.

P1 closed. Lines 129 and 133 enclose the complete CASE expression in parentheses, putting the inner THEN below the delimiter depth. Both old-value comparisons and legacy no-op behavior are intact.

P2 closed in the proposed contract. Line 48 sets a 500 ms lock timeout for each gateway invocation. The handoff also requires 500 ms lock and five-second statement limits in the same adapter transaction before admission reads or locks. Exceptions propagate to rollback and a generic unavailable result. These settings bound individual waits or statements. They do not bound total request duration or preserve a tighter caller timeout during the function.

## Scope and outstanding evidence

No SQL parsing, database access, EXPLAIN, migration, feature activation or tests in this review. The required held-lock/rollback test, catalog owner/effective grants, backup and restore rehearsal, upgrade and compatibility checks, and PG17 validation on an authorized non-Mac target remain outstanding.

Service-only gateway invocation, trusted selected-live-org adapter, canonical same-transaction consent, partner, terminal authority and actual commit checks are part of the proposed call contract. Existing raw organization writers and the final authority-read to commit interval remain outside a universal seal.

Members and linked contacts retain the existing base organization read audience. Base updates retain the legacy full-row generic audit. Only the dedicated event is metadata-only, and the extension has private address storage. Actual target ACL closure remains unverified.

The prior self-name local checkpoint, regional application implementation, verified email, fee rules, staging and release are separate. The v1 rejection stays attached to v1, and the frozen proposal header predates this separate source verdict.

**UNPARSED / UNAPPLIED / TARGET UNVERIFIED / NOT APPLY-READY.**

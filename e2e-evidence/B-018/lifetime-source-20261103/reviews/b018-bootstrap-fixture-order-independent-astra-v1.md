# B018 contact-order fixture v1 independent source review

**NO_GO for the frozen fixture.** The one-microsecond correction is checked precisely, but an altered contact or substituted audit can receive an APPLIED_VERIFIED receipt. Six existing pure tests passed. The independent controls below used synthetic rows only. No actual fixture, SQL parser, database or browser ran.

## C1 · The full-row comparison loses typed values on real contact columns

All non-target contacts use to_jsonb(c)::text. The target business comparison uses the same conversion with two fields removed. The real bank_account_last5 text array can have the same elements at SQL subscripts 0–1 or 1–2. Both yield the same JSON projection even though a query for subscript zero distinguishes them. Hashing the resulting text, or comparing the JSON old/new audit images, cannot recover the bound. Other tables use record_send but do not first reject unrecognized or non-injective type senders. The independently reviewed recovery implementation has a type allowlist specifically for this step.

Preserve full typed records for all untouched contacts, use a typed projection of all business fields on the target, and validate actual column and nested element/range sender metadata before any data serialization on the writer. Include an array-bound drift case and an unsupported sender.

Source locations — fixture.cjs 30, 34–39; checks.cjs 19–25; schema 20261018120000_schema.sql 209–234.

## C2 · The audit checked before commit can be replaced before the final receipt

The staged after() proof is discarded. After commit, a fresh audit independently matching the subset of fields is accepted, without comparing its ID or typed wire commitment with the staged record. event_type and occurred_at are not checked even in the first comparison. The real generic trigger omits event_type and uses the transaction time default for occurred_at. A pure substitution of ID 2 with 77, different wire bytes, event_type=sign_in and a year-1900 occurrence passed after() twice. The two accepted audit commitments differed. The checks for old audit wire rows did detect alteration of those rows.

Capture the staged new audit identity, exact wire hash, canonical complete column shape and its transaction timestamp. Require event_type to be null for this trigger. Compare the entire staged and fresh proof, including the new identity and audit inventory, before publication.

Source locations — fixture.cjs 52, 56; checks.cjs 23–26; schema 20261018120000_schema.sql 1526–1541, 1588–1605 and 20261020140000_audit_access.sql 3.

## C3 · An arbitrary target updated_at is accepted as a normal trigger effect

The checks require the intended one-microsecond created_at shift, but explicitly remove updated_at from every independent target comparison. Comparing RETURNING and audit images to the same already-mutated row does not verify this allowed side effect. A pure test gave the target a year-1900 updated_at in RETURNING, the resulting contact and the audit image. It passed. The actual trigger sets NEW.updated_at to now(), the writer transaction timestamp.

Read transaction_timestamp() as database microseconds in the writer and compare it exactly to the target updated_at and the fresh row. Retain the declared created_at-only shift and independent audit time check.

Source locations — fixture.cjs 34–35, 48–53; checks.cjs 19–25; schema 20261018120000_schema.sql 1549–1558.

## C4 · A known writer shutdown error is discarded

A failed or uncertain COMMIT goes to quarantine and a failed read-only close does too. On the successful writer path, however, a rejection from await c.end() is caught and discarded; a later fresh connection with no other backend can allow APPLIED_VERIFIED. Zero other clients at that observation does not turn an observed error into a successful writer close. The parent cannot tell from the reported success that the child observed a shutdown error.

Treat writer close failure as post-commit quarantine, prohibit success publication and retain the durable no-retry fence. Verify successful and rejecting close paths with an in-memory driver. Parent must still await physical process exit and independent drain.

Source locations — fixture.cjs 53–57.

## Scope, lineage and handoff

The six shipped pure validator groups passed on Node v20.20.2. Both source files passed Node syntax checks.

Both tied live tenant-only user-005 rows are selected by role and live organization; the two random seed contact UUIDs are observed and locked. A single guarded UPDATE targets only org2 and requires the exact original database timestamp. SQL uses one microsecond and the verifier compares decimal microsecond strings with BigInt; no JavaScript Date round trip. The pinned primaryOrg orders unarchived contacts by created_at after active membership.

The helper uses exact run/database/environment syntax, the actual owned source-lock path/hash, source-file blob checks, and SHA-pinned clone createdb executable/arguments and clone receipt. The validated seed intent and completed OFF receipt are read with independent input hashes and matched to actual OFF data. The database name, OID, cluster identifier and postmaster epoch are compared between snapshots. The independently frozen candidate/dependency tree, genuine child receipts and the mapping from creation to the physical clone must still come from the parent. The factory resolves the pg dependency before prepare() checks the source blobs, so parent verification must precede factory invocation.

Both baseline sentinels are rechecked, the exclusive fsynced attempt prevents retries, and a validated intent precedes the UPDATE. Unknown COMMIT and failed fresh readback quarantine. Sentinel lookups and samples of other connections do not provide an atomic exclusion lock. The parent must exclude baseline creation and other writers for the full child lifetime, verify exit and physical drain, and only then publish the baseline sentinel.

The supplied manifest and all six listed members matched before and after review. Live behavior and the parent integration remain unverified.

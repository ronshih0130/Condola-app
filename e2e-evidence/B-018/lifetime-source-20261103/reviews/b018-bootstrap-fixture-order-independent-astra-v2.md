# B018 contact-order fixture v2 independent review

**GO for the bounded fixture source.** All four defects from v1 are closed in the reviewed bytes. A one-microsecond shift on the selected synthetic org2 contact is the only planned business change. Its normal update timestamp and audit entry are checked against the writer transaction.

**C1** fixture.cjs 30–43, 49–55 reads column and nested type metadata, invokes the pinned checkTypes, then projects typed record bytes. Every untouched contact includes both timestamps. The one target uses a typed ROW of every catalogued business column including id and bank_account_last5. Other physical tables retain full record_send coverage and arrays retain dimensions/lower bounds. Unrecognized serializers fail closed.

**C2** checks.cjs 24–29 and fixture.cjs prepare retain the staged proof and independently compare it to the fresh read-only proof. Exact audit ID, new and prior wire commitments, full column shape, explicit null event_type and exact transaction microseconds are checked. A different fresh wire with otherwise identical parsed fields failed the staged comparison.

**C3** The writer reads transaction_timestamp() in integer microseconds inside its serializable transaction. The target updated_at and new audit occurred_at must each equal it in both checks. Inputs one microsecond lower or higher respectively were denied. The separate required created_at difference remains exactly 1n using BigInt.

**C4** A failure of the writer end operation records a WRITER_CLOSE quarantine branch before creating the independent read-only client. A rejected mocked end propagated. Rejected/uncertain COMMIT still quarantines and the exclusive attempt blocks retry.

18 supplied pure groups passed on Node 20.20.2 (six historical v1, six ported and six new). Both implementation files passed syntax. Five additional input mutations were denied by the current checks and a rejecting writer close propagated. Manifest plus eight members and both pinned helper modules matched. No database connection, SQL parsing, browser, network or process inspection occurred.

Component source GO at the specified hash. The parent must pin the complete dependency and source closure, bind genuine clone/seed/OFF receipts and target ownership, serialize this writer against baseline/login and other writers, and verify normal physical exit and drain before opening its baseline. Neither path-based sentinel checks nor a client-count sample establish external exclusion.

# Preserved first B009 full-gate failure

Recorded 2026-11-02T10:30:43.651600-08:00; candidate cf928ca63f97093a4a5ada2f4f05adba004da4fe, actualexit1/effective1, no retry/waiver/skip. Unit618PASS; RLS stopped49total48PASS1FAIL0SKIP under existing&&runner. AllothergatestepsPASS. Originalreport e2e/results/gate-cf928ca63f97093a4a5ada2f4f05adba004da4fe.md, private work/b009-gate-cf928ca.log and actualexitreceipt preserved.

Failure: income and expense stay in SQL, per property, owner, and currency, income-expense.integration.test.ts:72, syntheticownername expected butnull returned. Ownedclone observedtoday2026-11-02/payment2026-10-30/reportend2026-10-31/ownerstart2026-11-02. Productionreport correctlyrequiresownershipstart<=periodend. Seed omitseffective_from andschema defaultscurrent_date; seedpaymentcurrent_date-3 crossesmonthboundary. Seed/test/productionloader hashes unchanged frome443; independentSolconfirmeddateprecondition, not B009regression and NOTanapprovedbaselinewaiver.

Nextonlynarrowseededownershiphistorycorrection aligned with existing synthetic lease start, plus focusedactualmonthboundaryincome-expensecheck; preserveproductiondate/owner/money/orgsemantics andallassertions. Newreviewedcandidate/fullgate required. No newschema/migration.

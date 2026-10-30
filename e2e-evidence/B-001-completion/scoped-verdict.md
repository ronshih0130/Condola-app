# B001 zero-total completion and organization rollout — local scope

Recorded 2026-10-29 23:57 -0700. Base `0e49bd0`; status **PARTIAL / NO RELEASE VERDICT**. Under Ron's zero-total decision, a first e-sign completion can activate with an explicit zero invoice containing a real zero line, no amount due, no ledger transaction or entries and no payment. The final signing actor and source are recorded. Existing positive invoice postings remain, and the new additive migration replaces the deferred completion check without changing published 100211. The global e-sign switch remains OFF by default; exact `feature_flags.esign === true` is also required for the selected org. Application writes take the org lock before lease/case; disable races are fenced. This is an application gate, not a universal old SQL or worker gate; drain and separately verify old writers before any pilot.

Implementer ran Node 20 typecheck, targeted ESLint, diff check, and the focused local synthetic PostgreSQL suite: 13/13 PASS (`npx tsx --test --test-concurrency=1 src/server/esign/flow.test.ts src/server/esign/esign.integration.test.ts src/server/esign/esign-privileges.integration.test.ts src/server/esign/esign-rollout.integration.test.ts`). Coverage includes real completion, actor, idempotence and no-ledger zero invoice; missing line/audit marker and fabricated ledger/allocation rollback; positive rent/deposit and utility-only posting; strict flags, roles, direct repo methods and both org lock orders. Existing B007 rejects zero lease rent with positive deposit and was not bypassed. Fixtures use a disposable core85 clone plus 100213 and synthetic-only material.

Highest-tier independent native source review reported scoped PASS for this frozen delta and independently ran the flow unit suite (9/9). Browser signing, staging, legacy writer/worker drain, full G0–G5, React prerequisite/cold starts and independent Claude Class B remain outstanding. No production deployment, flag activation or real messages occurred. Initial draft test failures and a rejected invalid zero-rent/positive-deposit fixture remain in private logs and are not represented as baseline passes.

## Reviewed Git blobs

| Path | Git blob |
| --- | --- |
| src/server/esign/access.ts | 542d540965bc71e8fdf9c5a55c2feaadbced58fb |
| src/server/esign/actions.ts | d8ab4355048af2d1c556f35546d7aec109cde92f |
| src/server/esign/flow.ts | 9e4ecb2beaa937f6357ac04bf71d3a61b37e3de7 |
| src/server/esign/lock.ts | 165c017290f4ad2247b0a893506fa1151e9c52a9 |
| src/server/esign/repo.ts | bdd8195a33e77a073d8faa32ab05160aa04cb59f |
| src/server/move-in-invoice.ts | e8d3cbaed2e6afddc12143a10f901e473dfa9d73 |
| src/server/esign/flow.test.ts | 67859b192f9a085f47eab34e99b8b669808b8e44 |
| src/server/esign/esign.integration.test.ts | 7ebb94a030f298278e3cea4074b87a54049a95d4 |
| src/server/esign/esign-privileges.integration.test.ts | 003fb34a732778e4e8db39f9f1df092a085c1b0b |
| src/server/esign/esign-rollout.integration.test.ts | 5bd4ecbc42c9c7cb30f8bb338d704ad10200949c |
| src/app/m/leases/[id]/layout.tsx | 669baaf0de94b63ab76e053b9acc884e7c86bfad |
| src/app/t/lease/layout.tsx | 75ce43b2dd03ef905649c3fce206b595aaefad65 |
| src/app/o/leases/[id]/esign/page.tsx | b47a4012aa6797fa1089db9ee207810fc97f0473 |
| src/app/api/esign/[caseId]/[versionId]/route.ts | 4a7e55f5c320704f2c49c108060797a396239aad |
| supabase/migrations/20261031100213_b001_zero_first_invoice.sql | ca1ea4de172cb5b8617db198d764a8c9ab17d902 |

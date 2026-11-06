# B-017 governance and local enforcement evidence

Local continuation, 2026-11-06 PT. Uncommitted working-tree implementation for Claude, the architect and sole git committer. No commit/push/branch/checkout/reset/stash/PR, remote database, deployment or external service request was performed. Feature flags were changed only in disposable local fixtures. The original policy-slice evidence remains historical and unchanged.

## Round-1 implementation (historical; superseded by round 2 below)

- Migration: `supabase/migrations/20261107020000_b017_custom_role_governance.sql`.
- Private tables: `app.b017_roles`, `app.b017_role_revisions`, `app.b017_assignments`, `app.b017_governance_receipts`; RLS, no API-role table privileges, immutable revision/receipt triggers, composite org-scoped references and retained unassignment tombstones.
- Mutation gateways: `public.b017_create_role`, `b017_revise_role`, `b017_retire_role`, `b017_assign_role`, `b017_unassign_role`, `b017_change_member`. Read gateways: `b017_resolve`, `b017_assignment_grants`. All eight are SECURITY DEFINER with pinned search_path and EXECUTE only for `service_role`, matching `db.ts`'s `svc`/`svcOn`.
- Gateway lock order: platform flag SHARE admission → organization → native Admin member rows (ID order) → other member rows (ID order) → roles (ID order) → assignments (user-ID order). Legacy member/invitation triggers use NOWAIT when encountering an inverted parent acquisition. A legacy UPDATE may wait on its target row before the row trigger runs. Rejected lock acquisitions require a full-transaction retry.
- SQL and TS grant ceilings, live session checks, strict boolean/allowlist gates, resulting-state usable native Admin and billing-owner protections, direct/indirect self-lockout rejection, SHA-256 command receipt replay/conflict enforcement.
- `readSessionOn` admits custom resolution only for an enabled staff org. Session-aware `can`/`assertPerm` consume the trusted DB authority; session-based permission call sites retain it. Stale revision/retired assignment denies all permission keys. OFF returns the original native session and matrix, including stored assignments. Assigned ON grants replace native grants, as specified by the original restricted-role policy; no assignment/tombstone uses native grants.
- Native Accountant photo capability remains separate from ticket text. DTO suppression, upload/download entry points, staff vendor share/link preparation, photo-view/upload UI wiring and restrictive files/attachments RLS apply the floor. Company audit remains native Admin only, with restrictive audit RLS.
- Registered in `scripts/write-pr-migrations.mjs`, `src/server/lease-rules.test.ts`, `package.json` test:rls chain and `seed.ts` wipe ordering. The migration is classified as non-addOnly for packaging because it installs restrictive policies/triggers, while preserving all existing schema/data objects.

## Round-1 verification (historical)

Node v20.20.2, npm 10.8.2. Fresh `condola_b017impl` on localhost port 55432: dropped/recreated, Supabase stub applied, every migration applied in filename order with `ON_ERROR_STOP=1`, then the supplied local environment and `npm run db:reset`. Governance tests use `cloneTestDatabase()` plus `resetAndSeed()` and clean up their clone. No full `test:rls` run.

| Check | Result | Local log |
| --- | --- | --- |
| All migrations + seed on fresh local DB | PASS | `/tmp/b017-cont-final-migrations.log`, `/tmp/b017-cont-final-reset.log` |
| typecheck | PASS, exit 0 | `/tmp/b017-cont-verified-typecheck.log` |
| lint | PASS, 0 errors, 15 existing warnings | `/tmp/b017-cont-verified-lint.log` |
| copy:check | 6 PASS, 0 FAIL/SKIP | `/tmp/b017-cont-final-copy.log` |
| test:unit | 1,109 PASS, 0 FAIL/SKIP | `/tmp/b017-cont-verified-unit.log` |
| B-017/perms/team focused suite | 193 PASS, 0 FAIL/SKIP; includes 17 new governance integration cases | `/tmp/b017-cont-verified-focused.log` |
| git diff --check | PASS | read-only working-tree check |

Focused command (with the supplied local environment, local DATABASE_URL and CONDOLA_RLS_DISPOSABLE=YES):

```sh
./node_modules/.bin/tsx --test --test-concurrency=1 \
  src/server/b017-custom-role-governance.integration.test.ts \
  src/server/b017-custom-role-policy.test.ts \
  src/server/b017-legacy-compat.test.ts src/server/perms.test.ts \
  src/server/team-invites.test.ts src/server/team-invite-allowlist.test.ts \
  src/server/team-invite-link.test.ts \
  src/server/team-invite-allowlist.integration.test.ts \
  src/server/team-invite-link.integration.test.ts
```

The report-export test calls the real GET handler with the same cookie: 200 → revise → 403 → reassign → 200 → retire → 403 → flag OFF → 200. Photo tests call the real GET/sign handlers and assert 404/403 without a storage fetch. SQL tests check empty metadata/ID/count/audit results for Accountant, private privileges, immutable history and service-only EXECUTE.

OFF compatibility uses the 90 literal baseline matrix decisions against role-based `can`, session-based `can` and `assertPerm`. The OFF resolver trace has exactly one flag SELECT, no custom resolver call/write, and returns the identical session object. An OFF organization can still update native membership while another ON organization's row is locked. Private authority row counts remain zero on rejected OFF governance commands.

Preserved intermediate evidence: the initial inherited implementation passed 192 focused cases (`/tmp/b017-cont-focused.log`). After narrowing legacy member admission to the target org, three concurrency tests waited on tuples before their row trigger could run. Their exact local blocked queries were cancelled; the resulting 190 PASS / 3 FAIL run remains at `/tmp/b017-cont-final-focused.log`. The test now bounds the second connection's lock wait to 250 ms, asserts lock conflict, commits the holder and retries to assert last-Admin rejection. The final 193-case run passes. No failed evidence was removed.

## Round-1 acceptance boundary (historical)

Blocker 3's implementation and requested local vectors are complete. Blocker 4 is partially closed locally. Still open: independent Claude review; complete browser/HTML/RSC acceptance; every operation's queued-write reauthorization and custom-grant operation bridge; all raw storage/service-role routes; both vendor modes/copied storage or vendor bearers; complete genuine-portal and poisoned-authority/old-credential regressions; hosted and old-code/new-schema compatibility on an authorized non-Mac target. Local stubs do not establish hosted behavior. No production release or whole-B-017 acceptance is claimed.

The existing uncommitted `scripts/pack-staging-bundle.sh` change was present at continuation start and was preserved untouched by this continuation. It is listed separately in the inventory so Claude can determine its commit scope.

STOP POINT: LOCAL_GOVERNANCE_PASS; BLOCKER_4_PARTIAL; WHOLE_B017_INCOMPLETE. Next: Claude reviews the exact uncommitted diff and evidence before any commit or target execution.

## Round-1 changed-file inventory (historical)

Inventory includes inherited partial work and this continuation. Hashes bind the reviewed bytes; this evidence file is excluded from its own hash inventory.

| File | SHA-256 |
| --- | --- |
| `20-build/specs/B-017-design.md` | `73199be911e61e34521e8a8ea17021fcd93486e983bd876f78c1ee8e8aed7231` |
| `package.json` | `2d08c859e084f6464fb3e997452179b9504abb4f5b218019240a7f3d519994ee` |
| `scripts/pack-staging-bundle.sh` | `72841e180795cc62c25ffecdba2e78b72b6f3bfa0d0434b1538d30759a47732d` |
| `scripts/write-pr-migrations.mjs` | `9edff46ad68a92e2686bce966157793d8c3449e2f2a252f6dc1187ca30be06ad` |
| `src/app/m/account/page.tsx` | `490f1d9483a024dc444966a0ea081a910b045727b0e9c8232a9af285bd55f6b3` |
| `src/app/m/import/page.tsx` | `e30e45f79579f02983a722fea93ed3e6dd72d66dc741e9f037a3a8d5fa30bef9` |
| `src/app/m/leases/[id]/page.tsx` | `3b6cc3dd257c9a1aed698bd5c4841818d04b29e40fa0be0915f6a5f9c6a65973` |
| `src/app/m/owners/page.tsx` | `1b4288635fc766efdcc37ca780ea035a655589a7a3b2c7c13729139492f83e1b` |
| `src/app/m/payments/page.tsx` | `fe1373864ec0a6c4d983c335ae9570daa2093bd4a80f0c9b708ce64ef50db8d7` |
| `src/app/m/properties/[id]/page.tsx` | `2e82d9f9ccf5332064f3e4345d840eadaf7f757f663b67cf3234ebb640927e65` |
| `src/app/m/rent/utilities/page.tsx` | `a7fbefbe83ff32ffe5c63d9b45e81f48daa01ea80c5fa662f1eb4bc2c840da95` |
| `src/app/m/reports/export/route.ts` | `0099b8865ec65546cf033f846292f9ef6b24795312b084e9d9724d22fb7c9d90` |
| `src/app/m/roles/page.tsx` | `810ed5f923739a323ec4cf87b53928ff97c4713d0a22dafd77f96bf9b9f8851a` |
| `src/app/m/settings/page.tsx` | `8300700c52eb48c800c29fe488aa96e186ae5f8e9c545ff4888775a8fce89558` |
| `src/app/m/statements/page.tsx` | `22d5e09e6e45ff30ab330ea2e46500e3f76997e3c3c62045f6b4dbae9ae2e453` |
| `src/app/m/statements/preview/page.tsx` | `bef6e260e65649b95c4eab3db9638b6ef0b8d85c815223d866c4ac1ceaaea453` |
| `src/app/m/tickets/[id]/page.tsx` | `cba0c308814f176df783a07f22269df6c1732be126f1392989b47fd5d832ee27` |
| `src/app/m/tickets/page.tsx` | `db23d425506b79c2979ba4208ac46c6286027c52bed69974d43b7b1c45adace8` |
| `src/app/m/units/page.tsx` | `073f258416ca376fd28ac10815ad24d01e0c0ca313aecd8a3f2a335220f37dce` |
| `src/server/audit-read.ts` | `744e7da1578ac04971db870630cc7bd30b7c209f2441898154904f88d1e83a34` |
| `src/server/auth.ts` | `fd451b9a22ee66b206f676989cf7ee88c9918bebf81aeb4fa8c72ae311d32738` |
| `src/server/b002-move-out-actions.ts` | `fb3cc05fef1f66961a0410319185f356f13bc2d60dd2f35093ca6934fbbf6b6f` |
| `src/server/b017-custom-role-governance.integration.test.ts` | `afd977d07d8b54ad31c004f04775b1fb79cb0bb7516376bdb2da663722ab309b` |
| `src/server/b017-custom-role-governance.ts` | `942518007ffbe7b34ac3dfa5eac3958d6f1591a8b3ae367cf912d14f1294276e` |
| `src/server/b017-custom-role-policy.ts` | `1c29a9e7a37d7ef685b8060fe72e2b948cb6cd5bb0951901745ed3cef95871b4` |
| `src/server/b017-legacy-compat.test.ts` | `177ad77e5dea688a71516e954a85937751f13befa32ecc57b81f6b252fe8b12d` |
| `src/server/billing-preview-authority.ts` | `4709837246521bba2264c81ad728abc952e3716e65a08ceffba6234804d7ae0c` |
| `src/server/deposit-rules-actions.ts` | `d413e07815ddf2aec8221228661cfbf5ae0e31f4554dddef48737f0f9c3cc986` |
| `src/server/deposit-rules-org-pin.test.ts` | `10244d1c7f95197ed5a69456a1ada8e632b061c8d5fcdbf15c10b3005e24f6b5` |
| `src/server/lease-rules.test.ts` | `fac784f72c77f01da3eea297629574d06a110b8d4649e7d7e8253d33e49d83e5` |
| `src/server/owner-net-ledger.ts` | `3718f0e110e27781f38510a6b14755d44e24f0a66a5e580f290e3f42181d8413` |
| `src/server/owner-transfers.ts` | `b2db74db39fde5d99368f5c22b27cd8518c5f1bbda2954e68dd420b1935bb249` |
| `src/server/pdf-docs.ts` | `a9f4237039ef20257eaed5f19f862fd7bb9107fcea1908ded9476943a5d09382` |
| `src/server/perms.ts` | `49e2ea64c9a5c5f3467b31e02c6bdb1ab82cffd0b596254623afcf63e485b342` |
| `src/server/queries.ts` | `0d73dde3f695034946ee699193090240194d5c7258f57603f81e8f71f61e918f` |
| `src/server/record-archive.ts` | `4dc59746d01e0b1b616c3d6cabc9fb25afdf4aab43ad4c94a6d6ab4518415838` |
| `src/server/renewal-comparison.ts` | `0b28f17db3be4266fd3824f76a87543b840544c845cd122e4f334da67f9ad61e` |
| `src/server/repair.test.ts` | `86a766000e7d941a6727d4fadaccf9852162f54c1856ead7029916f578532ade` |
| `src/server/repairs.ts` | `6b5a57c2af16b7ba79791d507faafb8fe89df2f003a3db6052eb63e5136375f8` |
| `src/server/seed.ts` | `478d7c736646ba2c8299016bf00460d187bf42411df13811a0fd316deaba76a3` |
| `src/server/session.ts` | `cb776d6b432c16b9298c37762077bee875caf71ecbed1ef160279f292c9556b8` |
| `src/server/types.ts` | `7df8ab5a7e5c714b26d3b667f8bb0dc9bb5b7a2a7e2a21182cdef009c49d41a4` |
| `src/server/vendor-repair.ts` | `f560a1b8bbc126feff5f74bc7b103b0a87eb3d5b8d5eaf0f2daac0e989c81024` |
| `supabase/migrations/20261107020000_b017_custom_role_governance.sql` | `603e1bd6e353e806cf8ce63aab4d8b2ff8ecfaa5384c8c1dd8ed52a6f8346a64` |


## Fix round 2 — continuation verified, 2026-11-06 PT

User-authorized local continuation only. Existing uncommitted changes were inspected and preserved. No git commit/push/branch/checkout/reset/stash, PR, deploy, remote database or external network call was performed. Claude remains the sole git committer and independent QA owner. The new migration was edited in place and applied only to `condola_b017impl` at 127.0.0.1:55432 and disposable test clones.

Fresh validation used the supplied DROP/CREATE recipe, Supabase stub, every migration in filename order with ON_ERROR_STOP, supplied localenv, then db:reset. Each integration file ran separately with `--test-concurrency=1`; fixtures were reset between files. Full test:rls was not run.

### Finding to change to regression

Regression line references below are in `src/server/b017-custom-role-governance.integration.test.ts`.

| Finding | Change (file:line) | Passing test |
| --- | --- | --- |
| Reinvitation grant ceiling | `supabase/migrations/20261107020000_b017_custom_role_governance.sql:381`: compare resulting recipient effective grants under retained locks; reject/roll back activation and acceptance even with absent auth.uid() | `:356` retained Maintenance bank grant vs limited Admin; member remains removed, assignment retained, invitation pending |
| Native-role-only APIs/writers | `src/app/api/monthly-rent-issue/route.ts:25,68`, `src/server/monthly-rent-writer.ts:99`, `period-due-components.ts:95`, `domain.ts:339` and all shared flow transactions: current authority before writes/receipt replay, held through commit. Additional durable gates cover repair/photo, handover, directory edit, ID review, manual reminders, payment status and e-sign; ID/e-sign/signed-PDF predicates consume custom permissions | `:415` stale/retired Accountant and unchanged tables; `:530` positive invoice/replay; `:552` shared native flow writers; `:575` real API 403 after observed advisory wait/revocation; `:604` additional native boundaries |
| Route/data mismatch | `src/app/m/layout.tsx:19`, `src/server/queries.ts:26`, `src/server/perms.ts:128`, `src/server/bank-matching.ts:17`: session-aware route and per-reader admission; restricted chrome; bank grant admission | `:392` restricted payments, Manager bank grant, stale reader denial, OFF restoration |
| Sharing wait revocation | `src/server/vendor-repair.ts:567`, migration `:146`, governance helper `:114`: reauthorize after business locks; lock current flag/org/member/role/assignment/session through commit. Dispatch/revoke use durable authorization too | `:436` three observed PostgreSQL lock waits then retire/reassign/revoke, no shared attachment/description writes; `:468` session update blocked through transaction completion |
| Assignment idempotency | `src/server/b017-custom-role-governance.ts:59`, migration `:191`: authorized receipt/conflict handling before current target/grant checks; remove TS assignment preview | `:377` replay after revision/retirement without writes; changed payload/revoked actor denied |
| OFF query drift | `src/server/b017-custom-role-governance.ts:16,33,48`, `src/server/session.ts:183`: deployment admission bypasses extra queries and connections; sandbox completion uses same fast resolver | `:487` exact SQL, parameters, returned values and connection counts against 80b0d6a for session/member/payment/monthly/bank and sandbox completion; qualified below |
| Missing flag registry | `ops/flags.yaml:237`: owner, expiry, internal ring, default OFF, runtime admission kill plus strict platform/org controls | `:481` registry assertions |

Additional continuation regression `:567` proves a queued custom actor loses added grants after durable disable, while native Admin remains authorized. Transaction authorization uses fixed service-role switches and restores the caller's role. Ordinary unadmitted OFF callers issue no B017 statements. NOWAIT lock conflicts require full-transaction retry and never partial writes.

### Final validation

| Check | Result | Local log |
| --- | --- | --- |
| Fresh stub + all migrations + seed | PASS | `/private/tmp/b017-resume-migrations.log`, `/private/tmp/b017-resume-reset.log` |
| typecheck | PASS | `/private/tmp/b017-resume-typecheck.log` |
| lint | PASS, 0 errors / 15 existing warnings | `/private/tmp/b017-resume-lint.log` |
| copy:check | 6 PASS, 0 FAIL/SKIP | `/private/tmp/b017-resume-copy.log` |
| test:unit | 1,109 PASS, 0 FAIL/SKIP | `/private/tmp/b017-resume-unit.log` |
| integration | 213 PASS, 0 FAIL/SKIP, 30 files individually executed | `/private/tmp/b017-resume-<name>.log` |
| diff whitespace | PASS | `git diff --check` |

| Integration file (`src/server/`) | Pass |
| --- | --- |
| `b017-custom-role-governance.integration.test.ts` | 32 |
| `auth.integration.test.ts` | 18 |
| `session-identity.integration.test.ts` | 1 |
| `team-invite-allowlist.integration.test.ts` | 7 |
| `team-invite-link.integration.test.ts` | 15 |
| `b005-invite-audit.integration.test.ts` | 3 |
| `monthly-rent-preview.integration.test.ts` | 7 |
| `b008-monthly-rent.integration.test.ts` | 4 |
| `bank-matching.integration.test.ts` | 1 |
| `b009-bank-match-decisions.integration.test.ts` | 7 |
| `payment-center-events.integration.test.ts` | 10 |
| `payment-result-flow.integration.test.ts` | 5 |
| `payment-result-guard.integration.test.ts` | 3 |
| `payment-result-utility-locks.integration.test.ts` | 5 |
| `b010-payment-decisions.integration.test.ts` | 9 |
| `vendor-repair.integration.test.ts` | 4 |
| `vendor-link.integration.test.ts` | 1 |
| `list-search.integration.test.ts` | 2 |
| `repair.integration.test.ts` | 1 |
| `statement-preview.integration.test.ts` | 9 |
| `lease-create.integration.test.ts` | 4 |
| `property-owner.integration.test.ts` | 1 |
| `tenant-lease.integration.test.ts` | 4 |
| `handover.integration.test.ts` | 2 |
| `tenant-directory-edit.integration.test.ts` | 28 |
| `reminder-foundation.integration.test.ts` | 5 |
| `id-docs.integration.test.ts` | 15 |
| `staff-signed-pdf-route.integration.test.ts` | 7 |
| `esign/esign.integration.test.ts` | 2 |
| `esign/esign-rollout.integration.test.ts` | 1 |

The previous timed-out invocation's logs remain under `/private/tmp/b017-*.log`, including its consent-value and HTTP-status test-harness expectation corrections. Current continuation checks all passed; no failures were waived. Unit/copy totals overlap because copy tests are also in the unit suite.

### Remaining boundaries

**OFF qualification remains open for Claude review:** default absent/empty/malformed `CUSTOM_ROLES_ORG_ALLOWLIST` gives the baseline query/connection path. An org admitted in deployment whose durable platform/org flag is OFF still needs the flag SELECT to discover that state. Therefore a blanket byte-identical trace guarantee across every dynamic durable-OFF combination is **not established**. Deployment admission precedes durable opt-in; disable the durable gate before removing admission. No hosted flags were activated.

The enumerated native API and transactional boundaries above are covered. This evidence is not an exhaustive acceptance of every raw-storage/service-role path in the whole B-017 feature. Independent Claude review, full browser/HTML/RSC acceptance, hosted and old-worker compatibility remain unperformed. No whole-feature/release acceptance is claimed.

STOP POINT: LOCAL_FIX_ROUND_2_VERIFIED_WITH_OFF_QUALIFICATION; next: Claude reviews the uncommitted diff and explicit OFF admission design; owner: Claude.

### Round-2 working-tree inventory (historical; superseded below)

Includes inherited changes; evidence excludes itself. Replaces earlier round-1 inventory for current review.

| File | SHA-256 |
| --- | --- |
| `20-build/specs/B-017-design.md` | `c6b5f4e2c2ef9e41e6e8a5fb8c608d0f1a9f90832ccb985b4861354c248ea3ac` |
| `ops/flags.yaml` | `58656d1aee8ad566d956f3f287240128d7b882a696c0cd104abf1ec0fdc322f3` |
| `package.json` | `2d08c859e084f6464fb3e997452179b9504abb4f5b218019240a7f3d519994ee` |
| `scripts/pack-staging-bundle.sh` | `72841e180795cc62c25ffecdba2e78b72b6f3bfa0d0434b1538d30759a47732d` |
| `scripts/write-pr-migrations.mjs` | `9edff46ad68a92e2686bce966157793d8c3449e2f2a252f6dc1187ca30be06ad` |
| `src/app/api/demo/id-sample/route.ts` | `04be63da4005edca45926a680b9b6c44192ac7099f293cd997a611b91380cb27` |
| `src/app/api/demo/reset/route.ts` | `214303512f034a643bfbf7439bcc4c4b04db487f4537fc86e22786e2b25beef8` |
| `src/app/api/id-documents/photo/route.ts` | `357acff73e8cbe507affeb1fcc3b709aef8ca2a4c4e4223ed4a01f45e746366f` |
| `src/app/api/monthly-rent-issue/route.ts` | `97b068b2ff28c7921d94bf61fac12265f492d998939468d2f0f92fb7d9e352c2` |
| `src/app/m/account/page.tsx` | `490f1d9483a024dc444966a0ea081a910b045727b0e9c8232a9af285bd55f6b3` |
| `src/app/m/import/page.tsx` | `e30e45f79579f02983a722fea93ed3e6dd72d66dc741e9f037a3a8d5fa30bef9` |
| `src/app/m/layout.tsx` | `b6ba663bc225bbf53c11de4fa666d619a7b941517bd7801b94da57b5b9e06836` |
| `src/app/m/leases/[id]/page.tsx` | `3b6cc3dd257c9a1aed698bd5c4841818d04b29e40fa0be0915f6a5f9c6a65973` |
| `src/app/m/owners/page.tsx` | `1b4288635fc766efdcc37ca780ea035a655589a7a3b2c7c13729139492f83e1b` |
| `src/app/m/payments/page.tsx` | `fe1373864ec0a6c4d983c335ae9570daa2093bd4a80f0c9b708ce64ef50db8d7` |
| `src/app/m/properties/[id]/page.tsx` | `2e82d9f9ccf5332064f3e4345d840eadaf7f757f663b67cf3234ebb640927e65` |
| `src/app/m/rent/utilities/page.tsx` | `a7fbefbe83ff32ffe5c63d9b45e81f48daa01ea80c5fa662f1eb4bc2c840da95` |
| `src/app/m/reports/export/route.ts` | `0099b8865ec65546cf033f846292f9ef6b24795312b084e9d9724d22fb7c9d90` |
| `src/app/m/roles/page.tsx` | `810ed5f923739a323ec4cf87b53928ff97c4713d0a22dafd77f96bf9b9f8851a` |
| `src/app/m/settings/page.tsx` | `8300700c52eb48c800c29fe488aa96e186ae5f8e9c545ff4888775a8fce89558` |
| `src/app/m/statements/page.tsx` | `22d5e09e6e45ff30ab330ea2e46500e3f76997e3c3c62045f6b4dbae9ae2e453` |
| `src/app/m/statements/preview/page.tsx` | `bef6e260e65649b95c4eab3db9638b6ef0b8d85c815223d866c4ac1ceaaea453` |
| `src/app/m/tickets/[id]/page.tsx` | `cba0c308814f176df783a07f22269df6c1732be126f1392989b47fd5d832ee27` |
| `src/app/m/tickets/page.tsx` | `db23d425506b79c2979ba4208ac46c6286027c52bed69974d43b7b1c45adace8` |
| `src/app/m/units/page.tsx` | `073f258416ca376fd28ac10815ad24d01e0c0ca313aecd8a3f2a335220f37dce` |
| `src/server/audit-read.ts` | `744e7da1578ac04971db870630cc7bd30b7c209f2441898154904f88d1e83a34` |
| `src/server/auth.ts` | `fd451b9a22ee66b206f676989cf7ee88c9918bebf81aeb4fa8c72ae311d32738` |
| `src/server/b002-move-out-actions.ts` | `fb3cc05fef1f66961a0410319185f356f13bc2d60dd2f35093ca6934fbbf6b6f` |
| `src/server/b017-custom-role-governance.integration.test.ts` | `261cfb1f1f33780e6b11ffbae22e16660b7016eb0a3ead253772f67bfc8aad50` |
| `src/server/b017-custom-role-governance.ts` | `82d854c439aff63d4de2744e03b8ff15f8edf8d96f24f0671fb1a57896cce308` |
| `src/server/b017-custom-role-policy.ts` | `1c29a9e7a37d7ef685b8060fe72e2b948cb6cd5bb0951901745ed3cef95871b4` |
| `src/server/b017-legacy-compat.test.ts` | `177ad77e5dea688a71516e954a85937751f13befa32ecc57b81f6b252fe8b12d` |
| `src/server/bank-matching.ts` | `26970803d8fb745b46ae5994f48a046058d66e898184d51db043407fb2f66b26` |
| `src/server/billing-preview-authority.ts` | `4709837246521bba2264c81ad728abc952e3716e65a08ceffba6234804d7ae0c` |
| `src/server/deposit-rules-actions.ts` | `d413e07815ddf2aec8221228661cfbf5ae0e31f4554dddef48737f0f9c3cc986` |
| `src/server/deposit-rules-org-pin.test.ts` | `10244d1c7f95197ed5a69456a1ada8e632b061c8d5fcdbf15c10b3005e24f6b5` |
| `src/server/domain.ts` | `20fe1207d240d2666c30534e84f6945d4f9225eb78e03c5338a0d995925d4c54` |
| `src/server/esign/access.ts` | `8c6c10429f7b9c0c2b51005c3d621ff3fbf2c0df9cd28f4bd1926bcb0e49a104` |
| `src/server/handover.ts` | `96ce1f1bd581b182e34a1e97b992fee15f1c03d69d0c4625a21bf10f28ce045a` |
| `src/server/id-docs.ts` | `5d17671e19abb30a03348e05e6cebd1e105d80d46c90ca08060933053f9ba78a` |
| `src/server/lease-rules.test.ts` | `fac784f72c77f01da3eea297629574d06a110b8d4649e7d7e8253d33e49d83e5` |
| `src/server/local-reminder-capture.ts` | `b6d495007079aa9b4d572e02f28771f0ec72e207e7ce76093d0ccd0848e110f4` |
| `src/server/manual-reminders.ts` | `aeeb291437c7ae6cc8125e1147bbbf7f08d2109b82aef59f0139ae4a3d450f17` |
| `src/server/monthly-rent-writer.ts` | `a963090cb6e0aed36fdbc294211accc7c2c785a358b229c35836338cea706b93` |
| `src/server/owner-net-ledger.ts` | `3718f0e110e27781f38510a6b14755d44e24f0a66a5e580f290e3f42181d8413` |
| `src/server/owner-transfers.ts` | `b2db74db39fde5d99368f5c22b27cd8518c5f1bbda2954e68dd420b1935bb249` |
| `src/server/payment-request-status.ts` | `2888f05a2962cc10566af4c9e8f73452d59a6f98d4d53c8cb12a5634d7916a16` |
| `src/server/pdf-docs.ts` | `a9f4237039ef20257eaed5f19f862fd7bb9107fcea1908ded9476943a5d09382` |
| `src/server/period-due-components.ts` | `1140552ff4a3ac42cc942af8c857045ee5e397515123552092bc3c78a5913df1` |
| `src/server/perms.ts` | `dc3b2c9d867081526687c7e5f9a8cd8ac38c498551e56d4cc45d2acc7f4ca86e` |
| `src/server/queries.ts` | `b4b8f0065a2f78744a42e361dcc27bc39362ece70315ef8a5c27d843d4ee2837` |
| `src/server/record-archive.ts` | `4dc59746d01e0b1b616c3d6cabc9fb25afdf4aab43ad4c94a6d6ab4518415838` |
| `src/server/renewal-comparison.ts` | `0b28f17db3be4266fd3824f76a87543b840544c845cd122e4f334da67f9ad61e` |
| `src/server/repair.test.ts` | `86a766000e7d941a6727d4fadaccf9852162f54c1856ead7029916f578532ade` |
| `src/server/repairs.ts` | `f13dab50ec97673b61ad5546de9f21ad68f6c34a20832c30331bf06a146dbe8f` |
| `src/server/seed.ts` | `478d7c736646ba2c8299016bf00460d187bf42411df13811a0fd316deaba76a3` |
| `src/server/session.ts` | `29b1204614f7202d6848cc31747fabefe543a2be2d55b9f2172a1958e9e382e3` |
| `src/server/signed-pdf-http.ts` | `230f6488e9a7a77d7458974b059428e7dcea7c93849012c5acf22c8eb1c135d5` |
| `src/server/tenant-directory-edit.ts` | `668be197d26218fee2ca173d5f1c98ed1673ae49a2aa9b854e96336c297eefa4` |
| `src/server/types.ts` | `c2e1bba2ce012b197cf6072ee044f87baea24a0fbfd97ff08586ade1f04018b3` |
| `src/server/vendor-repair.ts` | `08bcb0a8be4c653919e7206d86420c4f97ff7dd1f500329800d7b85098be3bbf` |
| `supabase/migrations/20261107020000_b017_custom_role_governance.sql` | `5b069bf23b1478e11f89d1285cad7e5b5811430651feecfbaef178dd139b2cbf` |


## Fix round 3 — final local continuation evidence

The partial uncommitted round-3 tree was inspected and continued in place. Claude is the architect, sole committer and pending independent reviewer. No git commit/push/branch/checkout/reset/stash, remote database, external network request, deployment or PR was performed. The unapplied migration was edited in place; its only installations for this round were disposable loopback databases. The inherited staging-bundle/script changes were preserved.

### Structural scope and finding disposition

Restriction-only scope replaces prior cross-base acceptance criteria. Effective authority is native ∩ current custom grants ∩ mandatory floors. Create/revise enforce the native Admin actor's effective ceiling; assigning a reusable role also enforces the target member's native ceiling. Cross-base writes are DEFERRED / BLOCKED for Claude to track. No native RLS was widened to permit them.

| Finding | Change (source line) | Regression (governance integration line) |
| --- | --- | --- |
| Zero-grant utility writers | `types.ts:33`; `utility-posting.ts:390`, `:773`, `:917` require mapped/current `leases.edit` after locks. | `b017-custom-role-governance.integration.test.ts:650`: prepare/confirm/void zero-grant denial and observed waits followed by retirement. |
| Directory contacts/search | `tenant-directory.ts:75` requires `props.view`, gates contact projection and SQL search with `tenants.contact`. | `:668`: masked props-only DTOs, private-email search has no match, allowed contact positive control, stale admission denied. |
| Expense cached permission | `repairs.ts:156` and `:157` reauthorize both ticket and expense keys after locking. | `:686`: tickets-only reassignment during real ticket wait; expense count unchanged. |
| Owner transfer wait | `owner-transfers.ts:17` checks `month.close` in `authorized()`, after period lock and before receipts/writes. | `:697`: record, replay and reversal retire-during-wait cases; no new ledger transaction. |
| Bank durable OFF | `b017-custom-role-governance.ts:135` evaluates current native keys; `:148` returns refreshed session retained by callers; native bank role predicate restored. | `:714`, `:752`, plus `b017-entrypoints.test.ts:88`: reject cached Manager added grants, restore cached restricted Accountant native access. |
| OFF sandbox | Migration `:136`, `:162` join live-parent membership. | `:722`: no copied sandbox membership; SQL resolver/authorizer and guard succeed. |
| Cross-base writes | Migration `:238` rejects incompatible target assignments with localized error; `perms.ts:39` and pure evaluator `:75` intersect native rights. | `:733`: Accountant props edit and Manager statement/bank assignment rejection, including direct SQL and forged-session policy. |
| Statement-only page | `src/app/m/statements/page.tsx:28`/`:31` load optional owner/property data only with permission. | `:741`: actual page invocation with only `stmt.view`, real consent/session evidence. |

The extra continuation regressions cover restoration of native OFF authority (`:752`) and explicit unmapped-key denial (`:766`). The original positive invoice issuance, receipt replay, invalid-session, assignment replay, mandatory-floor, last-Admin and observed sharing-wait regressions remain green. OFF comparison still matches literal baseline SQL, parameters, outputs and connection traces for unadmitted requests. Admitted durable-OFF requests incur gate reads; stale custom snapshots additionally resolve current native authority. Sandbox parent membership and current native bank checks are covered explicitly.

The AST inventory has 361 operation mappings and 43 separately reasoned, body-hashed infrastructure boundaries. It enumerates route methods/use-server exports, follows imported call chains, validates literal mapped keys, and rejects unguarded exported Session transaction functions. Type-only exports are excluded; new executable export shapes fail for review. Five static/guard tests pass as part of the unit count.

### Final checks

- `npm run typecheck`: PASS.
- `npm run lint`: PASS, zero errors and 15 existing warnings.
- `npm run copy:check`: 6/6 PASS.
- `npm run test:unit`: 1,114/1,114 PASS, zero skipped/cancelled.
- Integration: 369/369 PASS across the 40 files below, each invoked as `./node_modules/.bin/tsx --test --test-concurrency=1 <one-file>` in a separate process. No `test:rls` full-suite command was run.
- `git diff --check`: PASS.

Fresh local schema recipe: loopback `127.0.0.1:55432`, database `condola_b017impl_r3_continue`; Supabase stub, every migration in filename order with `ON_ERROR_STOP=1`, the user-provided local environment script, then `npm run db:reset`. The requested `condola_b017impl` name was being recreated by another process during setup (observed through local PostgreSQL activity); the isolated name avoided subsequent interference. No other process or its database connections were terminated. Before the final e-sign privilege rerun, only this dedicated disposable target was reseeded.

| Individually executed integration file | Passed | Failed |
| --- | ---: | ---: |
| `src/server/audit-read.integration.test.ts` | 4 | 0 |
| `src/server/auth.integration.test.ts` | 18 | 0 |
| `src/server/b008-monthly-rent.integration.test.ts` | 4 | 0 |
| `src/server/b010-inversion.integration.test.ts` | 23 | 0 |
| `src/server/b010-lock-order.integration.test.ts` | 40 | 0 |
| `src/server/b010-payment-decisions.integration.test.ts` | 9 | 0 |
| `src/server/b014-owner-net-ledger.integration.test.ts` | 12 | 0 |
| `src/server/bank-matching.integration.test.ts` | 1 | 0 |
| `src/server/bank-utility-locks.integration.test.ts` | 4 | 0 |
| `src/server/esign/esign-privileges.integration.test.ts` | 1 | 0 |
| `src/server/esign/esign-rollout.integration.test.ts` | 1 | 0 |
| `src/server/esign/esign.integration.test.ts` | 2 | 0 |
| `src/server/expenses.integration.test.ts` | 1 | 0 |
| `src/server/handover.integration.test.ts` | 2 | 0 |
| `src/server/id-docs.integration.test.ts` | 15 | 0 |
| `src/server/import-region.integration.test.ts` | 1 | 0 |
| `src/server/import.integration.test.ts` | 18 | 0 |
| `src/server/income-expense.integration.test.ts` | 1 | 0 |
| `src/server/monthly-billing-plan.integration.test.ts` | 2 | 0 |
| `src/server/monthly-rent-preview.integration.test.ts` | 7 | 0 |
| `src/server/move-in-preview.integration.test.ts` | 13 | 0 |
| `src/server/owner-transfers.integration.test.ts` | 1 | 0 |
| `src/server/paper-lease-versions.integration.test.ts` | 1 | 0 |
| `src/server/portal-invite.integration.test.ts` | 16 | 0 |
| `src/server/record-archive.integration.test.ts` | 6 | 0 |
| `src/server/renewal-comparison.integration.test.ts` | 2 | 0 |
| `src/server/repair-approval.integration.test.ts` | 20 | 0 |
| `src/server/repair-owner-policy.integration.test.ts` | 16 | 0 |
| `src/server/repair.integration.test.ts` | 1 | 0 |
| `src/server/session-identity.integration.test.ts` | 1 | 0 |
| `src/server/staff-profile.integration.test.ts` | 11 | 0 |
| `src/server/statement-preview.integration.test.ts` | 9 | 0 |
| `src/server/tenant-directory-edit.integration.test.ts` | 28 | 0 |
| `src/server/tenant-directory.integration.test.ts` | 6 | 0 |
| `src/server/tenant-lease-history.integration.test.ts` | 6 | 0 |
| `src/server/tenant-payment-history.integration.test.ts` | 9 | 0 |
| `src/server/utility-posting.integration.test.ts` | 10 | 0 |
| `src/server/utility-reconciliation.integration.test.ts` | 1 | 0 |
| `src/server/vendor-repair.integration.test.ts` | 4 | 0 |
| `src/server/b017-custom-role-governance.integration.test.ts` | 42 | 0 |

### Initial failures and fixes retained

- Typecheck: optional React global cleanup used `delete` on a nonoptional intersection property; use `Reflect.deleteProperty`. Later parameter refresh required mutable local bindings.
- Lint: reserved `module` variable in the new inventory and unnecessary mutable locals; renamed the symbol and retained `const` where appropriate.
- Unit: source assertions updated for the explicit `team.manage` staff key and refreshed photo-session binding; type-only `ActionState` excluded from executable endpoint enumeration. Final unit rerun passes.
- Audit query plan: added restrictive RLS changed PostgreSQL's cost-based choice from record-specific keyset to the existing organization keyset on the small fixture. The regression now accepts either relevant keyset index and additionally requires the cursor in `Index Cond`; no-sort/no-sequential-audit-scan assertions remain. Final touched integration file rerun passes 4/4.
- E-sign privilege fixture: an earlier suite left the one-per-parent sandbox in the shared disposable seed. The unchanged privilege suite passed 1/1 after reseeding. Initial failure retained at `/private/tmp/b017-r3-esign-privileges-initial-failure.log`.

Final local logs: `/private/tmp/b017-r3-{typecheck-final,lint-final,copy,unit-final2,governance-final}.log`, `/private/tmp/b017-r3-integrations/`. Earlier failed unit/lint/setup logs remain under the same prefix; the original audit-plan failure is recorded in the continuation tool transcript and summarized above. These logs are local validation evidence, not independent QA.

### Completion boundary

All eight findings are handled under the architect's restriction-only scope. Cross-base write support is intentionally deferred, not claimed as implemented. Independent Claude QA, browser acceptance, hosted migration review/application and release acceptance remain pending. No flags were enabled outside disposable fixtures. No git commit or external publication occurred.

STOP POINT: LOCAL_FIX_ROUND_3_VERIFIED; next: Claude independent read-only review of uncommitted diff, updated design, regressions and inventory; owner: Claude.

### Round-3 final working-tree inventory

Includes inherited partial work. Evidence excludes itself. This supersedes the earlier inventories for current-byte review. All 144 SHA-256 hashes were read back and matched after final documentation updates.

| File | SHA-256 |
| --- | --- |
| `20-build/specs/B-017-design.md` | `09a225027a15283b7dea8bea1672d9a9ef144db97e9c1e501cc7c454b8f74605` |
| `ops/flags.yaml` | `58656d1aee8ad566d956f3f287240128d7b882a696c0cd104abf1ec0fdc322f3` |
| `package.json` | `338f9bb0d8dda6ab376fb124b8a0d4666067690865425bcb3d622b54809907c8` |
| `scripts/pack-staging-bundle.sh` | `72841e180795cc62c25ffecdba2e78b72b6f3bfa0d0434b1538d30759a47732d` |
| `scripts/write-pr-migrations.mjs` | `9edff46ad68a92e2686bce966157793d8c3449e2f2a252f6dc1187ca30be06ad` |
| `src/app/api/auth/enter/route.ts` | `6d37e063e1117ac450cb4d2551450b68368b718a8b7e45a4e4ba2128eadb1541` |
| `src/app/api/auth/sign-out/route.ts` | `bab405d943fe65b7207e07754e033d1c5445191a825ce861267ee7cb34bd5506` |
| `src/app/api/bank/matching/route.ts` | `4a16d3ec5b801415696a049fc7a21c481fa766eeb6929c4120915d4436fc3b8d` |
| `src/app/api/demo/id-sample/route.ts` | `fd2e12d0b8375071b27fd8a2333e7baaff5660cf03be19d6ceb354725c721d62` |
| `src/app/api/demo/reset/route.ts` | `17e90ab0a99ac9cc418e923868bb0282cb95418e3cc9b9bdeac6e0d21f485480` |
| `src/app/api/env/route.ts` | `f48417ee797daa7f1ae96effffd87a71c8f00fc0969221cf64da056a2892ff67` |
| `src/app/api/esign/[caseId]/[versionId]/route.ts` | `67c86424ecee03f5b72599a9716a65a838808e9b619e21ae2f1b0365d016a963` |
| `src/app/api/export/route.ts` | `b30e53526ad7347a14ab2a8dd8ae81fbbf216009898ff1df94b45345b7295c4a` |
| `src/app/api/flows/[action]/route.ts` | `e0d0b4f8fdb9c545976b404f28c16a35abb9740647d30c2b2e353ee1eead690d` |
| `src/app/api/handover/[leaseId]/[attachmentId]/route.ts` | `fdcc426aea6d424c71666daa408a9b6a7113e5c6822a76d7af57dae9f8536329` |
| `src/app/api/handover/[leaseId]/route.ts` | `23081c77ec1344c0370c6b82f3687fdd0370efa01df11f55b1d081d9ca02b6f8` |
| `src/app/api/id-documents/finalize/route.ts` | `7334b462f58e4995d10616101dc89279289bec49647da06c4bd43ea5dc8b50be` |
| `src/app/api/id-documents/photo/route.ts` | `2b496bb3430c636cf856d0ec7e1f2e8d8c48b58d3fe70e81004c93f58c778ec4` |
| `src/app/api/import/route.ts` | `fc5ff9bd3cb25659b87f355dd5750eee6e91a5535f443c27391d3938ffa7ed7e` |
| `src/app/api/monthly-rent-issue/route.ts` | `e18c6a089b44b28967341ac4bb52b48302f6ae32702b57e06257bc47efa553ba` |
| `src/app/api/notification-center/mark/route.ts` | `f2248c4f3437ecdeae770c67722d70127ec402f0d2060728e8093bb132338008` |
| `src/app/api/owner-repair-decision/route.ts` | `21867c0063e6703f519519133a0175bdf77b50fcb53fe25af56eb0434971d02a` |
| `src/app/api/owner-repair-override/route.ts` | `8ca858a8dfc8a2634453d22bb6f1e801af70c8c8eca384786e1d33508af59e5a` |
| `src/app/api/owner-repair-policy/route.ts` | `55a9cd291d55fa2c6259995e4b9137e6519d544460ded8729448167377afa6cc` |
| `src/app/api/payments/request-status/route.ts` | `2c635353d17dc34bafcadd689bf8da77ec1346251b2738963ff5701fe39c438e` |
| `src/app/api/pdf/leases/[id]/route.ts` | `1b69f1c2688ddef02a6049a33e658a1e3decb00a8b3fd5ad478fb810c0af903a` |
| `src/app/api/pdf/statements/[id]/route.ts` | `fa342a6449ed7fb74c476d6d80886995d444a8fbd671b614f23e83b7594ebdb1` |
| `src/app/api/tenant-directory/edit/route.ts` | `fca571dbfff71bb9c7ce9c129b6a026751a55b7d1b231c847a667cf3462da95d` |
| `src/app/api/tickets/photos/confirm/route.ts` | `e7704a63ba886f28886455bbb28f232bb199879208a669d11c62771021b9de0c` |
| `src/app/api/tickets/photos/sign/route.ts` | `c5017b160ea0098b604dc9c6c9c3173c14da38730640793688f929ec51c3a91f` |
| `src/app/m/account/page.tsx` | `490f1d9483a024dc444966a0ea081a910b045727b0e9c8232a9af285bd55f6b3` |
| `src/app/m/import/page.tsx` | `e30e45f79579f02983a722fea93ed3e6dd72d66dc741e9f037a3a8d5fa30bef9` |
| `src/app/m/layout.tsx` | `b6ba663bc225bbf53c11de4fa666d619a7b941517bd7801b94da57b5b9e06836` |
| `src/app/m/leases/[id]/page.tsx` | `3b6cc3dd257c9a1aed698bd5c4841818d04b29e40fa0be0915f6a5f9c6a65973` |
| `src/app/m/leases/[id]/signed/[pdfId]/route.ts` | `779725e41dfe5ffbad8f0dfbabaaa9c071ce0031cf59b64f5a0e1b28c8a49c53` |
| `src/app/m/leases/[id]/signed/route.ts` | `83fbed63c2830fa7506461e702e5313aa8fcfb400b8de50c9a12399e3a6e8ae1` |
| `src/app/m/owners/page.tsx` | `1b4288635fc766efdcc37ca780ea035a655589a7a3b2c7c13729139492f83e1b` |
| `src/app/m/payments/page.tsx` | `fe1373864ec0a6c4d983c335ae9570daa2093bd4a80f0c9b708ce64ef50db8d7` |
| `src/app/m/properties/[id]/page.tsx` | `2e82d9f9ccf5332064f3e4345d840eadaf7f757f663b67cf3234ebb640927e65` |
| `src/app/m/rent/utilities/page.tsx` | `a7fbefbe83ff32ffe5c63d9b45e81f48daa01ea80c5fa662f1eb4bc2c840da95` |
| `src/app/m/reports/export/route.ts` | `15bda5dc8e694fb4a1fa127c6176a2931b8aa9143caa82dc004ee8cea53b3db4` |
| `src/app/m/roles/page.tsx` | `810ed5f923739a323ec4cf87b53928ff97c4713d0a22dafd77f96bf9b9f8851a` |
| `src/app/m/settings/page.tsx` | `8300700c52eb48c800c29fe488aa96e186ae5f8e9c545ff4888775a8fce89558` |
| `src/app/m/statements/page.tsx` | `e5a6473b14aba512008b882180d1bba3e8d39361e4396ddff3df1f1567d102cc` |
| `src/app/m/statements/preview/page.tsx` | `bef6e260e65649b95c4eab3db9638b6ef0b8d85c815223d866c4ac1ceaaea453` |
| `src/app/m/tickets/[id]/page.tsx` | `cba0c308814f176df783a07f22269df6c1732be126f1392989b47fd5d832ee27` |
| `src/app/m/tickets/page.tsx` | `db23d425506b79c2979ba4208ac46c6286027c52bed69974d43b7b1c45adace8` |
| `src/app/m/units/page.tsx` | `073f258416ca376fd28ac10815ad24d01e0c0ca313aecd8a3f2a335220f37dce` |
| `src/app/t/history/[leaseId]/signed/[pdfId]/route.ts` | `6dc24ade205af3651ed0f9ead711419fc6354ee4739f42bd8c080553f8cd10fe` |
| `src/app/t/lease/signed/[pdfId]/route.ts` | `ad6513943c652a8dc7451837d0ad672ae07c4345e637c757f69cb40f1f13ac05` |
| `src/i18n/en.json` | `cacecb12968519565d320621c434984ba6c0e74cf4559c4fb787de1bde2e57cc` |
| `src/i18n/errors.ts` | `df391b8a4209972227af5bc08cfc3b2a34004a30f4a4e7412bdf61998d60e38e` |
| `src/i18n/zh-TW.json` | `9546b43d3948819b078d8ddaad4e2fbbc3515ce815e29723d27aa14cf9e6f051` |
| `src/lib/idv.test.ts` | `74879e3e7c14802c9b8ef0edfc5d9c113223919ca5bdc8ff8709efc8fb8ccf65` |
| `src/server/actions.ts` | `f2f3d353cfe1d4e9526369e4065e20476188f99730f0a7f402ff1ad21915b8b8` |
| `src/server/audit-read.integration.test.ts` | `4fe4d228435037162eafff7b7640a08fc91d13b7c4a5299055bce0f1f933644d` |
| `src/server/audit-read.ts` | `744e7da1578ac04971db870630cc7bd30b7c209f2441898154904f88d1e83a34` |
| `src/server/auth-actions.ts` | `025790b80cda11e968b7a749408b85d612ac80792c478a21adad72a5c3c93104` |
| `src/server/auth.ts` | `7159ffacb3e6689d2cbed28c819abd011ade1ad669e8b8bdeed3f36669838e38` |
| `src/server/b002-move-out-actions.ts` | `ddd88930e57cbce54022f7e7197de1729dd785d7e993501e088ccb24e91fc673` |
| `src/server/b017-custom-role-governance.integration.test.ts` | `50ef4006e6ad81b23857ff4344f528ee3b0ff9178aae20579eeac2a5d9665b29` |
| `src/server/b017-custom-role-governance.ts` | `73c963b800d0978fa263c1ff4685355452626300fe8736e964011cd7a8c1b08d` |
| `src/server/b017-custom-role-policy.test.ts` | `60635b41dfe180e30559612eab722c1f308a1d0178495d57bb3a0ed8885c0a23` |
| `src/server/b017-custom-role-policy.ts` | `dfe826ad35717b4fe0130be446e750e983e6426749b810703e773d53d9ebd01c` |
| `src/server/b017-entry-permissions.json` | `bffdcef7490fb2007f127e8594dacb9f88c0331a04693bf5df49e44defe2c898` |
| `src/server/b017-entrypoints.test.ts` | `20f57db58752da8c4bfcda2e3f89b20d420c46f67dbf0d33d37f004c433471d2` |
| `src/server/b017-legacy-compat.test.ts` | `177ad77e5dea688a71516e954a85937751f13befa32ecc57b81f6b252fe8b12d` |
| `src/server/b017-non-feature-boundaries.json` | `735b7096cc0f098f7509ccc3b1fc38d3be71746dd3af18f9d69b2b64b4ffa8fd` |
| `src/server/bank-matching-actions.ts` | `bec252555de88908a375060a16d45a1c2ecffc8a24ae64a11b9185ebf0bdca1d` |
| `src/server/bank-matching.ts` | `0111deee871fffb1cce3315b1b724d513db8ad46a66a2d4e118ea1282ea1e762` |
| `src/server/billing-preview-authority.ts` | `4709837246521bba2264c81ad728abc952e3716e65a08ceffba6234804d7ae0c` |
| `src/server/consent-actions.ts` | `df1236e7e415b7d77dd58932431d66767c7792b8614abeef66e859dd926318de` |
| `src/server/consent-entrypoints.test.ts` | `ba2ce54ac17596a48fa6d21a10962a6d20e362216dd6f2f7eb70115d554aea88` |
| `src/server/deposit-rules-actions.ts` | `80cf5e4b7975c364973a788804fcda3507fd3df6ab408b16de28bc880f6fb447` |
| `src/server/deposit-rules-org-pin.test.ts` | `10244d1c7f95197ed5a69456a1ada8e632b061c8d5fcdbf15c10b3005e24f6b5` |
| `src/server/deposit-settlement.ts` | `a1d5eedc1f7d10b9e6c493952a7a4110b72d611526043c342bf5d756e3da40f1` |
| `src/server/domain.ts` | `1daa4a63181c051545e14b3f3a1b1dacda2fe2022106d87aa9e000250fe75eec` |
| `src/server/env-actions.ts` | `cbad3166bab2033a36c9b36a664489c8f0f014fd6af92cea752f47c911c227ad` |
| `src/server/esign/access.ts` | `8c6c10429f7b9c0c2b51005c3d621ff3fbf2c0df9cd28f4bd1926bcb0e49a104` |
| `src/server/esign/actions.ts` | `d09067b4a35a80672534d88e95aebfd2400cad4bd53523a24dffea16d03d6319` |
| `src/server/expenses.ts` | `63ca401fd05e0593bd2f77dd20d9b634b18b368e9f3ebc4553d0875ac3164ae1` |
| `src/server/handover-actions.ts` | `d43f72153b3f11885ea256bb0070939bc8cc508c8afd4246642ce27d314f7f3c` |
| `src/server/handover.ts` | `68d0eafe0d1fb39ec71ff1c5c9d22ac58b8eb557ecdef40aea2a23e0c114d856` |
| `src/server/id-docs.ts` | `9cd750445b809691fec03fca85bcfdf30201779316dd41b0f0de06c2b0332a50` |
| `src/server/import-actions.ts` | `10c931648356b47251b37b2c102a47f6329c209c06071e89c5ff954ec7e024ad` |
| `src/server/import-batch.ts` | `b111b3f5ca29bb48f2d8e2683736a837f243d94a8801a5532adc7b44dc296cdc` |
| `src/server/income-expense.ts` | `1e0d426e7d0f627bec41cd376f550b29077e100530ba70350f012dde4d3c8574` |
| `src/server/lease-form.ts` | `30982608b719d10a71e2d9570d05636677120a9127d0fee395bc6a3412d6d3b9` |
| `src/server/lease-rules.test.ts` | `fac784f72c77f01da3eea297629574d06a110b8d4649e7d7e8253d33e49d83e5` |
| `src/server/local-reminder-capture.ts` | `00a15bd6b7de4c541694d8f2187ea7886c0605c6cb537b89ac456c7b85d89ffd` |
| `src/server/mail-settings.ts` | `8d7aa077c03a75c464535c42bf5c8152a4756bdb4f5a9f6faf8709861a9d5800` |
| `src/server/manual-reminders.ts` | `bbe78905b0b0777f21c6eda23955cb880f136208004b1f1c0033c0d326feb646` |
| `src/server/monthly-billing-plan.ts` | `369d29525c7b1087a7cfb72d71ae998854c187739bd6cdae7abd05fdaff92f4f` |
| `src/server/monthly-rent-preview.ts` | `657d5622d9bac9b643f9a01f9cc41508822829e44cf2da34f7259e99c2d0d1fc` |
| `src/server/monthly-rent-writer.ts` | `002a27507a46f8256682a5a44d4e4d3782467ce180fcc02383a9c75b758899d7` |
| `src/server/move-in-preview.ts` | `9467e42c89018d18d04aac13344db8ed82093eefa6122cfe600f14a76ba5a450` |
| `src/server/notification-center-actions.ts` | `ece283d173a1e555cd2a429538e70da020354587ddd4ced7be682c14dac3a99a` |
| `src/server/onboarding-progress-actions.ts` | `44f86f69e5562d6a897fbcc1c086cb4ee51c8b60cd07255c6129869e19f73e73` |
| `src/server/owner-finance-replies-actions.ts` | `9596e207dc99872d47111e23c5488cd5ef6b1771ac533efa38422d48c906f67c` |
| `src/server/owner-finance-replies.ts` | `dd37895a06512a7e0207179097ad97f17036f3dc7a4fed6f8f73bd918a72c4ad` |
| `src/server/owner-net-ledger-actions.ts` | `c3344290b366679e105e5e96f80faed018c357922b54ef569755ef14bf6a3a1c` |
| `src/server/owner-net-ledger.ts` | `4243ee6474bc7a4c75493234ff99222e17a72d77cd36deecf9421fddc9b6ad4b` |
| `src/server/owner-transfer-actions.ts` | `7259af639f59f93d67efeebf345e1415f1d2299262d498c5a32b3d3c66a413ba` |
| `src/server/owner-transfers.ts` | `497091f355178cc599d6c74c7f1fcc4fcc84b8757a1ec70ae166c8207ebee898` |
| `src/server/paper-lease-versions.ts` | `5bf148cca74442ea8b6e93be8188b5943cdbbed8cf7c77eea169630779b8fbc0` |
| `src/server/payee.ts` | `b9fe05744901f7c1211d8b86214dff1451a7ddded0b65b87d095ff5569f328e6` |
| `src/server/payment-request-status.ts` | `60e9a7149a25fa9af8622a309574b778a228f238603d62b832a2e664423ce34d` |
| `src/server/pdf-docs.ts` | `a9f4237039ef20257eaed5f19f862fd7bb9107fcea1908ded9476943a5d09382` |
| `src/server/pdf-download.ts` | `ec85460d0e1acb499651d417dbb0126997c27413af1e5a4d904be51181c77a20` |
| `src/server/period-due-components.ts` | `711fff036e8208ab355d11a12afb55471f046b5c6970b2bb93d444e05f184954` |
| `src/server/perms.ts` | `63e86d1295d5db7dfda4886bb2b7fda85deec0162c298ee49310faa45748b7c5` |
| `src/server/portal-invite.ts` | `1252effe072f650e25098c15b6af01e7d7eb947acaa5e9caf0029937256cfe28` |
| `src/server/portfolio.ts` | `545c6640bcd82c768fa779d2a61835bd91e533cdedf671d6cfc4510f539a1f4d` |
| `src/server/queries.ts` | `d61737a3df17816819bc71e0bf1efdb3783328574a2f40e15acea672de0cf44f` |
| `src/server/record-archive-actions.ts` | `c6743dd563628efa087f12b9b9f560c593ffb39f4c97e3cdd0a7db85fcec89c9` |
| `src/server/record-archive.ts` | `9fc82560316fed15afb4e50d24e32fffa9fb3ed2df193d7ec9a60b0e2ec42a23` |
| `src/server/reminder-actions.ts` | `2ec96a71693d306e331b5d885efccce12c197b6b2f29d9f15a3cd516c3026136` |
| `src/server/renewal-comparison-actions.ts` | `77a916a38bcdd3732e23e3b064d791fbb55d49c7468c762684eea9dcb3c4e103` |
| `src/server/renewal-comparison.ts` | `995d6f324e85e84f500cbf18c25d4d2aa85527f852ad2d76573294904a928686` |
| `src/server/repair-owner-policy.ts` | `8a920257fb1f5f5276d49eb796087334a2b00f3720e95bc41c28dec5a1f9a1f8` |
| `src/server/repair.test.ts` | `86a766000e7d941a6727d4fadaccf9852162f54c1856ead7029916f578532ade` |
| `src/server/repairs.ts` | `b3d3b1c1b77d2975d8dfc30e0ad2765696d02279d0644c41b0b20a5e79abd564` |
| `src/server/seed.ts` | `478d7c736646ba2c8299016bf00460d187bf42411df13811a0fd316deaba76a3` |
| `src/server/session.ts` | `29b1204614f7202d6848cc31747fabefe543a2be2d55b9f2172a1958e9e382e3` |
| `src/server/signed-pdf-http.ts` | `230f6488e9a7a77d7458974b059428e7dcea7c93849012c5acf22c8eb1c135d5` |
| `src/server/signup-actions.ts` | `889eff985fbcbbe6a892278f487baef7ad8d3e9103b20ca0546482d88200aa56` |
| `src/server/staff-profile-actions.ts` | `45a358753b1c323f8cc72eb2e0f800dad7bd624ebae233e57fed6db1564befbb` |
| `src/server/statement-preview.ts` | `71932b3a2df3720b7f8233b368cbe32bc55b47fcb78ecc53412b4bebbe3f822f` |
| `src/server/team-invite-link.test.ts` | `31a787375fb3b9ca713c3f6d01f580b05056d4f3afd083381cd850fe978e2f3e` |
| `src/server/team-invites.test.ts` | `f95847a79845165d2f998ff28a8363c90d0a4b1c4c6b7800bee12b849d22fc7e` |
| `src/server/tenant-directory-edit.ts` | `3f62a4b240ba575a47f3fd7061001eb308dc287dd7b8c0d0e4dad842728d8b3a` |
| `src/server/tenant-directory.ts` | `b327ac8e007f37663d6c9b4639ef1955e637e132d6a220e209997ed15dbbf56c` |
| `src/server/tenant-lease-history.ts` | `9cdd4bd3bf28b190f108f3e069f7f2700c07e90322ecc7c7f6e80414963cf62b` |
| `src/server/tenant-payment-history.ts` | `8db83265cd5a048e898d05c5f53552789a20e632d0ff72d64f4726a39691fede` |
| `src/server/ticket-photos.ts` | `2c7aba3437973538ce2a364d54e8aa5d90c872c52ffdee114c0b6a795eb9931c` |
| `src/server/types.ts` | `9b61cd4c833fdfd5725195fa359954413258c96b0afbacb648e211608c6e8c63` |
| `src/server/utility-expense.ts` | `6dfba2cee3d7260c707ac0e24f64769e6aa52f4633a5cac8796c9782f6165db8` |
| `src/server/utility-posting.ts` | `ebab31fef127ec8c11df18d726a1e66a7cab904093dc947b9604abaf455de487` |
| `src/server/utility-reconciliation.ts` | `2e0c5a846750cc2ca30bfd69a8ba224d6334e2e79c45dcc6aeaddaba1718e0dc` |
| `src/server/vendor-link-actions.ts` | `86ad6df966ab0c0ef5334197f0a0b10af7ad66f8f3fc69b587715c989be3a3c1` |
| `src/server/vendor-onboarding.ts` | `ffbdbe7d7e615958342c3aa5e4ba4a30231733f0313db98f07787e419a33031f` |
| `src/server/vendor-receipt.ts` | `7f42143327b63501cd6389482350ab6eb538f15d4f0216c97d8241d05d9ce28f` |
| `src/server/vendor-repair.ts` | `dac7a4b3eff71f237b5c72e9ddd022a3eb5d48eade8b17e8a08ab2a7680a576c` |
| `supabase/migrations/20261107020000_b017_custom_role_governance.sql` | `8d3d27e6e83a20fd5604f0c89f3c938fd51face15e6a7b9e6b47d34d8b0e0366` |

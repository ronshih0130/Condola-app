# B019 local research checkpoint — PARTIAL / NO GO

Owner-only, disposable-loopback-clone prototypes and test support. This checkpoint does not contain a deployable B019 migration, financial writer, production API, successful COMMIT, provider or delivery. The separate untracked working 19 migration is deliberately excluded and is not frozen; several tests depend on that draft and cannot be reproduced from this commit alone. No Origin push or staging/product acceptance is implied. No source-91 runtime includes this work.

Source files below are Git blob SHA-1 values. Native independent reviewer provided scoped static reviews of individual prototype slices, not an independent rerun or broad feature acceptance. The independent reviewer confirmed scoped static PASS for the final byte/store SQL `ad4f628b22196d27d6b1d68b6ba9f5daf06eb20c` and ACL-expanded test `a3b31812dadf88d65a87dc03f408b6cafd697ad1`; execution remains author-attributed. Author-run counts and log hashes below are attributed execution, not independent execution.

- `773ce4a8680299e4d23d7f29d80be2217cd605db` src/server/b019-admission.integration.test.ts
- `e8c467ea38128b5d63369a383a21fa18958608a7` src/server/b019-command-digest-prototype.integration.test.ts
- `22dc3ceadd23078fe348e897cc497117dc27e56f` src/server/b019-command-fence-prototype.integration.test.ts
- `3c59c7a317e469b6f1aebb4c5a21b166ce9d1f9c` src/server/b019-financial-proof.integration.test.ts
- `17c89e41f33bff7babb9bde0c63861d1735eef65` src/server/b019-full-seal-prototype.integration.test.ts
- `dfdcea8dc814dcd2b4ee6885df3ec08aba92593f` src/server/b019-full-seal-prototype.sql
- `f397536ab1ffee2706148f5e2829d1df73fd0e2a` src/server/b019-manager-begin-prototype.integration.test.ts
- `f7901fd28fa7dcccc883822458bbbf7f4185915c` src/server/b019-manager-begin-prototype.sql
- `a3b31812dadf88d65a87dc03f408b6cafd697ad1` src/server/b019-manager-byte-command-prototype.integration.test.ts
- `ad4f628b22196d27d6b1d68b6ba9f5daf06eb20c` src/server/b019-manager-byte-command-prototype.sql
- `92ef857346a57db221e242c5dbe035b222bfa163` src/server/b019-manager-canonical-prototype.integration.test.ts
- `c4193cc7b98d19e99a9d2c3f52857eb87cd3148a` src/server/b019-manager-fence-prototype.integration.test.ts
- `49cb78246c3378424191e26c6768c0fbc2533eab` src/server/b019-manager-guards-prototype.integration.test.ts
- `8680cc3d26c2262c324b3762a8562a445d60a0b9` src/server/b019-manager-poststate-prototype.integration.test.ts
- `50e78bffc1285d804d029b9a857712a2f56446a7` src/server/b019-manager-poststate-prototype.sql
- `68f22e316d341a28d34c1213fb00a09573599662` src/server/b019-seal-prototype.integration.test.ts
- `58f7463248b7cbf568ce64909cbca24d60a33e86` src/server/test-support/b019-manager-canonical-prototype.ts

## Author execution and retained local evidence

Logs are outside Git under `work/B017-draft-evidence/`; SHA-256 hashes bind local files. Tests use owned clones, temporary demo keys and local PostgreSQL. Counts cover only the named test files and explicitly synthetic setup.

- `ea65d7ddd84c667e33f5ab95f0ac954635171f6a5a6ba38a8c03a4b2f057536a` ../B017-draft-evidence/b019-admission-draft28.log
- `ea84cd37cb48ef213454d25d4e60d98a0fb22a7b30e6233e302f2202ad7fce5f` ../B017-draft-evidence/b019-seal-prototype-draft10.log
- `16e66a22387ffa89b7ca2323c19dc5d71e70374bb9045c3553a2db382cb7233c` ../B017-draft-evidence/b019-full-finance-draft33.log
- `b1e78f474acdd579ad147b8887fd07df81ca00f2b9850a15af8394f6e42eeab6` ../B017-draft-evidence/b019-manager-fence-draft5.log
- `176347e6b9c7ef782e8fe78049cbbe3bd2619ce4ca907c9dd008d7bd54c925e3` ../B017-draft-evidence/b019-manager-guards-draft2.log
- `d70ac8cecf9abe1c5ba861fbfdbd490c364026913ccf71de130277e59f2b6a45` ../B017-draft-evidence/b019-command-digest-draft2.log
- `282f52189069f0c56e6c97af95eb2119ff4f406ef6ec0ed4f563ca229d564191` ../B017-draft-evidence/b019-command-fence-draft1.log
- `a244f5a6fa76c6a863886a709456bbb67a95059fd7b9842fceee41f73048f4f0` ../B017-draft-evidence/b019-manager-begin-draft10.log
- `1eb7f65e11bcb27ce791a5d2babbdfdb736142c91b8d46ae306c5af8fa84f58c` ../B017-draft-evidence/b019-manager-poststate-draft15.log
- `a79e18a1723f8475accb5345e63d2d09219ec737941ace23408a1a3e7005c084` ../B017-draft-evidence/b019-manager-canonical-draft4.log
- `d23cf97d88f8da9f47d5e2757dbd12db983dfc3bd5dff9e52ac633740fc5c3fa` ../B017-draft-evidence/b019-manager-byte-command-draft16.log
- `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` ../B017-draft-evidence/b019-manager-byte-command-typecheck4.log

Respectively: 18/18 admission, 8/8 lifecycle, 17/17 combined seal/financial research, 4/4 local fence, 1/1 synthetic guard, 2/2 digest research, 2/2 command lock, 9/9 begin, 1/1 poststate, 3/3 canonical and 5/5 byte/store; final typecheck passed. Different runs bind their own then-current files and do not transfer coverage to changed candidates. Failed setup/fixture logs and the early-SET mutation/expiry counterexamples remain separately preserved in the same evidence directory; representative failed-draft hashes follow.

- `9af867b297f79d77ca22a2f10415c3dc6c0afa4596ebcc779770ef8f9f0fd044` ../B017-draft-evidence/b019-manager-byte-command-draft1.log
- `7cde768560f9d3d2a2479bf67c52d151979c30bd50c7bf0d2d8ffe59b8acc4de` ../B017-draft-evidence/b019-manager-byte-command-draft7.log
- `64a4d41426d0333617a622a27e10c1ea5fd7a8ebe00d61a6b583b54a36842f97` ../B017-draft-evidence/b019-manager-byte-command-draft11.log
- `93bd9cdb0494db1adec601a23e9953173581f21eb2a2f2feaf8219fe42bbea3f` ../B017-draft-evidence/b019-manager-byte-command-draft14.log
- `f7068ae56f03ebe5874ef747e5830c6217d17ce414f8a511250c59f1cdb7b30c` ../B017-draft-evidence/b019-manager-poststate-draft1.log
- `e12ec4123fd757c54adc26e633d0e1591dbd5ae3bc75b943e57fdd7fc0f7d06f` ../B017-draft-evidence/b019-manager-poststate-draft2.log
- `4a5575dc9061fa516dacc2011c664f8f64dfc193b31139ff820200dd8beb36dc` ../B017-draft-evidence/b019-manager-poststate-draft3.log
- `e8ad6fae5a209c0d628467d29fec1bc4e9e3ea6aa9dfc5a66147f2f888fb1c0c` ../B017-draft-evidence/b019-early-mutation-probe.log
- `e5734b4174e8d3988548d988164bbdf43d61cf6614d010b3e7ae82421fdc0963` ../B017-draft-evidence/b019-early-expiry-probe.log

## Material limits

No public writer or fixed production transaction is wired. Prototype operation inputs and historical replay fixtures are owner-synthetic; one committed neutral fixture deliberately uses a payment without a ledger. A test's reversed status is not a ledger reversal. The byte helper preserves old JS serialization for tested scalar input and raw UUID case; unpaired-surrogate, NUL, date, form/API differences and safe-integer bounds remain explicit local unsupported/compatibility questions. Current byte-bound store is owner-only, not a public service authority; JSONB semantic equality does not prove canonical byte encoding. One-way digests are not anonymization. The legacy request table remains the sole intended durable command authority. Same-XID command guards are only clone-local; complete proof-resource, recipient, source and writer guards are not installed.

The allocation/ledger comparisons are separate diagnostics, not a trusted finalizer. The existing actual allocation helper in the byte/store test remains blocking/unbounded. Full immutable DB-derived prestate, cohort/absence and parent/FK fencing, exact source/event and recipient issuance, current authorization, fixed one-operation wrapper, post-flush final read-only validation, durable commit acknowledgement, reset/retention and final 100216 compatibility remain open. Early `SET CONSTRAINTS` research exposed stale-payer and expired-session commits in an abandoned exploratory validator; those failures are not fixed by this checkpoint. The working migration remains deliberately fail-closed.

The locally accepted caps (1024 invoices/headers, 4096 payment allocations, 8192 entries/lines/related allocations, 16384 resources) are diagnostic unsupported-overflow boundaries, not product limits. Seven broad table fences and the separate command-table fence create unrelated-organization contention; no staging/product lock budget or global-deadlock guarantee is approved. Full B010/B028 producer, notification, and user-queue scope remains unfinished.

## Local companion: lifecycle, cohort and ledger research

The later four-file test-only candidate supersedes the corresponding prototype blobs listed above. Its exact blobs are: byte SQL `f0176b6896f72f31e54e6944f8f68f02e9c467db`; poststate SQL `2558486d5c6756ceddac50a9e931378e69adf746`; byte integration test `31169907553a544e55be2d15dfb8d0f27d37f9de`; poststate integration test `22cb15ef239b78be5ca0a212306a9ef1751eb920`. The independent highest reviewer gave scoped static PASS on lifecycle, candidate anti-join and local ledger guard deltas; no independent execution or feature-wide verdict. Author execution: byte 10/10 (`work/B017-draft-evidence/b019-manager-byte-command-ledger-draft2.log`, SHA-256 `342a4dd92bb739b57ac68ac90328a4b704c54cbcd6cd1c4ab68e70993a4b787e`), poststate 2/2 after the byte SQL change (`b019-manager-poststate-ledger-draft1.log`, SHA-256 `9cfa6850b7601a6a7f6fd958d23cdadb1b4525c36fb1f43cba1a70bdcf1aa152`); typecheck passed (`b019-manager-ledger-guard-typecheck.log`, SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`).

This local candidate uses one owner-only current-XID operation, fixed internal permits, begun→ready→stored phase, zero-input captured resources and scoped private-row immutability. Fault tests check permit/proof/command cleanup and reauthorized repeat without recapture. A request to set all deferred constraints immediate is rejected and rolled back; no successful early flush or COMMIT is shown. Its separately accepted typed `last5` handling preserves raw request bytes/digest while matching actual character-column assignment for tested values; synthetic USD is not real API compatibility proof. Owner can forge private permits, and input/action/date/NUL, full authorization and full provenance remain unresolved.

The candidate adds local same-XID allocation, invoice-line, payment, invoice-scope, command and helper-ledger header/entry guards. They cover only tested operation/candidate resources; cross-org matching source ID was allowed in an owner-synthetic fixture, not validated as real financial lineage. Actual `post_reversal` was denied with no surviving reversal rows. The final-state candidate anti-join catches newly eligible zero/positive-balance invoices while allowing a captured invoice paid in full. The old pre-store phantom (draft25 SHA-256 `ebe0b83e15244841220ff31ff3f44587e281ec249cebffff4c235d889e15cb64`) and old standalone store-before-comparator counterexample (draft18 SHA-256 `7eb1bcbb110f6d72e9df0e48a7cf8083f7ae91613b9f504b0c0bc8c79ed503e1`) plus post-store unguarded allocation counterexample (draft20 SHA-256 `96d230e85a227b3d69fcaa6fdc0a8855a41322b56cf30f0d7eb6cc21076837c4`) are preserved as historical negative evidence, not current success or full proof.

The actual helper still uses existing blocking/unbounded invoice acquisition; snapshots and dependency field inventories are incomplete. Transient history, unrelated old writers, source/recipient entitlement, organization/session/contact and all other public/private guards, immutable trusted app authority, retention/GC, final wrapper and current-auth/financial decision, durable commit acknowledgment and full compatibility remain open. No global concurrency, financial completion, production delivery, staging or release approval is implied. The separate working 19 migration remains untracked, excluded, unfrozen and fail-closed; tests that depend on it are not reproducible from this checkpoint alone.

## Local companion: session/member and guard admission

The next local-only research delta supersedes the byte-command prototype pair above: SQL blob `75d13c5c3ed79910ed861635e4fda426f3cd423a`, test blob `727c63b0c14c747b28d8ea6f5264887ae13ac4b6`. Poststate SQL `2558486d5c6756ceddac50a9e931378e69adf746` and poststate test `22cb15ef239b78be5ca0a212306a9ef1751eb920` remain as above. The independent highest reviewer gave scoped static PASS for exact session/member and guard-NOWAIT deltas, not an independent rerun. Author-run byte 14/14 log `work/B017-draft-evidence/b019-manager-byte-command-context-draft3.log` SHA-256 `2fa62ea3afc0c86c6f885f51af38f0690af13e8ed79cb18d9eed7f500bfa56de`; poststate 2/2 `b019-manager-poststate-context-draft1.log` SHA-256 `ab447ab31ecf753e7136ce177dd04ff523f6b17fdd99b52d341bc523caf0417f`; typecheck `b019-manager-context-typecheck.log` SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

In this disposable-clone experiment, session and live-org-member guards check OLD/NEW protected identities, while existing guards perform explicit private-relation ACCESS SHARE NOWAIT before lookup. Tested exact-error denials include same-XID post-store session revocation/expiry/deletion and membership suspension/reassignment/deletion, with unrelated controls. The actual session.ts touch UPDATE statement—not full `loadSession` or browser—is tested against local admission in both lock orders; actual membership suspension is tested in both orders and after commit. Empty-op unrelated payment/session/member writers face a private-table exclusive lock and return explicit NOWAIT error, rather than waiting for the 5s fallback; reverse order also conflicts. Prior counterexample before this correction is retained in `b019-manager-byte-command-oldwriter-ddl-draft2.log`, SHA-256 `5b731ccf385042855f6d387eea1e82a0ebf9517e56a568d4cfa2f92a6f71c210`.

This is not a deployed guard or proof of all old-writer compatibility. Session membership in the database does not prove which organization the trusted server actually selected; event-time recipient principal, lease/property/contact/party/control guards, full dependency seal, fixed finalizer, safe complete financial operation, successful flush/COMMIT and operational rollout remain open. It does not change or include the untracked fail-closed 19 migration and is not independently publishable as a feature.

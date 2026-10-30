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

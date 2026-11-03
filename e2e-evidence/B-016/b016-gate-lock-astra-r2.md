# B-016 independent gate lock correction r2

**CORRECTED_GATE_LOCK_SOURCE_GO.** GO for root to authorize the first actual standard gate using the exact corrected lock hash. The corrected lock has not been executed in this review; gate, builds and wider acceptance remain pending.

The previous independent freeze review checked 1,012 committed files but missed a required gate-lock key. R1 actually exited 1 at the incomplete-lock check before setup, so it was not a gate run. The failure record, source ordering and absence of any generated run directory, worktree reservation, persistent gate claim or fixed gate summary agree. R1 is preserved.

R2 adds only ops/toolchain.json. All prior pins and lock metadata remain identical. The added file pins Node 20.20.2 and npm 10.8.2 and matches both the commit tree and working bytes. Independently verified all 1,013 pins and all six mandatory keys, the reviewed helper hash, current HEAD and a wholly clean checkout.

- Candidate `5a0c6990e4b4b75bb0ab2534cc7742d46c608787`
- R2 lock SHA-256 `97b363ade6cbe3fc755ebe65212215762f9ca864281cd71caae8128498e3d85d`
- Added toolchain blob `fb03abaaa73a722b057c569022f618839c477051`
- R1 failure record SHA-256 `5aad6d748f76016c8422c36463a77a3485b1eba90a61017c03dfc5eebb041fa8`

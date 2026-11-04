# Stopped source-only parent v2

STOPPED INCOMPLETE. Manifest SHA-256 546c8154bec0527979745c9b5106830efcea6d832879726057d24f67e2af3e6c. No component source GO or runtime authorization. Previous artifacts and failures remain unchanged.

Public draft APIs: owned.private_directory, read_json, write_json, OwnedChildren.start/wait/stop/receipt; materialize.materialize_sources, copy_dependencies, tree_pins; private_ipc.PrivateExchange and encode/decode; phase-worker exports readFrame, writeFrame, parseStrict, checkedFile, verifyApplication, verifySourceBlobs, validateClosure and run. Worker CLI retains six args: phase, plan path/hash, source-lock hash, input FD, output FD.

Lock must bind exact phase modulePins plus parentSourceSha256, sourceBlobs, phaseApplicationInventory and phaseRuntime {nodePath,nodeSha256,networkGuardPath,networkGuardSha256,execArgv}. Exact execArgv is --require approved pinned network guard, then --import appRoot/node_modules/tsx/dist/loader.mjs. Only owned .next and next-env.d.ts are excluded from the immutable application inventory; parent must attest their provenance.

The current process primitive does not signal or stop a live group. Persistent server shutdown requires a separate reviewed adapter; no drain or natural-exit claim is made on uncertainty. Detached browser ownership, complete controller, final source/journal reconciliation and independent post-drain recovery remain unfinished. File/FD ancestry, module import closure, generated-output boundary and natural-exit semantics require independent review.

Before stopping: Python 12 pure/temp tests passed (3 unchanged original and 9 adversarial); Node syntax and 6 pure/temp tests passed. verifySourceBlobs lacks its own direct test. No application, child service, browser, database or network runtime was launched. The earlier py_compile attempt failed when it tried to write a cache outside the workspace; later syntax checks used in-memory AST and no escalation.

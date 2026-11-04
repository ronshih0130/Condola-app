# Independent review of B018 parent primitives

**NO_GO for the four reviewed drafts.** A receipt was published through a replaceable symlink, an unreadable dependency subtree disappeared from a successful inventory, and an unreaped synthetic leader received an empty-group receipt. All reproductions used private temporary files or in-memory mocks. No real child or group was started, inspected or signaled.

## P1 · A published private receipt can be a replaceable symlink

write_json closes the validated temporary FD, then links its current pathname and reads the destination by name. In a private temporary directory I interposed replacement of the temp file with a symlink to identical bytes between close and link. The real writer returned the expected digest for a destination that was a symlink to a separately writable, mode-0644 file. read_json and checkedFile also inspect a pathname, then reopen it without binding the opened FD to the checked object. Path rechecks on the module pins have the same gap. The hashes authenticate bytes seen once, but the published pathname and permissions do not survive this case.

Anchor the canonical private directory and file handles. Verify the no-follow published name identifies the same device/inode as the owned FD through publication, fsync and final readback. Use the same FD for type, owner/mode and content verification when reading. Fail closed on directory/file substitution.

Source locations — owned.py 22–34, 48–74; phase-worker.cjs 9–12, 46–49.

## P2 · Dependency enumeration can succeed with an unreadable subtree

os.walk uses its default onerror behavior. It records the directory entry, then silently discards a scan error for its contents. In a private directory, an existing regular file beneath a mode-000 directory was absent from tree_pins with no exception. When initial expected pins come from that enumerator, both source rechecks and the destination comparison can agree on an incomplete install. The intended regular-file before/after checks and final resolved symlink containment do not cover this failure.

Make every traversal error fatal; check directory identity/stability across enumeration and require the exact trusted inventory including children. Prevent relative links from depending on mutable intermediate components outside the copied namespace. Verify no unlisted files enter the application destination between its empty check and final seal.

Source locations — materialize.py 46–71, 143–173.

## P3 · An empty group sample can certify a live leader, and numeric PGID reuse can signal another session

stop() accepts an empty members() result without requiring that Popen has a terminal status. A pure mock with poll() returning None and no sampled group rows produced exit=None, drained=True and noRemainingGroupMembers=True. members() uses a ps snapshot and current numeric getpgid/getsid values. It never checks the recorded launch time or a non-recycled identity. After leader reap, a new unrelated session with the same numeric group/session pair would satisfy those same checks before killpg. The sample and signal are separate operations. ps itself has no timeout. A subsequent wait() can also set normalExitObserved from a nonnegative exit even when this owner already sent a signal.

Require actual reaping and a finite, successful ownership census for any drained receipt. Bind supported children and groups to stable birth identity across cleanup; withhold the signal and quarantine whenever ownership is unresolved. Keep zero exit, unsignaled natural exit, group cleanup and detached-browser ownership distinct. Never resurrect natural-exit proof after signaling. Bound the census command itself.

Source locations — owned.py 112–169.

## P4 · The phase worker accepts a lock without the modules it executes

The phase only requires at least two caller-listed entries plus the selected entrypoint. A mock run through the actual exported run() reached baseline with only phase-worker.cjs and recovery.cjs pinned. The real recovery module imports compare.cjs and integrity.cjs at module load; the fixture imports checks.cjs. An omitted dependency can execute before the factory performs its own validations and while private input is resident. The source lock can even list a correct hash for an omitted dependency, since the worker only iterates the plan subset.

Require the exact reviewed per-phase import closure and its approved digests, including private application dependencies and the loader environment at the outer boundary. Verify them before private payload ingestion and import. Preserve a verified immutable module namespace through load. Test an omitted or changed transitive import without executing it.

Source locations — phase-worker.cjs 33–51, 57–61; recovery.cjs 6–13; fixture.cjs 4, 14.

## P5 · Aborting an unlaunched exchange twice closes recycled file descriptors

abort_before_launch checks only _launched. It closes four numeric FDs and retains their numbers even after setting _closed. Using only a mock FD allocator and closer, two calls closed exactly the same four numbers twice. After another channel or log reuses them, generic cleanup can truncate or corrupt that unrelated channel and its EOF proof. A failure while allocating the second pipe also lacks cleanup of the first.

Make ownership release a one-time transition, invalidate descriptor slots on close, and clean up partial allocation. Include overlapping cleanup/finally and FD-reuse controls.

Source locations — private_ipc.py 45–53, 106–113.

## P6 · Ambiguous private input and plan objects are accepted by the worker

Python rejects duplicate response keys, but the JS reader uses a permissive UTF-8 decode followed by last-key-wins JSON.parse and only then checks keys. An input frame containing two different keyHex values reached mock baseline successfully. Checked plan and lock bytes use the same ambiguous parser. A correctly encoded Python request has unique keys, but the worker does not enforce a common boundary on received frames or externally sourced plan/lock bytes.

Decode UTF-8 strictly and reject duplicate names at every object depth before schema validation, consistently for requests, responses, plans and locks. Reject non-finite/unsupported numbers on both sides and compare actual key sets without a delimiter-collision ambiguity.

Source locations — phase-worker.cjs 14–20, 33–36, 51–55; private_ipc.py 19–34.

## Verified scope and outstanding integration

Observed the same four hashes before and after this review. All three Python sources parsed in memory. Node syntax check of the worker passed.

Git batch parsing verifies each declared path’s expected object ID, type, size delimiter, body hash, and trailing output. It verifies working and destination bytes for the listed paths. This proves declared blob bytes only. It does not establish Git tree mode, a complete allowed path inventory, or absence of newly inserted unlisted files. Materialization writes application files 0400, including entries executable in the original application source. The trusted controller must define the supported mode contract and lock the Git object database/environment.

Dependency copying checks literal relative link targets, rejects absolute links and final targets resolving outside the root, hashes regular bytes before/after copying, and rereads the copied inventory after chmod. The P2 traversal gap applies to these comparisons.

Argument indexing is consistent: six worker arguments correspond to process.argv[2..7] and the error path uses output FD index 7. The fixture and recovery calls match their named factory/operation interfaces. Fresh recovery can accept a signed earlier baseline. RETURNED plus exit 0 reports that the method returned; the method itself may have returned QUARANTINE. The future controller must validate the exact phase/result and evidence bindings.

Positive framing requires a bounded length and exact bytes followed by EOF. Child-side EOF follows the parent request writer closing. Parent response reading waits for actual pipe EOF, and finish refuses to treat a live thread as drained. EOF alone is independent of successful unsignaled child exit. The worker sends its sensitive result over the FIFO and its own error path emits a fixed message. OwnedChildren redirects all child stdout/stderr to private log files and includes argv in receipts; privacy therefore also requires verified transitive code, secret-free argv, and controlled logging. A private file by itself does not prove that raw data was never written.

The worker is intentionally pinned to rejected fixture v1. That is an integration hold distinct from P1–P6. Full controller, independently locked approved fixture/producer, natural observer exit, detached browser ownership and actual post-drain recovery are outside this component verdict.

## Source fingerprints

- `owned.py` · `bde88e5007bd6651c14214828c7ff71dd2dbe295ac418eebbc962469264baf60`
- `materialize.py` · `295a4fb3f681c0045d5a07dafa1185a7a8f33f0f04d36c2b39c32d3493a16097`
- `private_ipc.py` · `05db2230eccf60e86ecce05ab3989fd7416b090e2e1ab4f81b62f1be564574e6`
- `phase-worker.cjs` · `52e3ff28ae794b652e3d884829a17caf41bc2ae21d4ccc7eb65eb9d07c19c4bd`

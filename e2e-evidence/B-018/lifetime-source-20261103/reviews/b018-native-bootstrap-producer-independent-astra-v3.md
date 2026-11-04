# B018 browser acquisition producer v3 independent source review

**NO_GO for the frozen producer.** The current event producer can turn a different browser failure into the approved CSP value and cannot produce a complete witness for an ordinary successful login or normal teardown. The twelve supplied pure tests and Node syntax check passed. Independent emitter probes below exercised the actual listener functions. No browser, network, database, SQL parser or process inspection was used.

The guard-owned constructor/attach/context sequence, actual page navigation and click calls, native redirect callback grouping, default-world marker comparison, response-byte/source comparison and issued-operation records are present. These features did not supply an end-to-end qualifying trace. The accepted index, guard, kernel, map and verifier retain their own component-level dispositions.

## P01 · A nonmatching failure becomes the approved CSP code

Both a literal csp and the synthetic net::ERR_NOT_CSP_RELATED produced exactly pwEnd.error=csp in the installed listener. The sink preserves no separate exact classification. Distinct raw failures therefore become indistinguishable to downstream review.

Use an exact closed error-code mapping with a separate unknown result, retain the original raw-event identity even when later correlation fails, and require the two distinct inputs to stay distinct at replay.

Source locations — producer.cjs 25, 53, 63; classifier.cjs 169–177.

## P02 · A blocked script emits a cookie row for an exchange that never happened

The request handler starts allHeaders() for every request. A native response-less failed script produced pwEnd and pwCookie and no pwResponse. The index permits exactly one pwCookie per response-bearing request and rejects this extra row. A failed header read produces another fatal issue.

Capture request provenance at entry. Reconcile header evidence only for the real response-bearing exchange; retain the negative script request and both failure source IDs without creating a cookie, proxy or body witness.

Source locations — producer.cjs 48–49; index.cjs 125–129.

## P03 · A finished enhanced-login POST can remain pending forever

flushEnd waits for redirectedTo() for every 303, even a Fetch POST that actually finished with no Location and no redirect child. The positive index fixture explicitly uses this shape. The emitter probe produced pwResponse and no pwEnd. A failed terminal following such a response can also be held out of the journal, obscuring the original failure.

Journal the real terminal immediately, preserve every failed terminal as fatal, and reconcile native predecessor/child evidence only when the observed redirect facts require a child.

Source locations — producer.cjs 48–53, 107; index fixtures.cjs 130.

## P04 · CDP initialization violates the accepted index readiness order

The page already exists when Runtime.enable reports its existing worlds. The producer appends these world rows while enabling domains, then emits all four ready rows. The index rejects every observation before its channel ready row. Debugger.enable also reports existing parsed scripts.

Record the known empty setup document and activation interval explicitly. Arm observers before enabling domains, positively confirm activation before measured navigation, and reconcile setup without hiding unexpected traffic or marking unconfirmed channels ready.

Source locations — producer.cjs 69–71, 94–98; index.cjs 219–229; installed protocol.d.ts 22543–22545, 20650–20651.

## P05 · The observer invalidates the page it is supposed to measure

The before-parser init script treats any addition of a meta, base, script or link (or subtree containing one) as a fatal mutation. The normal parser adding the required declared script meets this predicate. During a capture the code also compiles evaluation expressions using PW and Runtime.evaluate with Debugger active; any resulting scriptParsed changes the captured revision and prevents sealing. The producer has no provenance for its own evals.

Prove intended parser insertions against frozen HTML and order while retaining detection of injected, modified, removed or policy-bearing nodes. Preinstall and pin measurement operations or distinguish their exact debugger identities. Never discard all early DOM changes or all anonymous parses.

Source locations — producer.cjs 71, 83–90, 95–97; index.cjs 505–521.

## P06 · The teardown callback uses the wrong Playwright event

The pinned CDPSession emits close. The code waits for disconnected, and Inspector.detached only writes a diagnostic. A pure close event generated zero cdpDetached rows. closeSlot therefore lacks its required signal and reaches its ten-second unavailable branch even after a normal close.

Use the installed session close event and retain separate planned/issued, physical context close, CDP close and guard drain records. An unplanned detach must stay fatal.

Source locations — producer.cjs 54, 77, 108; installed playwright-core/types/types.d.ts 18420–18423.

## P07 · The actual login role-cookie reset is unrepresentable

Successful actionSignIn explicitly deletes PORTAL_ROLE_COOKIE after setting the SID. A same-scope role expiration in a synthetic 303 yielded guard issue/loss and no proxyResponse. The CDP parser shares this rejection. The index enum can only represent no change, tenant assignment or other.

Represent the exact host-only root role deletion as its own observed transition at this login hop and corroborate original and forwarded headers and CDP. Verify subsequent outgoing absence and the real tenant role assignment. SID deletion, shadow scope and unexplained changes still fail.

Source locations — producer.cjs 32–34, 65; app src/server/auth-actions.ts 100–106; index events.cjs 44, 49.

## P08 · Declaration evidence omits a field the existing kernel requires

The parser admits script[src] or link[rel=preload][as=script] but stores neither the tag nor declaration kind. Its declaration digest likewise omits kind. The kernel requires the actual native and positive kinds to agree. Its input cannot be reconstructed from the sanitized events or the map receipt.

Carry the exact parser-derived kind and source reference through the declaration digest and replay. Exercise a script-versus-preload mismatch and prohibit a parent constant or inferred kind.

Source locations — producer.cjs 86–89; index events.cjs 41; classifier.cjs 135–141, 180–183.

## P09 · Recovery has no independently observed proxy token hash for the matched exchange

observeGuard retains a cookie-string commitment in the index, but captures no private per-exchange SHA256(SID). verifySession hashes the current cookie jar, checks a set collected from any PW request, and returns that jar-derived tokenHash together with navigator.userAgent. It emits org/env=expected even when the verified inventory values were absent. Recovery expects proxyTokenHash and verification. Renaming tokenHash would misstate the source, and navigator.userAgent is not a wire header observation.

Join the authenticated landing to its particular proxy exchange, PW and CDP observations. Preserve the actual private wire SID hash, actual scope and observed request UA with explicit source IDs where needed. Keep the initial and new verifier receipts separate and never persist private values.

Source locations — producer.cjs 33–34, 49, 102, 111; recovery v1/v2 recovery.d.ts 4–5.

## P10 · Asset selection rejects supported clean documents and valid reuse

Zero inventory is emitted and then rejected by the unconditional items.length!==1. An enabled later document that legitimately requests the same exact URL as login sees both earlier and later PW successful responses because pwScripts scans the complete slot and requires a singleton. The source map interface also requires twelve positive endRender calls.

Distinguish ordinary zero declarations using real inventory from an exceptional scope requiring one. Use the independently reconciled per-document PW/CDP lifetime to select a real response when URL is reused. Preserve ambiguity if observations cannot distinguish the requests; align map sealing with the measured branch.

Source locations — producer.cjs 86–90; index.cjs 281–288, 333–346; map.cjs 262–304.

## Required acceptance evidence

Drive the public acquisition actions with faithful, independent in-memory PW, CDP and guard emitters, including setup replay, native response-less failure, the enhanced Fetch 303, full redirect hop headers, a real-shaped role reset, parser insertions, probe evaluation, repeated URL across documents, healthy HMR, actual CDPSession close and private recovery exchange provenance. Replay through the same index and kernel adapters used by the parent. Preserve the negative variants alongside that positive. Physical ordering, executable and server freeze, runtime proof, natural child exit and post-drain recovery still require their own review and authorization. Financial aggregate is PENDING, ordinary enabled cancellations are fatal, and historical failures stand.

The frozen manifest and all five members matched at entry and finish. The JSON report records exact digests and emitter outcomes.

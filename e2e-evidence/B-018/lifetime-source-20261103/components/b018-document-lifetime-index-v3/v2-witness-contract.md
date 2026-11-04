# B018 document-lifetime index v2 change record

**Historical v2 contract. The v3 delta supersedes the rules for direct asset provenance and invocation/close ordering.** The six counterexamples in the independent v1 report each reproduced MATCHED at both cuts using the original v1 fixture and reducer. The corresponding v2 replay blocked each one. The original 27-test file is identical to the frozen file. An additional 14 test groups bring the total to 41 with zero failures and zero skips.

## Causal lower bound and active reads

For an exceptional enabled candidate the CDP asset opening and genuine document commit must precede scriptParsed on the same CDP stream. The default context generation must arise after the actual document network opening, survive to the marker reads and bind the correct frame. A parse may precede loadingFinished. Every active PW body, debugger-source or precision-coverage read has an immutable positive read ID and an observed readStart naming its source, raw object alias, frame, loader and document. Start the read inside the open capture fence, append its actual result before seal and retire it exactly once. PW reads refer to the original response object. CDP reads retain the live script's execution-context generation. A passive parse has its own ordinal and never inherits a completion's chronology.

## Teardown and HMR record format

All four observer channels per context stay live through the global bootstrap cut. Each context later records a unique closeIntent and a matching closeIssued at the actual invocation. The v3 producer records actual context.close invocation under the synchronous call-boundary rules in delta-notes.md. Invocation failure is an incident. Record CDP session disconnection as cdpDetached and actual PW context destruction as contextClosed. Either physical observation can arrive first. Each follows the issued close. Every channel's final parent acknowledgement refers to the same intent ID and actual PW event ID and comes after that physical event. The CDP acknowledgement also names its actual detach and follows it. No subsequent CDP fact can come from a detached observer. The parent still owns full drain/recovery.

Commit, physical context close and CDP detach callbacks allocate run-unique, immutable positive eventId values synchronously at observation. For an HMR retirement the actual source is the replacement document's measured CDP commit or the owning context's measured PW close. Let H be lowercase SHA-256 over UTF-8 JSON.stringify of the array, with no whitespace. Use the following exact values.

    sourceFact = [actual.channel, actual.type, actual.ctx, actual.eventId,
                  actual.frame ?? null, actual.loader ?? null, actual.url ?? null, actual.main ?? null]
    recordId = H(["b018-retirement-id-v2", run, actual.channel, actual.eventId])
    anchor = H(["b018-retirement-record-v2", run, recordId, ctx, retiredDoc,
                exchangeAlias, owner, intentKey, sourceFact])

The parent record carries sourceEventId, recordId and anchor. Store that lifecycle record under its canonical recordId before invoking the guard. The guard's actual anchorEventId and anchorSha256 must appear as recordId and anchor in retireAnchor. The guard need not claim it independently observed the browser's source event. The reducer recomputes both hashes from that exact source, owner and intent and checks uniqueness, direction-specific Close frames, guarded arm, real replacement or owned context retirement, guard anchor and subsequent drain. The source event ID is an alias of immutable observed data. Collectors must never create a source event by unpacking parent anchor fields.

## All candidates and the strict branch

Take the union of known exact URL commitments from observed declarations and real network webpack classifications. A conflicting path/resource classification or an isolated, stale or unassigned parse of a known URL is a rejection. Both labeled webpack parses and independently recognizable URLs participate. For an exceptional native failure preserve PW csp, CDP blocked=csp, canceled=false, absent network response and actual absent CDP error text recorded as MISSING. Explicit CDP error text csp is a fatal mismatch. Never convert the raw text to satisfy the rule.

The ordinary branch is determined per native/context document and paired enabled counterpart from the complete reconciled request inventory. It supports zero actual webpack hops or strictly finished successful HTTP 200 asset hops, with no ordinary failure anywhere. inventory is a separate original-document observation and may report zero declarations. Every declaration it does report must bind the actual navigation and HTML. The scope can qualify as ordinary without an exceptional declaration, attached bytes or positive coverage claim. Any actual known parse must still belong to a unique eligible measured hop and default document generation. Neither branch can generate a final feature or financial decision.

## Redirect callback

At entry to CDP requestWillBeSent with redirectResponse, allocate a fresh positive redirectEvent ID. From its observed redirectResponse, synchronously append the predecessor's cdpResponse, the predecessor's synthesized redirect terminal, and the child cdpOpen in that order, with the same ID and consecutive CDP source-sequence numbers. Native CDP need not issue an independent loadingFinished for the prior hop. Use zero for an inapplicable marker on other network events. The ID can belong to only this triple. The reducer also requires the prior raw request ID, consecutive hop, frame, statuses and observed Location, genuine separate PW ancestry and protected-header wire join. Out-of-order ExtraInfo uses the existing unique matching algorithm. Two equal 307 cookie or response projections with multiple legal assignments remain unavailable.

## Verification scope

The previous package and rejection report are pinned as inputs. Run the synthetic Node tests with `node --test index.test.cjs independent-regressions.test.cjs` from this directory. The latter intentionally loads the adjacent frozen v1 fixture, event definitions and reducer to reproduce all six old failures. The package manifest lists these dependencies.

Actual adapter acquisition, source and browser freezes, private cookie/URL HMAC production, guard integration, runtime finance and independent source QA remain external. No real browser, network, process, database or SQL operation was performed. Historical test receipts keep their original results.

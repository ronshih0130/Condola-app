# Independent review of the one-arm ordinary-login observer v1

**NO_GO for this non-admitting diagnostic source.** The observer can report completion with an empty HTTP trace, can miss explicit browser errors, and can initiate cleanup while a response body is still active. Each repair below is local to the one enabled action.

## O1 · Missing ordinary evidence can look complete

Three different actual-listener tests all returned DIAGNOSTIC_COMPLETED_ONLY: no HTTP request/response/terminal from any of PW, CDP or proxy, three CDP openings with zero finish events, and a record of an otherwise successful foreign request. The result tracks only unfinished PW objects. It has no minimum actual login POST/arrival traffic evidence, CDP hop/open/terminal inventory, or basic proxy observation coverage. An orphan PW requestfailed is reduced to an observer issue, loses its failure code/ID and reports zero raw failures. Duplicate request openings are silently ignored.

Capture an opaque orphan identity and exact safe failure classification at callback entry, before attempting any join. Maintain the small ordinary request/redirect/terminal inventories, PW frame/main-frame facts and positive ready/coverage needed to claim a complete trace. Loss, missing expected traffic, contradictory and post-close unexpected rows should prevent completed-only. Preserve an observed FAIL even when independent identities cannot be joined. No exceptional six-slot matcher is needed.

Source locations — observer.cjs 52–65, 129–145, 179–189.

## O2 · The diagnostic can itself cause the cancellation it seeks

The prior ordinary arm used 390×900, checked the English login page, settled HTTP before clicking, used the hit-tested pointer and settled PW/CDP HTTP again on arrival. This version uses 390×844 and locator.click, omits the locale assertion, and only waits for header-read promises. beginClose proceeds while an HTTP response is open. In a synthetic sequence it recorded planned-browser-close before the pending request failed; a finished body cannot be inferred from loaded headers, a visible tenant layout or verifier completion. beginClose also marks planned before the guard acknowledges its close request.

Keep the existing comparable viewport, click and assertions, or identify a changed action as a different experiment. Enforce finite pre-click and pre-shutdown PW/CDP HTTP settling (exclude persistent HMR); emit the actual still-open identities and timeout before cleanup. Separate planned, guard-accepted, actual close invocation and observed physical close in the parent. Always drain on failure, classify known failed terminals strictly, and never attribute a teardown-time abort to the product without evidence.

Source locations — observer.cjs 102, 151–178; prior ordinary probe.cjs 35, 50–52.

## O3 · Foreign requests, socket errors and response-extra failures can be invisible to the verdict

Independent probes delivered a completed foreign HTTP request or Network.webSocketFrameError before shutdown. Each separately returned DIAGNOSTIC_COMPLETED_ONLY. A CDP responseReceivedExtraInfo carrying 503 with no counted error also returned completed-only. The guard should block external traffic but an actual contradictory browser observation is itself material; the protocol frame-error event need not have a matching guard error.

Record strict failures when either browser stream observes a foreign HTTP(S) endpoint or an undeclared transport. Handle the actual CDP/PW WebSocket error callback and a 4xx/5xx in response extra info. Distinguish the finite legitimate loopback ws endpoint from foreign HTTP. Keep existing guard4 failure/denial and unqualified HMR errors fatal; no HMR success model is necessary.

Source locations — observer.cjs 27, 52–56, 116–148, 179–188.

## O4 · Header projections can invent or misattribute cookie and request properties

CDP supplies repeated Set-Cookie values separated by LF in one header entry. A synthetic issued SID followed by a separate root-role deletion produced just one SID observation with maxAgeZero=true. Guard v4 privately projects only cookie and WebSocket key on requests, with a separate limited response list. The generic helper reports false action/router, zero user-agent and empty action-redirect/content-type even when these fields were outside that source projection. A digest of x-action-redirect does not distinguish an observed same-origin route/push/replace from an unrecognized value.

Use source-specific coverage: unprojected stays UNREPORTED. Split repeated CDP fields on the protocol separator, keep individual PW/guard entries separate and never split Expires on comma. Classify only the finite installed Next request/redirect classes actually observed, retaining opaque commitments and unknown for ambiguity. Test the real-shaped multi-cookie POST and two identical raw requests with different source projection coverage. No new proxy header acquisition is required just to report a partial trace.

Source locations — observer.cjs 29–45, 73–77, 129–139; guard v4 guard.cjs 49, 66, 73–74.

## Verified scope

Original four pure groups and syntax passed. Independent listener probes used the real observer with modified in-memory emitter schedules only. A genuine modeled Fetch POST 303 failure produced strict FAIL and two raw failure observations. A successful sibling did not cancel that disposition.

Installed Playwright has request/response headersArray and the actual CDPSession close event. The login-email, login-password, login-submit and liff-frame test IDs exist. Login goes to the locale route once and waits for naturally observed /t; there is no artificial landing goto. The single canonical verifier uses the correct enabled ctx2/user006.

The component has no PASS or finance gate. One private signed snapshot, a partial verifier ledger and contexts=[] cannot satisfy the six-slot recovery envelope. Auth remains unverified and independent total recovery quarantines. Actual recovery, private IPC, sink durability, source binding, natural observer exit and physical drain remain parent responsibilities.

The tested public rows omit synthetic raw cookies, credentials, UA and URL queries; raw SID hash remains private in verifier material. The guard’s public reasons originate from pinned code. The error helper currently emits any string matching net::ERR_[A-Z0-9_]+ verbatim; use a finite safe-code set or keyed unknown classification for unrecognized strings instead of relying on their shape for privacy.

The frozen manifest and all three members matched before and after review. No live attempt occurred.

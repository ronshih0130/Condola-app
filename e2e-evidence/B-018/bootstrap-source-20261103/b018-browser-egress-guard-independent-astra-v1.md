# B-018 independent browser egress guard review

**REJECTED for integration.** The exact manifest and all three members matched. Both request constructors hard-code the loopback destination. The source validates the commanded proxy, forced loopback proxying, launch mitigations, service-worker setting and expected binary. Those facts do not establish actual browser routing or prove that the evidence sink drains.

## G01 Ordinary downstream cancellations can pass unnoticed

guard.cjs 48–64, 90. A complete GET or POST body can be followed by a client disconnect before the reply finishes. IncomingMessage.aborted concerns the incoming body. There is no ServerResponse close/finish comparison. The mock emitted response close with writableFinished false and a frontend socket close. failed stayed false and the upstream request remained open. Track each exchange through both normal terminals, immediately record incomplete downstream responses and stop the fixed upstream. Keep ordinary enabled-login cancellations fatal.

## G02 The close receipt can precede upstream completion or a late failure

guard.cjs 59–63, 72–93, 125–133. close() destroys sockets without checking unfinished exchanges and awaits only the frontend server callback. It never awaits an upstream close or seals the ledger against later updates. In a mock with one assigned upstream socket, orderly browser shutdown produced closed=true, failed=false before any upstream close event. A later request error set failed=true after the caller already held a passing snapshot. Track pending requests before socket assignment, pending replies, both-direction socket closes and upgrade lifetimes. Require bounded positive quiescence, or an explicit quarantine result. Planned browser shutdown must never erase unfinished HTTP. Distinguish an expected HMR close at an actual closed context from unexplained transport loss.

## G03 The proxy can remove the precise CSP evidence being tested

guard.cjs 22–29, 42–46, 53–57. HTTP connection-nominated headers are removed on both legs. In a mocked response carrying Connection: content-security-policy and an enforced Content-Security-Policy header, the browser-facing document lost the policy, and the guard recorded only a normal forward. The downstream collector could then assert zero while the actual server supplied CSP. Reject any policy/representation discrepancy, bind a sanitized upstream policy-presence witness to the exact final document, and reject unsupported semantic transformations. Audit informational responses such as 103 Link hints, which the current proxy never forwards or records.

The frozen URL suite passed 19 of 19 under Node 20 after the handshake timeout change. Syntax passed. Three additional discriminating traces used only in-memory EventEmitter mocks of HTTP, file metadata, sockets, Chromium and shutdown. Real HTTP, listening sockets, browser, database, process inspection and non-HTTP egress controls were unrun. No archived result was reclassified.

Manifest 0e442659e543ae242487c3d6b9382e921abd830629c2f479aeeac0c4986fef8b

Guard e26dc5fdad52fc2eb59cc6bde7a44f6e140e80c454d3f48c4c9fcadf32206349

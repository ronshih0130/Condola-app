# Definition of Done

Every item requires testable acceptance results tied to its exact candidate SHA. Existing implementations may satisfy scope only with current evidence.

## Local and database checks

Use the repository’s pinned Node/npm and documented PostgreSQL toolchain. Use synthetic fixtures and disposable local databases.

Run applicable repository gates, including:

- Clean `npm ci`, typecheck, lint and unit tests.
- `test:rls`, function privileges/allowlist, copy checks and flag checks.
- Build and `cf:build`.
- Playwright acceptance tests for changed journeys, direct route/API/file authorization, failure states and flag OFF/ON.
- Additive migration replay from a clean database and supported upgrade state.
- Previous-green code against the new schema, using disposable/restored nonproduction data.
- Anonymous, same-org authorized, same-org unauthorized and cross-org cases; include sandbox/live separation.
- Concurrent, replay and idempotency tests for financial writes, invitations, notification claims and quota reservations.

Record exact commands, exits, environment, test counts and failures. Never call a baseline failure “pass.” A claimed baseline exception needs exact-SHA independent QA disposition; otherwise verdict remains incomplete/NO-GO.

## Staging checks

Acquire repository and staging ownership under the operating contract. Use staging-only credentials.

Before **every** staging deployment:

1. Install dependencies separately in the candidate worktree; no symlinked worktree path or `node_modules`.
2. Stop dev servers writing that worktree’s `.next`.
3. Run `cf:build`.
4. Run `bash scripts/preflight-deploy.sh` (run from the repo root; optional arg: worktree path). Script lives in the app repo (branch `preflight-script-1029` @ d40f7c4, from prod c011e91); works on macOS and Linux.
5. Save output; require exit 0 and `PREFLIGHT PASS`.

Preflight checks the OpenNext middleware-manifest patch, Worker output and foreign dependency paths. Do not bypass it.

After staging deployment, verify `/api/version` matches the candidate and probe login, affected portals, principal pages and changed APIs. Require expected HTTP/auth behavior and **zero 5xx**, with browser console/page-error evidence. Exercise flag OFF compatibility and explicitly scoped staging ON behavior.

Capture affected screens at **390px and 1280px** with synthetic data, including empty/error/loading states and relevant zh-TW copy. API-only items attach representative protected parent screens and explain why no new screen exists.

## Copy and content checks

Use `11-decisions/DECISIONS.md` to resolve the older proposal’s “pending” header. The approved slim banned-word policy is authoritative over obsolete blanket bans.

Run copy guard and scan changed UI, templates and generated documents for:

- Unsupported guarantees and Condola money-handling/property-management claims.
- False company/qualification assertions.
- 統編/統一編號: no invented or hard-coded identity; regional business fields come from authorized configuration.
- Prices, plan limits and amounts: no hard-coded commercial values or invented pricing; approved regional defaults and the explicitly approved LINE quota constants are configuration with tests.
- Tenant reports represented as confirmed payment, API acceptance represented as delivery, or no response represented as consent.
- Secret/token/credential values.

Record contextual review of permitted terms and official-source exceptions. Do not weaken guards merely to pass.

Privacy, terms, consent and ID-notice text is immutable for Codex. A required change becomes a blocker referencing the approved source path.

## External services

Codex sends **no external Email, LINE or Slack messages**. Tests use mocks or a local capture sink. Never turn an event handler test into a real notification.

Real mailbox receipt, live OA delivery and iOS/Android LIFF checks require separately performed Ron/QA evidence. Record missing evidence as an activation blocker; do not claim a mocked test proves real delivery.

## Evidence and verdict

Use `/workspace/e2e/results/<ID>/` or repository `e2e-evidence/<ID>/`.

Attach:

- `status.md`: timestamp with PT offset, scope, branch/SHA, reserved files, dependencies, commands, next action and blocker references.
- `acceptance.md`: each Given/When/Then result with evidence links.
- `verdict.md`: PASS / NO-GO / INCOMPLETE, exact SHA, tested scope, failures, risks, flag state, migration compatibility, evidence and production activation blockers.
- Class B `classb-draft.md`, independent QA evidence/signature, and delta review.
- HTTP/browser logs, test results, screenshots, migration/RLS/privilege evidence and preflight output.

Operational documentation commits may follow the immutable candidate SHA; they do not transfer an approval to changed code. Preserve status/verdict/issues; follow the canonical retention policy for bulky evidence.

## Production handoff

**Codex never deploys to production. It pushes/deploys to staging only and writes verdict.md. No production DB access or flag activation. The Mac gets no production keys.**

Grok Bot side performs production release through the GATE:

- Current TRAIN integration rules, final combined SHA, full CI, `test:rls`, Codex delta review and fresh independent QA sign.
- CEO GO naming the exact SHA and release slot.
- Migration/catalog compatibility, restore-verified backup, before/after row counts and rollback identity.
- Applicable frozen/approved GATE-B harness and current QA rulings.
- T+0 and T+15, with T+15 at least 900 seconds after full traffic; direct version/login/page probes and zero 5xx.

The historical GATE-B draft is not itself approval. Later PRINCIPLES §7 makes log plumbing supplemental; the release side must record the applicable current QA disposition rather than silently waive conflicting gate records.

Class B flag activation is a separate authorized production operation, with QA confirmation, CEO/Ron decision and T+0/T+15. B-001/002/003 activation is explicitly **Ron decides**.

Unknown cause means NO-GO. Production rollback/fix-forward belongs to the authorized release side.

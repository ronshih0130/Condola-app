# B-005 — JIT L2 設計稿：開通、邀請與可續接試用（slice 1：durable invitation resend results）

> Author: Claude (Mac overnight, 2026-11-06 PT). Layer-2 design for hub `20-build/specs/B-005.md` incl. **PROP-US-v03-02** (M-34 unit-QR signup reserve). Branch cut from #36 (`d374bb6`), independent.

## Evidence reconciliation (existing, not rebuilt)

| Acceptance | Existing |
|---|---|
| Resumable onboarding progress | `onboarding-progress*.ts` + `onboarding-progress.integration.test.ts` (flag `onboarding_progress` OFF) |
| Accepted/expired/team invitations, no duplicate membership | `team-invite-link*.test.ts`, `team-invite-allowlist*.test.ts`, `portal-invite*.test.ts` |
| Invitation audit privacy | `20261104120200_b005_invitations_audit_mask.sql` + `b005-invite-audit.integration.test.ts` |
| Resend outcome contract | pure rules `src/lib/portal-resend-state.ts`, renderer `src/components/portal-resend-result.tsx`, in-memory reference `test-portal-resend-memory.ts` + `portal-resend-contract.test.ts` — **no durable store, route or sender** (BLOCKED register 11/02: "durable invitation resend (DB) needs new schema") |

## Slice 1 (this PR): durable resend results behind `INVITE_RESEND_RESULTS` (OFF)

Done means: with the flag ON for a local test org, a staff admin resending an incomplete portal invitation through the **mock provider (local capture, no network)** sees the contract result (captured / accepted / rejected / unknown / conflict / already_connected / disabled / unavailable), replays with the same request id return the same result, a second concurrent resend of the same invitation is a conflict, `unknown` is terminal even if the transport later resolves, a rejection releases the reservation, and an already-connected invitation never calls the transport — all durable across requests. Completed links are never reset. Flag OFF: zero writes; existing invite UI unchanged.

- Migration `20261106090000_b005_resend_results.sql`: seed `platform_settings('INVITE_RESEND_RESULTS', {"enabled":false,"allowed_org_ids":[]})` ON CONFLICT DO NOTHING; private `app.b005_resend_requests` (org, actor, request id, source invite id, generation, payload digest, status, deadline, timestamps; PK (org, actor, request); partial unique active reservation per (org, source) for non-rejected states); RLS on, REVOKE ALL; SECURITY DEFINER claim/settle RPCs with pinned search_path, flag + `app.has_role(org,'{admin,manager}')` checks; terminal states immutable.
- `src/server/portal-resend.ts`: DB-backed implementation with the same semantics as `createResendMemory` (eligibility from a trusted server snapshot of the invite: flag, invite available, already connected), mock transport `src/server/portal-resend-mock-transport.ts` (local capture only).
- Server action + rendering of the existing `PortalResendResult` where the staff resend control lives (reuse; no new copy).

## Not in this slice (logged)

Real e-mail/LINE sending; M-34 unit-QR signup binding (PROP-US-v03-02 — needs a controlled org/unit context token; if it requires a new token-binding table/verification page it goes to a post-52 PROP per the hub note); staging verification.

## Slice 2 — M-34 unit QR

Authorization: Ron's explicit implementation delegation extends this slice with the private token/applicant tables requested below. The hub B-005 PROP-US-v03-02 text is preserved; its prior post-52 reservation and Slice 1 exclusion remain historical scope, not permission to change BUILD-ORDER or activate flags. Work is local only; Claude owns git and independent QA.

- Staff admin/manager selects an active unit on `/m/units/qr`; issue and revoke are authenticated server actions, checked with `requireOrgScope` and fresh DB membership/session checks. No QR dependency is installed, so P0 uses the permitted server-rendered URL + copy fallback. The URL is `/signup/unit-qr#t=<opaque signed token>`; no org/unit data is encoded. HMAC-SHA256 uses a dedicated server `UNIT_QR_SIGNING_KEY` (at least 32 bytes; absent means unavailable). Tokens expire after 30 minutes, are single-scan, revocable, and hashed at rest. Ten issues per actor/org per 30 minutes and twenty valid scans per hashed IP per 30 minutes are serialized in the DB.
- A standalone entry document immediately replaces browser history before parsing the fragment, then POSTs the token to `/api/signup/unit-qr` and replaces navigation with token-free `/signup`. It loads no app shell or analytics and has a restrictive CSP. Entry exchanges the token for a random HttpOnly, SameSite=Lax handle scoped to `/signup`. Only the hash of that handle is stored. Invalid, expired, revoked, archived and disabled entries all return 404 without unit details. No raw token, handle, email, phone or IP is written to QR audit. The response is private/no-store and no-referrer.
- Existing `startSignup` retains identity creation, email confirmation, consent, mail mocks and password checks. An optional handle binds to the signup user only after account creation or proof of the existing password. Binding persists server-side across email confirmation on another device. Successful binding returns an explicit result marker only when persistence occurred, and the action expires the browser cookie at the same `/signup` path before redirecting. Completion and explicit abandonment also clear it. Wrong-password acknowledgements and mail-throttle acknowledgements never claim a binding. A present invalid continuation fails closed with the existing error state; explicit feature disablement keeps the ordinary signup path and lookup query sequence. An ON-only opaque form id is persisted against the exact scanned context and rendered in the hidden field. The action checks the form/handle pairing before signup writes; expiry or mismatch replaces the browser handle with a session-scoped invalid tombstone, so redirects and later submissions remain blocked until abandon or a successful rescan. Successful binding stores an explicit per-user context selection; resume never sorts by issuance time. `/signup/firm` renders the applicant name/phone completion branch for a valid bound context; otherwise its existing output is unchanged. It uses existing phone validation and authenticated signup identity, without an alternative login or verification surface. Existing invitation acceptance is untouched; QR guidance points existing invite holders to their original link. B-033 can reuse this continuation with the same verified auth.users identity.
- Completion requires verified email, nonempty name, valid international phone and current consent. A serialized gateway rechecks token expiry/revocation, active unit/property and all flags. It first reuses the same user's private applicant mapping, then a tenant contact already bound to that same verified user; it NEVER matches by email. Otherwise it creates a tenant contact with **no user_id and no directory email** (the directory has a unique tenant-email index). Email-only matches require explicit staff reconciliation outside this gateway. Applicant name, phone and verified email are saved independently in the private applicant row; reusing a directory contact never discards those submitted details or overwrites directory data. Identity guards reject a conflicting applicant owner and a later contact login assignment to a different user. Private `(org, unit, user)` pending-applicant rows link account/contact/unit. No membership, lease, lease party, contact login binding or data entitlement is created. Replays and two connections return the same association; multiple unit applications reuse one org contact. Existing linked contacts retain only their pre-existing permissions.
- New migration `20261107060000_b005_unit_qr_signup.sql`: private contexts, applicants, per-render forms, bound selections and contact privacy markers, RLS, no direct grants even to service_role; service-only SECURITY DEFINER gateways with pinned search_path. Platform `unit_qr_signup` is seeded OFF. Every gateway requires strict JSON boolean enabled, array allowlist membership and org boolean flag; write gateways lock settings/org admission before mutations. OFF means no QR writes/audits and QR generation/entry returns 404; ordinary signup HTML and behavior remain unchanged.
- `collect_id` / `require_id_before_sign` are preserved verbatim wherever stored. This checkout has no named runtime implementations for those switches; this slice neither implements nor overrides future signing/collection policy. Tests preserve all four settings combinations and prove no ID/lease writes. No invitation/PROP-01b resolver or LINE identity changes.
- Register migration classification (new private constraints/ACLs are not deploy-add-only), seed wipe, migration catalog, flag, consent entrypoint and test scripts. Validation: typecheck, lint, copy, unit, new integration plus signup, signup-gotrue, portal-invite and onboarding suites separately against local disposable DB; no full test:rls, external calls or deployment.

### Slice 2 local validation — continuation, 2026-11-06 PT

Resumed the existing uncommitted implementation on base `7d6a40d47878357cb9e0cba8f74ec2ec573ddcd2`; no git mutation or remote operation. Node `20.20.2`, npm `10.8.2`. Recreated only local `127.0.0.1:55432/condola_b005impl`, applied the stub and every migration with `ON_ERROR_STOP`, then ran `db:reset`. The QR suite uses `cloneTestDatabase()` and resets/seeds before every test. Each integration file ran in its own invocation with `--test-concurrency=1`; GoTrue and email providers remain mocked.

| Check | Result | Local evidence |
|---|---|---|
| Fresh database, all migrations, seed | PASS | `/private/tmp/b005-continue-db.log` |
| `npm run typecheck` | PASS | `/private/tmp/b005-continue-typecheck.log` |
| `npm run lint` | PASS; 0 errors, 15 warnings outside this slice | `/private/tmp/b005-continue-lint.log` |
| `npm run copy:check` | 6 passed; 0 failed/skipped | `/private/tmp/b005-continue-copy.log` |
| `npm run test:unit` | 982 passed; 0 failed/skipped | `/private/tmp/b005-continue-unit.log` |
| `b005-unit-qr-signup.integration.test.ts` | 16 passed; 0 failed/skipped | `/private/tmp/b005-continue-qr.log` |
| `signup.integration.test.ts` | 1 passed; 0 failed/skipped | `/private/tmp/b005-continue-signup.log` |
| `signup-gotrue.integration.test.ts` | 3 passed; 0 failed/skipped | `/private/tmp/b005-continue-gotrue.log` |
| `portal-invite.integration.test.ts` | 16 passed; 0 failed/skipped | `/private/tmp/b005-continue-invite.log` |
| `onboarding-progress.integration.test.ts` | 1 passed; 0 failed/skipped | `/private/tmp/b005-continue-onboarding.log` |
| `git diff --check` | PASS | Local working-tree check |

Acceptance covered: current staff/session and own active unit; opaque one-scan exchange; email verification plus profile completion; repeated/concurrent completion with one association/contact and no new membership/lease; no access for unverified or pending accounts; expiry/revocation/forgery/archive rejection; cross-org isolation; contact reuse across units; password/handle rebinding protection; all four ID-policy combinations unchanged; existing invitation acceptance; strict OFF matrix with zero QR/business/audit writes; issue/scan limits; RLS, table/function ACLs, SECURITY DEFINER/search_path catalog and masked QR audit. The ordinary signup regression passes and its OFF JSX branch remains the existing form; browser-rendered byte comparison was not performed.

Boundaries: no full `test:rls`, browser/staging/production acceptance, external calls, deployment, commit, push or PR. Claude independent QA is pending. SVG generation is intentionally the authorized URL/copy fallback because this checkout has no QR dependency. `unit_qr_signup` stays default OFF; deployment key provisioning and activation remain outside this local task. The hub has `B-005.md` but no `B-005-design.md`; the existing worktree design above is the preserved and extended design source.


### Slice 2 — QA fix round 2 (2026-11-06 PT)

All six independent QA findings are addressed in the same uncommitted migration and working tree. Earlier validation above is historical; final round-2 results are recorded below. No external documentation fetch was performed under the zero-network delegation.

1. **Bearer in invocation URL:** replaced the token path route with isolated `/signup/unit-qr#t=...` bootstrap and a bounded, same-origin JSON POST exchange. History is replaced synchronously before parsing/fetch; no-referrer/no-store applies to both responses. The bootstrap CSP permits only its hash-authorized script and same-origin exchange. Invalid input, replay, cross-site POST and caught exceptions return an empty 404 without token/exception logging. Tests inspect script ordering, browser requests/referrers/console/errors/history, exchange errors and masked database audit. Generated bearer data appears only in the intended fragment and POST body, not the HTTP URL. This is local evidence, not inspection of deployed Worker logs.
2. **Forged forwarding chain:** the platform boundary is established by the synchronous OpenNext Cloudflare runtime context, never by a request header. Only then is `CF-Connecting-IP` accepted; IPv6 and IPv4-mapped forms are canonicalized. The helper supports a trusted socket address for a Node ingress. Next App Router does not expose that address, so the route uses a shared unknown bucket outside Workers rather than inventing a socket identity or trusting forwarding headers. This stricter fallback cannot bypass the scan cap through forged headers. No async proxy initialization or external calls. Unit and DB tests rotate forged chains through 21 scans against one trusted address.
3. **Email-only identity collision:** private same-user mapping has priority; conflicting owners are excluded and guarded in the database. Email-only contacts are never selected. New contact email stays empty; the verified email is preserved in private applicant details for explicit reconciliation. Tests cover an unlinked directory/lease contact, a claimed contact whose email changes to a second applicant, same-user mapping priority, and conflicting direct applicant/contact binding mutations.
4. **Discarded phone/name:** private `submitted_name`, `submitted_phone`, `submitted_email` fields preserve submitted details even for a reused same-user contact. Tests cover differing names, missing and stale phone, and multiple units. Repeat completion remains idempotent and returns the original application.
5. **Invalid continuation becomes ordinary signup:** the lookup now distinguishes absent, explicitly disabled, invalid and active states using the existing single RPC query. Expiry/revocation/archive rejects before ordinary signup; transaction binding still rechecks validity. A hidden field exists only on the active QR form to detect a disappeared cookie. OFF UI/queries remain the legacy behavior. Tests include expired/revoked/archived open forms and cookie expiry, plus disabled rendered-DOM and query-sequence equivalence.
6. **Sticky browser handle:** only a successful persisted bind sets `unitQrBound`; the action clears the `/signup` cookie before redirect. Completion and explicit abandon clear that path as well. The browser regression completes account A, removes its login session, registers account B in the same browser, and verifies B has no association to A's QR. Account-bound continuation remains available after cookie removal.

The new contact identity constraint remains enforced for persisted applicants even if the rollout flag is later disabled; disabling the feature does not authorize an identity reassignment. Fresh ordinary signup has no QR query or new output. Historical round-2 behavior (superseded by round 3 below): the bootstrap served a token-free document even when OFF; only POST enforced admission. Independent QA correctly rejected that GET behavior.

Round-2 validation: all requested local checks and the added browser regressions passed (table below). Initial browser attempt could not launch Chromium within the macOS sandbox (`bootstrap_check_in ... Permission denied`); raw failure is retained in `/private/tmp/b005-r2-browser.log`. The same local-only launcher was approved outside that sandbox; results are tracked separately. Full `test:rls`, remote DB, deployed logs/analytics, staging, deployment, git writes and independent Claude acceptance remain outside this task.


| Final round-2 check | Result | Evidence |
|---|---|---|
| Fresh local DB: drop/create, stub, all migrations, db:reset | PASS | `/private/tmp/b005-r2-db.log` |
| `npm run typecheck` | PASS | `/private/tmp/b005-r2-typecheck-final.log` |
| `npm run lint` | PASS: 0 errors, 15 existing warnings outside this slice | `/private/tmp/b005-r2-lint-verified.log` |
| `npm run copy:check` | 6 passed, 0 failed/skipped | `/private/tmp/b005-r2-copy.log` |
| `npm run test:unit` | 985 passed, 0 failed/skipped | `/private/tmp/b005-r2-unit-final.log` |
| QR integration, separately, `--test-concurrency=1` | 22 passed, 0 failed/skipped | `/private/tmp/b005-r2-qr-verified.log` |
| signup integration, separately, `--test-concurrency=1` | 1 passed, 0 failed/skipped | `/private/tmp/b005-r2-signup.log` |
| signup-gotrue integration, separately, `--test-concurrency=1` | 3 passed, 0 failed/skipped | `/private/tmp/b005-r2-gotrue.log` |
| portal-invite integration, separately, `--test-concurrency=1` | 16 passed, 0 failed/skipped | `/private/tmp/b005-r2-invite.log` |
| Local Chromium `playwright.b005.config.ts` | 3 passed, 0 failed/skipped | `/private/tmp/b005-r2-browser-verified.log` |
| Local server log scan for signed QR bearer pattern | 0 matches | Same final browser log; request/console/error/history assertions in browser test |
| `git diff --check` | PASS | Working-tree check |

Browser evidence compares the rendered `.auth-wrap` DOM byte-for-byte, including form text/markup, for ordinary versus disabled QR signup; it does not claim byte equivalence of Next's entire dynamic HTTP/RSC payload. The separate DB spy confirms the legacy context lookup query sequence and no QR query when no handle exists. Request URLs, referrers and Chromium navigation history contain no QR bearer; the isolated entry has no analytics resources. Deployed Cloudflare observability/analytics are not accessed or claimed verified.

Preserved failures: initial POST tests exposed NextRequest's loopback-host normalization; same-origin validation now uses the actual Host header and tests exercise the real browser origin. `/private/tmp/b005-r2-qr.log` is the initial 19/21 result. The first unsandboxed browser run passed two cases but found a strict locator collision with Next's hidden route announcer (`browser-final.log`). The next run found interaction before consent hydration, with a checked checkbox and disabled submit (`browser-pass.log`). The final test waits for the existing React event handler before interacting and scopes the error locator to the signup panel; no forced click, disabled-button bypass or relaxed assertion. The final run passes all three cases. Earlier failure logs remain separate from passing evidence.

No required local fix or requested check remains outstanding. Independent acceptance is still Claude's responsibility; this is implementer evidence, not QA sign-off or release approval. No git commit/push/branch/checkout/reset/stash, PR, remote database, external network, full test:rls or deployment was performed. The new migration was edited in place and applied only to the explicitly disposable local DB and its test clones. Flags remain default OFF in source; the local fixture is reset to seed after validation.


### Slice 2 — QA fix round 3 (2026-11-06 PT)

The round-2 claim that finding #5 was fully closed is superseded: its first rejection lost QR intent after cookie expiry. This round addresses all five new findings locally, editing the unapplied migration in place. Claude remains the only committer and independent acceptance owner.

| Finding | Final behavior | Regression evidence |
|---|---|---|
| Expired cookie downgrades second submission | `signup-actions.ts` writes a non-bearer `invalid` session cookie at the same `/signup` path before redirect. The page renders the existing invalid/abandon state without a signup form; later submissions, including one omitting the hidden field, remain blocked. Explicit abandon or successful rescan replaces this state. A QR `required` failure during signup also preserves invalid intent. | Real action/page/form source probes: expire cookie, first rejection, redirected page, second submission, revisit, abandon and rescan; zero signup calls before explicit recovery. |
| Another tab replaces unit/org | Each rendered QR form gets a random UUID persisted in private `b005_unit_qr_forms` against its context. The hidden field contains that id, never a boolean or bearer. The action checks the stored id against the request's cookie context before calling signup. A mismatch invalidates the continuation and requires abandon/rescan. | Real action/page two-tab probe rejects A with B's cookie before signup; DB tests cover separate per-render ids, stored context, crossed/forged/missing handles and revoked context. |
| Resume chooses issuance order | A successful password/account bind atomically upserts `b005_unit_qr_selections(user_id,context_id)` with the exact validated continuation's context. User resume reads only that selection, checks ownership, and never orders contexts by issue time. The server-side selection survives browser-handle clearing and cross-device verification. | Issue A then B, complete B, bind A: reader returns A incomplete; complete A: reader returns A completed. |
| Full contact audit leaks applicant PII | Completion marks the generated contact id in a private table before inserting the contact, in the same transaction. A dedicated contact audit helper masks name, phone and email in both snapshots before audit insertion. It preserves original changed-column/no-op behavior and full snapshots for ordinary contacts. Non-PII privacy markers deliberately survive contact deletion so later UPDATE/DELETE remain masked, even after flag disablement. | Completion test captures **every newly created audit row**, verifies a contact audit is present, and rejects applicant name/phone/email, handle/token and IP everywhere. Additional update/delete coverage and an OFF ordinary-contact full-row equivalence check pass. All five private tables and all thirteen functions have explicit RLS/ACL/catalog assertions. |
| Entry GET serves 200 when OFF | Dynamic GET admits only with a signing key and at least one fully enabled/allowlisted org; otherwise it returns an empty private/no-store, no-referrer 404. A fragment does not identify an org to GET, so exact token/org admission remains POST's responsibility. | GET and POST exercised together across global OFF, malformed flags, empty allowlist, org OFF and missing settings; ON GET remains the isolated CSP document. |

OFF compatibility: ordinary/explicitly disabled signup uses no form creation or matching query, retains the existing rendered form/text and action arguments, and retains the existing single context lookup when a handle is present (none when absent). Unit source probes compare rendered markup/action sequence; the DB spy compares actual query arguments. The OFF DB snapshot now includes forms, selections and privacy markers as well as existing business/audit state. The mandated entry GET 404 is the explicit exception to previous OFF route output. Privacy masking persists for already-created QR contacts after disablement; ordinary contact audit snapshots stay unchanged. No product/legal copy was added or changed.

Validation uses Node 20.20.2/npm 10.8.2 and a fresh `127.0.0.1:55432/condola_b005impl`: drop/create, stub, every migration with `ON_ERROR_STOP`, then seed. Every integration file is invoked separately with `--test-concurrency=1`. The QR suite runs in a disposable local clone; provider calls remain mocked. No full RLS suite or browser rerun is claimed.

| Round-3 check | Result | Evidence |
|---|---|---|
| Fresh local DB, all migrations, seed | PASS | `/private/tmp/b005-r3-db.log` |
| `npm run typecheck` | PASS | `/private/tmp/b005-r3-typecheck-final.log` |
| `npm run lint` | PASS; 0 errors, 15 existing warnings | `/private/tmp/b005-r3-lint-final.log` |
| `npm run copy:check` | 6 passed; 0 failed/skipped | `/private/tmp/b005-r3-copy.log` |
| `npm run test:unit` | 988 passed; 0 failed/skipped, including the migration-manifest test | `/private/tmp/b005-r3-unit.log` |
| QR integration | 26 passed; 0 failed/skipped | `/private/tmp/b005-r3-qr-final.log` |
| signup integration | 1 passed; 0 failed/skipped | `/private/tmp/b005-r3-signup.log` |
| signup-gotrue integration | 3 passed; 0 failed/skipped | `/private/tmp/b005-r3-gotrue.log` |
| portal-invite integration | 16 passed; 0 failed/skipped | `/private/tmp/b005-r3-invite.log` |

No requested fix/check is intentionally omitted. Independent Claude review and browser/staging/release acceptance remain unperformed for round 3. No external network calls, remote database work, deploy, git mutation or PR. Source flags remain OFF. STOP POINT: round-3 local implementation and requested validation complete; next: Claude independently reviews this uncommitted working tree and the evidence above; owner: Claude.

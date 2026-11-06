# B-035 — Vendor LIFF single-job claim

## Done means

A valid assigned/shared vendor job credential can be exchanged through the B-033 browser-bound flow and local
LINE ID-token verifier for a cookie-bound, single-job capability. Each read and report rechecks the original
job hash, assignment, sharing, expiry, revocation and ticket state under locks. LINE verification creates no
vendor account, staff membership or account-history authority. Existing B-026 account access remains separate.
Claude owns independent review and all git operations. Implementation and validation are local only.

## Flags

`LINE_PLATFORM_ENABLED`, strict platform/org `line_platform` and `line_vendor_portal` must all be ON.
Missing, malformed or OFF gates return 404 and write nothing, including admission/audit/session bookkeeping.
Vendor bootstrap now follows that strict contract; tenant/owner behavior is unchanged. Existing vendor dispatch
and sharing constraints still apply. All persisted defaults remain OFF; no activation is part of this task.

## Data

Add `20261107085000_b035_line_vendor_claim.sql`: a private RLS-enabled `app.b035_vendor_flows` extension keyed
to the existing B-033 flow, containing only pinned job ID/hash and a short-lived claim hash/expiry. It is not
an account identity or a Condola auth session. Provider verification stays on the B-033 flow. Raw job tokens
are accepted only in same-origin POST bodies; no new raw token storage, token URLs or browser storage.
Flow metadata and claim are transactionally created/consumed; claims also bind to the existing browser proof.
No second identity/link service. Existing B-033 bind, org unlink, global revoke, recovery checks and pending
dispatch Email fallback remain authoritative. Claims tied to a known identity require that identity and its
vendor org link to remain active; global revoke and org unlink invalidate that access on the next request.

## Routes

| Route | Behavior |
| --- | --- |
| GET `/v/liff` | Strict-gated existing bootstrap; generic entry offers Email login; lost browser cookies safely return to login. |
| Existing `/v/[token]` | Strictly gated "continue in LINE" entry (zh-TW/en). OFF renders the pre-B-035 HTML byte-for-byte (same child slots and `useId` output). |
| POST `/v/liff` | Same-origin, body-only job-entry proof: strict gates + job scope recheck, sets only the B-033 browser/CSRF cookies, no database writes. |
| POST `/api/line/flows` | Existing flow creation gains `jobToken` for vendor login only; derives org/job from capability and rejects conflicting hints. |
| POST `/api/line/session` | Existing verification/one-time consumption issues a Secure HttpOnly single-job cookie, never an account session for job flows. |
| GET `/api/line/login/callback` | Same job completion after existing state/nonce/PKCE checks, captured local code exchange only. |
| GET `/v/liff/job` | Cookie-gated safe single-job page; no token URL. |
| GET/POST `/api/line/vendor-job` | Read the scoped shared job / submit existing vendor report; original guard and report service are reused in the same transaction. |
| Existing `/api/vendor-account` | Requires real Condola session/current consent and B-026 mapping; job cookie grants nothing. |

The `/v/[token]` entry POSTs `{jobToken}` to `/v/liff`, then `{purpose,persona,jobToken,csrf}` to `/api/line/flows`
(both `referrerPolicy: no-referrer`), and opens the returned `/v/liff?flow=…` through a `rel=noreferrer` link. The raw
job token never appears in a URL, Referer, history entry, storage or log; only the opaque flow handle reaches the bootstrap.

The job page uses existing zh-TW/en vendor labels, escaped shared fields and the existing local
`/brand/v2/theme.css` + `/brand/v2/pages/v-job.css` assets only when `BRAND_V2` is strictly ON.
It sets the document language and a same-origin-only CSP; no SDK, font or other third-party download is added.
The existing B-033 host-provided LIFF adapter boundary remains: `window.liff` is required for the bootstrap
adapter, and the default OAuth code exchanger remains unavailable until separately reviewed activation.

## Acceptance mapping

All cases are exercised through exported HTTP handlers in `src/server/b035-vendor-liff.integration.test.ts`,
using `cloneTestDatabase()` and `resetAndSeed()`, synthetic HS256 tokens and captured transports.

1. Valid assigned flow + verified LINE → only pinned job; no identity/account/history provisioning; replay and concurrent exchange denied.
   The `/v/[token]` entry is driven end-to-end: rendered page → POST `/v/liff` proof → flows → GET `/v/liff?flow=` →
   `public/line-bootstrap.js` → exchange → job page/read/report; only that job opens and reports.
2. Generic entry without capability → existing localized login guidance; no job claim; lost/foreign browser cookie → safe reauthentication, no token URL.
3. Expired/revoked/reassigned credential (including a real `dispatchVendor` re-dispatch to another vendor) → identical 404 for read/write and new flows, even after verification; sharing removal, hash rotation,
   foreign/missing IDs, stale flow and closed-job write rejection also covered. Successful report and repeated report exercise the real writer.
4. Org/global unlink while pending → captured dispatcher makes no LINE call and queues Email; global revoke invalidates LINE
   sessions while confirmed Email recovery remains; org unlink preserves other org links. Recovery denial remains enforced.
5. Job-only user → account/history and staff operations denied; authenticated account access uses only B-026 assignments.
6. Strict OFF matrix across entry, entry proof, flow, exchange, claim read/write; full before/after snapshots prove zero writes.
   The rendered `/v/[token]` HTML (classic and enhanced, zh-TW/en) equals the pre-B-035 page for env/platform/org/malformed OFF.
7. CSRF/Origin, private headers, browser isolation, privilege catalog and migration registration are verified.

| Hub Given/When/Then | Concrete route regression |
| --- | --- |
| Assigned valid job + verified LINE → only that job | `valid assigned LINE flow opens only its shared job, without account identity promotion`; OAuth callback; concurrent consumption; foreign-scope denial |
| Missing capability + generic entry → safe guidance | `generic vendor entry offers existing Email guidance and unknown LINE identity gets no job/account session`; lost-cookie reauthentication |
| Expired/revoked/reassigned token + read/write → denial after authentication | Parameterized `expired`, `revoked`, `reassigned`, `sharing`, `hash`, `archived` read/write denials; pre-verification revocation; closed job report denial |
| Org/global unlink + pending dispatch → Email available | Parameterized `org`/`global` unlink regressions use real binding/unlink/revoke handlers and captured dispatcher; zero LINE calls; queued Email; confirmed Email session preserved |
| Token-only + history → no authority | `job-only cookie cannot read account history, claim account invitations or mutate staff scope`; real B-026 account mapping/removal regression |

Additional tests cover strict platform/org OFF and malformed/missing settings with before/after database
snapshots; private RLS/function privileges; invalid audience, CSRF and Origin; claim/flow expiry; browser
isolation; anonymous-claim invalidation after account binding and a concurrent bind/report lock interleaving;
zh-TW/en escaping and local brand assets. Test registration is in `test:rls`; validation runs only the requested
individual files. Consent-entrypoint classification, migration registries and B-027's regenerated route inventory
include both new routes and the new private migration.

## Out of scope

Tenant/owner feature expansion, property grants, role switching from client hints, new account provisioning from job tokens,
LINE SDK/CDN downloads, provider HTTP, live devices, remote databases, deployment, flag activation, git writes and full `test:rls`.
Real-device activation evidence remains Ron/QA's responsibility. No new product copy beyond the three zh-TW/en `i_vendor_line_*` entry keys; otherwise existing keys.

## Local validation — 2026-11-06 PT

Continued the existing uncommitted implementation; rebuilt `condola_b035impl` on `127.0.0.1:55432` from the
Supabase stub, all migrations and `db:reset`. Node 20.20.2 / npm 10.8.2. Final checks: typecheck PASS; lint PASS
(0 errors, 16 existing warnings); copy 6/6; unit 1034/1034; B-035 48/48; B-033 login/link 79/79;
B-033 foundation 94/94; B-027 denial inventory 28/28 (no regeneration needed after review fixes). Each integration file ran separately with
`--test-concurrency=1`; all have zero failures/skips. Node test processes loaded the local-only socket/HTTP guard.

See [local validation and file manifest](../../e2e/results/B-035/local-validation.md) for evidence and the
remaining independent Claude review/device-activation boundary. No commits, pushes, branch operations,
PRs, full `test:rls`, external network calls, remote database operations or deployments were performed.

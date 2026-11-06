# B-036 — Owner LIFF

## Done means

The existing B-033 owner entry, invitation/link transaction and Condola session lead to the existing owner portal. Current `property_owners` authority limits properties and reports on every read, including after ownership changes. Switching company/persona validates the current account mapping server-side; browser preferences never grant a role. Local acceptance requires the five hub Given/When/Then cases plus OFF, foreign scope, cookie loss and recovery regressions. Claude retains independent review and all Git operations; device acceptance remains pending.

Sources: hub `20-build/specs/B-036.md`, hub `05-capabilities/line-tenant-slice-design.md` sections 4–7, and `B-033-design.md` slices 1–2. This delegation permits local edits and disposable DB tests only.

## Flags

Reuse strict `LINE_PLATFORM_ENABLED`, platform/org `line_platform`, and the relevant `line_owner_portal`, `line_tenant_portal` or `line_vendor_portal`. Missing, malformed and OFF deny with 404 before writes. This task supersedes the B-033 bootstrap OFF exception: all three LIFF entries return 404, with the existing Email link still available in the response. Flags remain OFF in shipped configuration.

## Data

No new identity, session, capability or permission table; no migration required. Reuse B-033 flows, step-up, identity/link, session provenance and notification fallback. Owner reads intersect the current org, active owner contact and effective property ownership. Issued reports must belong to the current owner contact, retain current property authority and contain no property lines outside that authority; inaccessible reports are indistinguishable from nonexistent reports. Existing report totals are never partially filtered.

Org unlink disables only that notification link; other org links and Email access remain. Global revoke requires verified Email recovery and password/MFA step-up, revokes identity-issued LINE sessions and all its links, and preserves Email sessions. The existing dispatch service rechecks eligibility and enqueues B-028 Email fallback for queued work; no LINE HTTP is used.

## Routes

- Reuse `/o/liff`, `/api/line/flows`, `/api/line/session`, `/api/line/bind`, `/api/line/invites/accept`, `/api/line/reauth`, `/api/line/links`, `/api/line/links/[id]`, `/api/line/identity`, and webhook handlers.
- Add `POST /api/line/portal`: existing Condola session + browser proof + same-origin CSRF, validated org/persona, current B-033 contact/B-026 account authority and portal gates. Returns an allowlisted next path (or existing consent entry) and preference cookies only. No identity/link/session/role is created. A job token is never an account session.
- Successful B-033 login/invite sets company/persona preferences from the verified server flow. Portal identity resolution rechecks those preferences against current company roles; an owner entry ignores stale tenant lease preference.
- Existing owner properties/home/report/PDF queries enforce property scope; existing tenant my-lease and vendor job/account services remain authoritative.
- Cookie loss starts fresh authentication in that browser. Browser proof, ID tokens and session tokens never appear in URLs or local storage. Only the existing opaque flow handle may survive LIFF redirection.

## Acceptance mapping

All tests live in `src/server/b036-owner-liff.integration.test.ts`, using `cloneTestDatabase()` and `resetAndSeed()` and exported routes where applicable.

| Hub acceptance | Tests |
| --- | --- |
| Owner invite atomically accepted/bound; authorized properties/reports only | Owner accept, replay/rollback, own/foreign property and report/PDF reads, ownership removal, multi-company selection |
| Multi-role switch rechecks role/company | POST portal owner/tenant selection, forged query hints, removed role, foreign company, vendor capability denial, current identity resolver |
| Wrong provider/channel or reused flow creates no mapping | Wrong audience/signature, channel/provider configuration change, replay; identity/link/session snapshots |
| Unfollow sets false without deleting account or reviving unlinked links | Signed exported webhook, stale follow, duplicate and post-unlink follow |
| Email login remains after unlink | Org/global unlink, verified Email session + normal owner reads; global LINE session revocation; queued Email fallback |
| Additional evidence | Strict OFF/kill matrix with write snapshots; missing/stale WebView cookies; CSRF; independent B-033 foundation/login regressions |

## Out of scope

Live LINE/OAuth transport, SDK download, remote DBs, deployment, activation, provider console configuration, device verification, new owner grants, vendor job-to-account promotion, tenant lease expansion, a second identity UI, new product copy, full test:rls, Git commits/pushes/branches and PRs. Existing owner/account UI and localized copy are reused.

## Local validation

See [local validation and handoff](../../e2e/results/B-036/local-validation.md) for the continuation's exact checks, acceptance coverage, file inventory and remaining device/independent QA boundary. All changes remain uncommitted for Claude.

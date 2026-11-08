# B-034 — Tenant LIFF

## Done means

The public `/t/liff` entry uses B-033's browser-bound flows, verified identity/link and existing
`condola_session`. Tenant data remains behind the existing `app.my_tenant_leases()` and portal
guards. Invitation/account conflicts roll back all business effects; required password/MFA and
independent legal consent remain mandatory. Organization unlink redirects queued, unsent work to
Email; global unlink revokes LINE-issued sessions and preserves verified Email recovery.
Lost browser cookies or an expired/consumed handle lead to fresh authentication, never token URLs.
Local captured transports and locally signed HS256 tokens are the only validation providers.

## Flags

Reuse `LINE_PLATFORM_ENABLED`, strict platform/org `line_platform` and the applicable strict
`line_tenant_portal`, `line_vendor_portal`, or `line_owner_portal` gates. Missing, malformed or OFF
API gates return 404 with zero writes. Per this task's strict OFF contract, the bootstrap also returns 404, retaining an Email login link
with no cookies, flow or writes (superseding B-033's 200 bootstrap expectation). No flag activation.

## Data

No second identity/session surface and no migration required: reuse B-033 private flows, step-ups,
identity provenance and atomic link service. Browser-proof loss must not let a caller recover the
scope of an opaque flow. A handle without its matching cookies falls back to Email; explicit public
org entry can issue fresh browser proof and begin a new login. No session/ID token in URLs or storage.
Authorization is rechecked server-side on each exchange. Tenant leases derive from authenticated
user; vendor capabilities remain single-job only and never create B-026 account/staff authority;
owner property authority remains `property_owners`. Role/company hints create no authority.

## Routes / UI

Reuse all exported B-033 `/api/line/*` handlers and public `/t/liff`, `/v/liff`, `/o/liff` route-group
entries. Restore the referenced same-origin bootstrap adapter, wait for SDK init before normalizing
URLs, retain only opaque flow/public org context through login, and confirm cookies through the
existing session exchange followed by authenticated `GET /api/line/links` readback. Require an existing host-provided LIFF adapter; no SDK/CDN or live HTTP.
Invitation/bind flows render an explicit localized credential/consent confirmation form; login
requiring MFA falls back to the existing Email authentication path. Add tenant invite/account
entry controls only behind the existing gates, reuse existing password/MFA text, and add minimal
bilingual LINE consent/unlink labels where necessary. Shared services remain the only mutators.
The owned-link response adds persona and identityId so settings selects the current persona and
explicit identity instead of choosing an arbitrary link. It retains identity-owner and portal gates.
The standalone shell uses the existing brand-v2 theme/logo plus local responsive form styles.
Confirmation uses POST even without JavaScript and remains disabled until the adapter attaches.
Settings never initiates LINE login until binding is selected; unlink remains available without SDK.

## Acceptance mapping

All cases are in `src/server/b034-tenant-liff.integration.test.ts`, using a disposable local clone
and `resetAndSeed()`; route tests call actual exported handlers.

| Given / When / Then | Evidence |
| --- | --- |
| LINE-first tenant / verified binding / own leases only | Invite and login HTTP exchange, cookie attributes, authenticated my-lease helper and foreign lease denial; no staff/vendor/owner promotion. |
| Account conflict / invite acceptance / no partial acceptance or link | Foreign current account and provider conflict; invitation, contact, identity, session and link state unchanged; replay refused. |
| Organization unlink / queued work / Email fallback | Actual DELETE then captured dispatch, deduplicated Email queue, other-company link preserved. |
| Global unlink / apply / LINE sessions revoked, Email recovery retained | Actual DELETE, all provenance sessions revoked, password session and confirmed Email/password unchanged; recovery/MFA denial. |
| Lost WebView cookies / reopen / safe reauthentication, no token URLs | Exported bootstrap with missing/mismatched/expired/consumed cookies and mocked browser adapter; fresh flow, no replay or token storage/navigation. |
| Cross-company/persona and OFF/kill boundaries | Tenant/vendor/owner API matrices, foreign versus missing denials, strict malformed gates, snapshots proving zero writes. |

## Out of scope / activation

No automatic name/Email matching, GoTrue federation, new vendor/account/job grants, owner grants,
remote databases, live LINE transport, deployment, full test:rls, git mutations or PRs. Claude is
architect, independent reviewer and sole committer. iOS/Android WebView and real LINE configuration
acceptance remain Ron/QA prerequisites before activation; local tests do not claim device acceptance.

## Local completion evidence

Implemented without a migration or new route. All five acceptance bullets and persona/OFF boundaries
are covered by 41 disposable-database integration tests. Final checks: typecheck PASS; lint PASS
(16 existing warnings); copy 6/6; unit 1035/1035; B-033 login/link 79/79; foundation 94/94; denial
inventory 28/28. Zero failures/skips. See [local evidence](../../e2e/results/B-034/validation.md)
for changed files, routes, exact logs, initial failures and remaining activation/independent-QA work.
The continuation inspected the preserved diff and reran all required checks against a newly rebuilt
local database; the same counts passed. Current log and source hashes are recorded in the evidence manifest.

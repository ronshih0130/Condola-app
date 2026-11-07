# S3 — portal invite account takeover (acceptPortalInvite)

Branch `fix/s3-portal-invite-takeover` at `origin/main` 44ecf53. Local DB `condola_s3inv` (127.0.0.1:55432) only. Uncommitted at time of writing.

## Scenario

`acceptPortalInvite` (`src/server/auth.ts`) looked up any account by the invite email. If that account had no
password, it set one, then bound the invited contact to it. Nothing checked that the account belonged to this
contact, or that it was already bound to another contact.

Attack (cross-org):

1. An ORG2 tenant login exists with no password yet. This is the normal state after `createLease` and before the tenant accepts their own invite.
2. An ORG1 manager creates an owner (`createOwner`), changes its email to the tenant's address (`updateOwner`, `props.edit`) and copies an owner portal link (`issuePortalInvite` returns the raw token to staff).
3. The manager accepts the link with a password they choose.

Result on main: the ORG2 tenant's login gets the attacker's password, the ORG1 owner contact is bound to it, a
session is issued, and the attacker can sign in as that user, including as the ORG2 tenant. The real tenant is locked out.
The same thing works inside one firm. Introduced in 8bc053c ("Rebase owner contact invites onto main.").
That commit was meant to let an activated tenant who proves their existing password also accept an owner invite.

## Regression test

`src/server/s3-portal-invite-takeover.integration.test.ts` (registered in `test:rls`). It uses the same fixtures
as `portal-invite.integration.test.ts`: `resetAndSeed`, a staff `Session`, `issuePortalInvite` and `acceptInvite`.
Each refusal test first collects every effect (password hash before/after, login email, sessions added, owner-contact
binding, victim-contact binding, invite status, whether the attacker password signs in). It then compares them all at once,
so a failure shows the whole takeover.

| # | Test | main (44ecf53) | fixed |
|---|------|----------------|-------|
| 1 | cross-org: an owner invite cannot set a password on another firm's unactivated tenant login | **FAIL**: ok=true, session token, passwordHashChanged=true, owner contact bound to victim, sessionsAdded=1, invite accepted, attacker password signs in | PASS |
| 2 | same-org: an owner invite cannot set a password on an unactivated tenant login of this firm | **FAIL**: same effects as #1 | PASS |
| 3 | a login already bound to another contact is not rewritten without its password (defence in depth: shared login with minted address, so no account matches the shown email) | **FAIL**: ok=true, an *activated* password overwritten, login email changed, sessionsAdded=1, attacker password signs in | PASS |
| 4 | an activated tenant in another firm adds the owner role only with the correct password (wrong → `auth`, no bind, hash unchanged; correct → bound, tenant contact kept, hash unchanged) | PASS | PASS |
| 5 | an owner's own unactivated login still gets its first password from the link | PASS | PASS |
| 6 | a brand-new email creates a login, and replaying the used link changes nothing (replay → `used`, hash and sessions unchanged) | PASS | PASS |

Counts: main **3 pass / 3 fail**. Fixed **6 pass / 0 fail**.

Refused acceptances return the existing `{ ok: false, error: "auth", kind: "owner" }` with no session token. No copy changed.

## What changed

`src/server/auth.ts`, `acceptPortalInvite` only:

1. Before the transaction: if an account exists for the target email, has no password, and is not this contact's own
   login (`existing.id !== row.user_id`), the function refuses. It calls `notePortalReject` and returns the existing `auth` error.
   It sets no password and binds nothing.
2. Inside the transaction, when an existing login is reused without a verified password: if that login is already bound to
   any other contact (`contacts.user_id = login AND id <> invited contact`), the function rolls back. It returns the existing
   `conflict` result, which maps to `auth`, before any `auth.users` or `contacts` write.
   A verified password (`has_password && matches`) skips this check, so the dual-role case still works.

The password-update branch condition changed from `!existing?.has_password` to the equivalent `!passwordVerified`.
A wrong password already returns before this point, so both conditions select the same cases.

`package.json`: appended the new file to `test:rls`. No migration and no flag. No copy, consent or privacy text changed.

## Validation (fixed tree, DB `condola_s3inv`)

- `s3-portal-invite-takeover.integration.test.ts` 6/6
- `portal-invite.integration.test.ts` 16/16
- `auth.integration.test.ts` 18/18
- `signup.integration.test.ts` 1/1, `signup-gotrue.integration.test.ts` 3/3
- Other `acceptInvite` callers: `property-owner.integration` 1/1, `team-invite-link.integration` 15/15, `team-invite-allowlist.integration` 7/7, `team-invites.test` 8/8, `consent.test` 11/11
- `npm run typecheck` exit 0; `npm run lint` 0 errors (15 warnings, none in touched files); `npm run copy:check` 6/6; `npm run test:unit` 895/895

## Not addressed (product decisions / residual risk)

- **Staff-held raw owner tokens and manager-issued owner invites.** A manager can still point an owner contact at an address
  that has no account yet and accept the link themselves. That creates a login under someone else's email (email squatting).
  Later invites to that address must then prove the squatter's password. Who may issue invites, and whether staff should see raw tokens, is a separate product decision.
- **Dual-role person who has not activated yet.** A tenant with a provisioned, passwordless login who receives an owner invite
  for the same email is now refused with the existing `auth` error. They must first accept their own tenant invite, then accept
  the owner invite with that password. The existing `auth` copy may not explain this. Product/copy follow-up, not changed here.
- **Own-login rewrite.** An invite for the contact's *own* login still sets a password without proof when that login has no password (intended first activation).
  It does the same when no account matches the shown email and the login serves only this contact. That second case was already possible before this fix and is narrow (minted login address).
- **TOCTOU.** `has_password` is read before the transaction, as before. A concurrent first activation of the same own login could be overwritten. This was already possible and is narrow.
- Archived contacts still count as "bound elsewhere". This refuses more cases, not fewer.

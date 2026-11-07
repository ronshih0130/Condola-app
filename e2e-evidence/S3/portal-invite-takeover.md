# S3 — portal invite account takeover (acceptPortalInvite)

Branch `fix/s3-portal-invite-takeover` at `origin/main` 44ecf53. Local DB `condola_s3inv` (127.0.0.1:55432) only. Round 0 committed as eb2421f (Draft PR #93). Round 1 (review fix) uncommitted at time of writing.

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

## Review fix round 1 (after eb2421f)

An independent security review of eb2421f returned FAIL. It found one blocker, one major issue and two minor ones. Its probes
(`rv93/probe93.integration.test.ts`) confirmed P1 and P2 on eb2421f: `ok=true`, hash changed, attacker signs in.

### BLOCKER 1: same takeover through team invites

`upsertInvitedUser` (called by `acceptTeamInvite`) gave an existing passwordless account a password, on both the local
SQL path and the hosted GoTrue `PUT /admin/users/{id}` path. It then added `org_members` and issued a session.
The admin holds the raw team link.

Fix: the account lookup now also returns `claimed`, meaning the account is bound to any contact or has any `org_members` row.
A passwordless account that is `claimed` returns `null`, so `acceptTeamInvite` gives the existing `auth` error. This runs before
either path writes anything or calls GoTrue. An existing password must still match, as before. An unclaimed passwordless account
or a brand-new email still accepts.

### MAJOR 2: contacts.user_id writable by the API role

The `team_write` policy plus the table grant let staff `UPDATE contacts SET user_id` as `authenticated`. The portal fix trusts
`row.user_id` as "this contact's own login", so a direct write could aim an invite at any login.

Every legitimate writer, with the DB role it uses:

| Writer | Statement | Role |
|---|---|---|
| `acceptPortalInvite` bind (auth.ts) | `UPDATE contacts SET user_id` | connection owner (withClient, no role switch) |
| `seed.ts` / `resetAndSeed` | `INSERT … user_id` | connection owner |
| `sandbox-seed.ts` | `INSERT … user_id = NULL` | NULL only |
| `createLease` → `insertTenantContact` (domain.ts:789) | `INSERT contacts (user_id …)` with a login just made by `app.provision_portal_user` | **authenticated** (tx) |
| `createLease` → `attachPortalUser` (domain.ts:821) | `UPDATE contacts SET user_id WHERE user_id IS NULL` with a login just provisioned | **authenticated** (tx) |
| SQL functions in migrations | none write `contacts.user_id` (b015 directory edit changes name/email/phone only) | n/a |

Two legitimate `createLease` paths write `user_id` as `authenticated`. A column-level REVOKE would therefore break lease
creation, so the migration does not use one. Migration `20261107160000_s3_contacts_user_id_guard.sql` instead adds a private
`SECURITY DEFINER` trigger, following the b009 pattern. It applies only to `anon`/`authenticated`, with the caller taken from the
`role` setting and falling back to `session_user`. Under those roles it allows a `user_id` write only when the value is unchanged,
when an insert sets NULL, or when the change is NULL → a login that:
- was created in this same transaction (`auth.users.created_at = now()`, which `provision_portal_user` sets),
- has no password,
- is bound to no other contact.

Everything else raises `42501`. `service_role` and owners are unaffected. Function EXECUTE is revoked from PUBLIC, anon,
authenticated and service_role. The migration is registered in `scripts/write-pr-migrations.mjs` and the `lease-rules.test.ts`
migration list. It adds no table, column, grant or flag.

### MINOR: shown-email order

`issuePortalInvite` shows `portalShownEmail(contactEmail, loginEmail)`, so the contact email comes first. Acceptance looks up
`portalShownEmail(login_email, contact_email)`, so the login email comes first. **Not changed; documented here.** Switching
acceptance to contact-first would change which account is checked whenever both addresses are real and differ. That is not
behaviour-preserving, and it would move the password check away from the bound login. The visible effect: when the two
addresses differ, the page shows the contact email but asks for the login account's password.

### MINOR: unlocked "bound elsewhere" check, plus a related gap

When an existing login is reused without a verified password, acceptance now locks the `auth.users` row (`FOR UPDATE`) and
re-reads `has_password` inside the transaction. The "bound elsewhere" read is now `FOR SHARE`. This also closes two round-0
residuals:
- **TOCTOU:** a password set between the lookup and the write is now caught.
- **Own-login rewrite:** previously, when no account matched the shown email (a minted login address), the contact's own
  *activated* login could get a new password without proof. Now refused.

### Round-1 tests (`s3-portal-invite-takeover.integration.test.ts`, now 11 tests)

| # | Test | eb2421f | round 1 |
|---|------|---------|---------|
| 7 | an owner's own activated login is not given a new password when no account matches the shown email | **FAIL**: ok=true, password changed, login email changed, session, attacker signs in | PASS |
| 8 | team invite: an admin cannot set a password on another firm's unactivated tenant login (P1) | **FAIL**: ok=true, hash changed, ORG1 membership `active`, session, invite accepted, attacker signs in | PASS |
| 9 | team invite: an unclaimed passwordless login and a brand-new email still accept | PASS | PASS |
| 10 | staff cannot point a contact at an existing login through the API role (P2; also INSERT with user_id, unbind, move; same-value write still allowed; refusals must be `42501`) | **FAIL**: writeRejected=false, hash changed, session, attacker signs in | PASS |
| 11 | the API role may still attach a login it created in the same transaction (createLease INSERT and attachPortalUser UPDATE statement sequences) | PASS | PASS |

Counts: eb2421f **8 pass / 3 fail**. Round 1 **11 pass / 0 fail**. Tests 1–6 from round 0 still pass.

There is also a hosted-path unit test in `team-invites.test.ts`: "a passwordless login that serves a contact or a firm never
gets a password from a team invite". It runs with the GoTrue URL set and unset, and requires: no fetch, no INSERT/UPDATE,
`upsertInvitedUser` → null, and `acceptTeamInvite` → `auth` with ROLLBACK. It fails with the new check disabled (verified)
and passes with it.

Reviewer probes on the round-1 tree:
- P1 `ok=false/auth`, no hash change, no attacker sign-in.
- P2: the direct write is refused ("contacts.user_id is assigned by the server"). The invite then goes to the decoy address,
  the orphan's hash is unchanged, and the attacker cannot sign in.
- P2b now throws at the probe's unguarded direct write. That is the guard working.
- P3–P6 unchanged (refused / victim wins).

### Round-1 validation (fresh `condola_s3inv` with the new migration)

- s3-portal-invite-takeover 11/11, portal-invite.integration 16/16, auth.integration 18/18
- signup.integration 1/1, signup-gotrue.integration 3/3
- team-invite-link.integration 15/15, team-invite-allowlist.integration 7/7, team-invites 9/9, consent 11/11, property-owner.integration 1/1
- function-privileges 7/7, rpc-exposure 3/3, lease-rules 9/9, write-pr-migrations.test 2/2
- createLease and contact paths: lease-create.integration 4/4, lease-create-archive.integration 9/9, rls 8/8, sandbox-rls 4/4, org-isolation.integration 3/3, import.integration 18/18, onboarding-progress.integration 1/1
- typecheck exit 0; lint 0 errors (15 warnings, none in touched files); copy:check 6/6; test:unit 896/896

## Not addressed (product decisions / residual risk)

- **Staff-held raw tokens (owner, tenant and team).** A manager or admin can still invite an address that has no account yet and
  accept the link themselves. That creates a login under someone else's email (email squatting), and later invites to that
  address must then prove the squatter's password. Through a team invite the same applies to an *unclaimed* passwordless
  account: one bound to no contact and no firm (an orphan, e.g. its contact was deleted). Who may issue invites, and whether
  staff see raw tokens, is a separate product decision.
- **Dual-role person who has not activated yet.** A tenant with a provisioned, passwordless login who receives an owner invite
  or a team invite for the same email is refused with the existing `auth` error. They must first accept their own tenant
  invite, then accept the second invite with that password. The existing `auth` copy may not explain this. Product/copy
  follow-up, not changed here.
- **Shown-email order mismatch** (see above). Documented, not changed.
- **First activation of an own passwordless login** still sets a password without proof. This is intended: the invite was
  issued for exactly that login, and staff can no longer repoint `user_id` through the API.
- **The trigger's freshness test is `created_at = now()`.** A login made in a different transaction with an identical
  transaction-start timestamp would pass. That is not realistic, and such a login would still need to be passwordless and
  unbound.
- Archived contacts still count as "bound" for the acceptance check and the trigger. This refuses more cases, not fewer.
- The GoTrue hosted path was exercised only through the unit test with a fake client and fetch, not against a live GoTrue.

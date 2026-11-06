# B-031 — Audit, upload and session reliability (L2 design)

> Author: Claude (Mac Session 2, 2026-11-06 PT). Hub spec `20-build/specs/B-031.md`; capabilities CAP-P-19/20/21/24
> (PLT-07/08/09). Stacked on #39 (`feat/b-001-id-sign-gate`). Closes hub `BLK-MAC-14` (credential epoch) in slice 1.

## Slices

| Slice | Package | Flag (default OFF) | Status |
|---|---|---|---|
| 1 | SESSION_HARDENING — credential epoch fencing every password-authenticated session / challenge path; token-free logs | `session_hardening` | in progress |
| 2 | AUDIT_DETAIL — authorized before/after/reason audit detail with masking and role filtering | `audit_detail` | planned |
| 3 | UPLOAD_RECOVERY — retry-safe uploads (no duplicates, successful parts kept) | `upload_recovery` | planned |

Out of scope (all slices): legal/consent copy edits, production deletion, browser storage of secrets/session tokens,
retention-policy changes needing Ron/legal decisions (CAP-P-21 regional retention values stay as already approved).

## Slice 1 — SESSION_HARDENING (credential epoch)

**Problem (BLK-MAC-14).** A login, signup or invitation that verified the old password before a password change can
still create a session afterwards; an MFA enrollment/2FA challenge opened before the change can still write MFA
secrets/backup codes and a session. Password change itself revokes other sessions, but in-flight flows bypass it.

**Model.** Private table `app.b031_credential_epochs(user_id PK → auth.users ON DELETE CASCADE, epoch bigint,
changed_at)`; missing row = epoch 0. Private side table `app.b031_challenge_epochs(challenge_id PK →
auth_challenges ON DELETE CASCADE, user_id, epoch)` (no new column on `auth_challenges`, so the flag-OFF schema
contract of existing tables is unchanged).

**Rules (flag ON only; global `platform_settings.session_hardening.enabled === true`).**
1. *Capture before verify.* Every password-verifying flow first commits any due reconciliation, reads the user's epoch **before** checking the password and
   carries it to the step that creates a session or challenge.
2. *Fenced create.* Session INSERT, challenge INSERT and the MFA secret/backup-code write happen in one transaction
   that locks the user's epoch row (`FOR SHARE`, row created on demand) and rejects (`credentials_changed`) when the
   current epoch differs from the captured one. Challenges record their captured epoch in the side table;
   completing a challenge requires that epoch to still be current.
3. *Durable two-phase change.* Password changes, resets and passwordless existing-account invitation acceptance
   use `app.b031_credential_changes(id uuid PK, user_id, state, started_at, finished_at)`. States are `pending`,
   `done`, `failed`, `unknown`; a partial unique index permits at most one pending or unresolved unknown change per user.
   `unknown` with NULL `finished_at` stays fenced; reconciliation stamps `finished_at` once. This table has
   RLS, no public/anon/authenticated/service-role table privileges, and service-role-only SECURITY DEFINER helpers.
   Phase 1 takes the epoch exclusively **first**, validates the captured epoch/authorization, bumps the epoch,
   inserts pending, revokes all sessions (except the caller's own for self-service change), deletes challenges,
   consumes reset tokens when applicable, and **commits**. No password provider call happens before this commit.
   The provider then runs outside any transaction or invitation/organization/epoch lock. Hosted admin updates use
   an absolute budget of persisted `started_at + 90 seconds`, including phase-1 commit, connection waits and pauses.
   An expired budget skips the provider call. HTTP uses an abort signal for the remaining budget (headers + body).
   Local SQL uses its own short transaction, remaining-budget `statement_timeout` and idle transaction timeout,
   plus a server deadline guard immediately before COMMIT. A configured hosted URL without a service-role key
   rejects before any write; SQL password updates are allowed only with no hosted URL.
   A new invited identity is first provisioned **without a password** (GoTrue POST when hosted, the existing local
   provisioning helper otherwise), after invitation validation and outside locks. It then uses the same two phases;
   phase 1 rechecks that the account is still passwordless, so a concurrent established password is never replaced.
   Phase 2 takes the epoch exclusively, bumps it again, repeats revocation/challenge deletion, and records the
   result: `done` for success, `failed` for definite 4xx rejection (except ambiguous 408), `unknown` for timeout,
   network/lost response or ambiguous provider 5xx. Only `done` succeeds; failures use existing error results/copy.
   **Phase 2 commits independently before invitation acceptance.** Acceptance and session creation use a separate
   transaction fenced at the epoch returned by phase 2. Revoked/expired invites, exhausted seats, conflicts,
   timeouts or other acceptance rollbacks leave the account consistent with its new password and no new session.
   If finish arrives after reconciliation, it still bumps/revokes, including sessions created since `started_at`,
   and returns success for a demonstrated provider success; reset/change never expose P0B31 for this case.
4. *Ordering and recovery.* Every hardened path locks epoch first, then organization (team seats), invitation,
   account/member/contact, challenge/MFA and session as applicable. Established-password acceptance follows
   the same order as passwordless acceptance. Creates hold `FOR SHARE` until commit; changes/recovery take
   the epoch exclusively. Team phase 1/provider/phase 2 run before opening the acceptance client. No invitation
   advisory or database lock spans HTTP.
   The fence rejects P0B31 for a mismatched epoch, pending change, or unresolved unknown. Pending/unknown become
   recoverable at **120 seconds**, leaving 30 seconds beyond the provider budget. Capture, sign-in, acceptance
   and `lockCredentialEpoch` automatically run bounded recovery in its own transaction **before** fencing;
   rejection/rollback of the stale request cannot undo it. The SQL lock helper also checks recovery before locking.
   Reconciliation rechecks under the exclusive epoch row lock, marks unknown resolved, bumps and revokes all
   sessions/challenges once; concurrent/repeated recovery is idempotent. A later finish bumps/revokes again.
   Unknown does not immediately reopen the fence, even if the client timed out while the provider was committing.
   Phase-2 failure never rolls back phase-1 revocation. A create before phase 1 is revoked there; none can commit
   during pending/unresolved unknown. Phase 2 also revokes sessions from unfenced paths during the provider gap.
   All seven SECURITY DEFINER helpers use `search_path = pg_catalog, pg_temp` and qualified relations.
5. *No token logging.* Rejections log only an error kind; never tokens, hashes, challenge ids or emails.

**Flag OFF:** no epoch rows written, no side-table rows, existing SQL unchanged apart from one flag read per flow.

**Paths fenced (password-authenticated):** `signIn` → `continueSignIn` (direct session, 2FA challenge, enroll
challenge); `completeSecondFactor` (2FA + enroll, incl. user_mfa write); password-verified signup paths in
`signup.ts` that end in `createSession` (existing-account consent and metadata are written in that same fenced transaction); invitation acceptance paths that verify or set a password before a session;
password-reset completion and self-service password change bump the epoch. LINE demo sign-in and token-only magic
paths are not password-authenticated and stay unfenced (documented).

**#65 compatibility (B-020 slice 2).** B-020's tenant password change must use the same durable begin/provider/finish
protocol when stacked. Calling only `app.b031_bump_credential_epoch(uuid)` around a hosted write is insufficient.

**Tests.** Deterministic interleavings for each fenced path (capture → concurrent change → create fails, zero
sessions/challenges/user_mfa rows); bump/create ordering with a held lock; 16 complete OFF SQL traces against the
pre-B031 fixture; private-table/function privilege checks; log scan for tokens. A `node:http` GoTrue stand-in binds
only `127.0.0.1`: change/reset/team/tenant tests cover success, definite rejection, provider commit with lost response,
and injected local phase-2 failure. They prove phase-1 durability, no epoch lock during HTTP, blocked concurrent
login, no accepted invitation session before phase-2 commit, eventual reconciliation, and login with the password
actually held by the provider. Missing hosted keys reject with zero writes; abandonment reconciles exactly once.

**Fix round 4 regression coverage.** Production reset protocols drive stale login, 2FA, enrollment, signup and
invitation fences. Recovery tests call production login/fence entrypoints, never the reconcile helper; fixtures
advance persisted protocol timestamps to exercise the 90/120-second boundaries without wall-clock sleeps.
Independent acceptance rollback after committed finish covers revoked team/portal invites and exhausted seats.
Same-invite double submissions use distinct connections for both established and passwordless accounts.
Additional cases cover expired budgets (no provider write), local SQL lock timeout rollback, a provider commit
between budget expiry and recovery, concurrent recovery winners, delayed reset/change finish after recovery,
and zero consent/metadata writes on stale signup rejection. All 16 OFF trace fixtures stay unchanged.

**Round 4 local validation (2026-11-06 PT).** Fresh loopback PostgreSQL database `condola_b031impl`, stub + all
migrations + seed; integration files each executed separately with `--test-concurrency=1`:
B-031 **94/94** (including all 16 unchanged OFF SQL traces), auth **18/18**, signup **1/1**,
team-invite-allowlist **7/7**, portal-invite **16/16**, property-owner **1/1**. Unit **985/985**;
copy **6/6**; typecheck PASS; lint PASS (0 errors, 15 existing warnings). No full `test:rls`, remote DB,
deployment, external network calls or git mutations. Independent Claude review remains pending.

**Remaining provider-contract limitation.** HTTP abort bounds the application's request lifetime; it cannot
prove that an independently committing GoTrue server stopped processing the request. Tests cover a late write
inside the 90–120 second margin and a late successful finish after reconciliation. They do not establish safety
for an orphaned upstream write *after* reconciliation with no later finish callback. Before flag activation,
Claude must resolve this with a provider-enforced commit deadline or additional provider-aware fencing.
No such hosted-provider guarantee was added or remotely verified in this local-only round.

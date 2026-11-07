# B-031 — Audit, upload and session reliability (L2 design)

> Author: Claude (Mac Session 2, 2026-11-06 PT). Hub spec `20-build/specs/B-031.md`; capabilities CAP-P-19/20/21/24
> (PLT-07/08/09). Stacked on #39 (`feat/b-001-id-sign-gate`). Closes hub `BLK-MAC-14` (credential epoch) in slice 1.

## Slices

| Slice | Package | Flag (default OFF) | Status |
|---|---|---|---|
| 1 | SESSION_HARDENING — credential epoch fencing every password-authenticated session / challenge path; token-free logs | `session_hardening` | in progress |
| 2 | AUDIT_DETAIL — authorized before/after/reason audit detail with masking and role filtering | `audit_detail` | planned |
| 3 | UPLOAD_RECOVERY — retry-safe uploads (no duplicates, successful parts kept) | `upload_recovery` | implemented (local) |

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

## Slice 3 — UPLOAD_RECOVERY

**Problem.** Repair-ticket photos upload one file per sign → PUT → confirm round trip, and the confirm attaches at
once. A lost response after the PUT or after confirm makes the browser retry with a *new* signed path, so a file
that already succeeded is stored (and possibly attached) twice; a mid-batch failure leaves the user unsure which
photos made it. ID photos already use fixed per-slot rows (`id_upload_slots`, PK user+lease+slot) and are not changed.

**Model (migration `20261107133000_b031_upload_recovery.sql`, additive).** `platform_settings.upload_recovery`
`{"enabled":false,"allowed_org_ids":[]}`. Private `app.b031_upload_batches` (server id; unique
`(org_id, owner_user_id, client_batch_key)`; FK `(org_id, ticket_id)` → `maintenance_tickets` ON DELETE CASCADE;
draft field `internal`; `submitted_at`) and `app.b031_upload_items` (unique `(org_id, batch_id, client_key)`, unique
`storage_path`, state `signed → uploaded → attached`, `attachment_id` set iff attached). Both tables: RLS on, no
policies, ALL revoked from PUBLIC/anon/authenticated/service_role. Access only through SECURITY DEFINER gateways
(`search_path = pg_catalog, pg_temp`) granted to `authenticated`: `open_batch`, `reserve`, `items_for`, `open_draft`,
`mark_uploaded`, `lock_batch`, `mark_attached`, `close_batch`; internal helpers `own_batch` / `actor_ok` and the flag
reader `upload_recovery_on` (service_role only) are not executable by API roles. Every gateway re-checks the strict
flag, `auth.uid()`, the pinned `app.active_org_id`, ticket-in-org, and the existing actor rule (staff with
admin/manager/maintenance via `app.has_role`, or a non-member tenant via `app.tenant_owns_ticket`; internal = staff
only). Batches are always resolved by `(org, auth.uid(), client batch key)`, so another user's key never resolves.

**Flow (flag ON).** The browser generates a random batch key per draft and a random client key per selected file
(`crypto.randomUUID`, memory only; nothing in browser storage). `prepare` reserves (or replays) the key: a replay
returns the original path/state; `uploaded`/`attached` → skip; object already in storage → `stored` (confirm, no PUT);
otherwise sign the *same* path. `confirm` verifies size/type/magic bytes exactly like the existing confirm and marks
`uploaded` (a rejected object under the caller's own unattached path is removed). Final `submit` locks the batch,
inserts `files` + `ticket_attachments` for every uploaded item **through the caller's existing RLS** (same SQL as
`attachRepairPhoto`; the 8-photo trigger and path trigger still apply), marks each attached and closes the batch, all in
one transaction. A replay of a submitted batch returns the same ids and writes nothing; concurrent submits serialise on
the batch row. Only `uploaded` items hold a photo slot: reserve and confirm each check attachments + this draft's uploaded items < 8 (at most 16 unattached rows per draft); the existing trigger remains the cross-draft backstop.
Draft: the batch row keeps the `internal` field and the per-file states; the ticket page restores the caller's latest
open draft (uploaded files stay uploaded; a `signed` file shows "choose again"). A failed submit rolls back and keeps
the draft. UI: per-file status (waiting / uploading / uploaded / failed / added), "Retry failed files" re-sends only
failed files under their original keys, then "Add N uploaded photos". EN + zh-TW copy in `src/i18n/upload-recovery.ts`.

**Flows covered.** Staff ticket page (`/m/tickets/[id]`) and tenant repair page (`/t/repair`) photo upload through
the new `/api/tickets/photos/batch` route. **Not covered:** vendor-link photos (`/api/vendor-jobs/photos/*`,
token-auth, no user owner for the draft), handover upload, paper-lease/e-sign PDF, import, bank CSV (single-file
forms) and ID photos (already slot-keyed; untouched, retention policy unchanged). Existing sign/confirm routes,
`TicketPhotoUpload`, `attachRepairPhoto` and the ticket-photo read RLS are unchanged (no read widened).

**Orphans.** If the PUT lands but the DB step is lost, the object stays in storage under a path recorded on a `signed`
item and is never attached (no `files` row). A retry with the same key, or a page reload (restore probes storage for
`signed` items and verifies/adopts them), picks it up without a second object. Closing a draft — submit or the owner's
discard — deletes every unattached row and removes its reserved object after commit (best effort). Only a draft that is
never submitted or discarded keeps its rows/objects; no time-based cleanup job was built (retention window and
background storage deletion need a Ron decision). Every such orphan is discoverable from `app.b031_upload_items`.

**Flag OFF.** Pages call `ticketPhotoRecovery` (one flag read, returns null) and render the base `TicketPhotoUpload`
element verbatim; gateways refuse in SQL; zero writes. Route order (precise): no session → 401; the repo-wide consent
gate (required to dominate every route body by `consent-entrypoints.test.ts`) → its existing response; then
`handleUploadBatch` performs exactly one flag read and answers 404 for every op. The only SQL before the flag read is
the standard `readSession` lookup/last-active touch every authenticated request already performs. The existing
confirm/detail SQL traces are identical OFF and ON (`src/server/fixtures/b031-upload-off-sql.json`).

**Local validation (2026-11-06 PT, DB `condola_b031u`).** New integration file 7/7; unit 988/988 (incl. OFF render
golden 3/3); typecheck PASS; lint 0 errors (15 existing warnings); copy 6/6; function-privilege gate PASS; existing
repair 1/1, vendor-repair 4/4, tenant-payment-history 9/9, reminder-seed 2/2, B-031 slice 1 94/94, rls 8/8,
helper-execute 2/2, function-org-guard 4/4. No browser run, remote storage or network. Evidence:
`e2e-evidence/B-031/upload-recovery-checkpoint.md`.

**Fix round 1 (independent Claude review FAIL: 1 MAJOR, 5 MINOR).**
M1 stuck drafts: `signed` items no longer count toward the limit (checked again at confirm); new owner-scoped
gateway `app.b031_upload_discard_item` (remove one unattached file from an open draft) and
`app.b031_upload_close_batch(org, key, discard)` (submit close or discard-without-attach; deletes unattached rows and
returns their paths; new column `discarded`). UI: per-file Remove and "Discard these photos"; a submit rejected by the
8-photo trigger shows the trim message and stays recoverable. MINOR 1: locking gateways `SET lock_timeout = '3s'`; the
service transaction sets lock 3 s / statement 8 s and maps 55P03/57014 to `errors.busy` (UI busy copy). MINOR 2: route
order documented above and tested at the handler (OFF: 6 ops × exactly one flag read → 404, zero rows). MINOR 3: "kept"
copy only when a restored file is `uploaded`. MINOR 4: restore adopts stored objects. MINOR 5: a closed draft (lost
submit response, other tab) makes `prepare` answer `closed` (SQLSTATE P0B33); the client rotates to a new draft key,
refreshes, drops rows that no longer exist and re-sends the file once.
Validation round 1 (`condola_b031u`, fresh): integration 13/13 (reviewer probes A–E reproduced as regressions; probe file
also passes 5/5 with the intended outcomes); unit 989/989 (OFF/UI source checks 4/4); typecheck PASS; lint 0 errors
(15 existing warnings); copy 6/6; function-privilege gate PASS; repair 1/1, vendor-repair 4/4, tenant-payment-history
9/9, reminder-seed 2/2, B-031 slice 1 94/94, rls 8/8, helper-execute 2/2, function-org-guard 4/4.

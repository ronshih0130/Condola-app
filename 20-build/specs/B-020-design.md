# B-020 — JIT L2 設計稿：租客帳號、登入裝置與資料請求（slices 1–2）

> Author: Claude (Mac overnight, 2026-11-06 PT). Layer-2 design for hub `20-build/specs/B-020.md` (CAP-T-13). Flag `tenant_account_settings` (TENANT_ACCOUNT_SETTINGS*) seeded OFF. Branch cut from #36 (`d374bb6`), independent (notification preferences reuse the existing `/t/reminders` B-010 preferences; B-028 integration comes later).

## Done means (slice 1)

With the flag ON for a local test org, a tenant opens `/t/account`, sees their own signed-in sessions and signs out another device — that session is immediately unusable (`session.ts` already rejects revoked sessions). The current session cannot be revoked there, and another user's session never can. A data request (export / correction / deletion) is one trackable row per kind while open; a retry returns the same row. Forged user/org identifiers are ignored: every RPC derives the user from `auth.uid()` and the organization from the exact org/env pin plus the caller's own active tenant contact. Flag OFF: `/t/account` 404s and every RPC refuses.

## Design

Migration `20261106140000_b020_tenant_account.sql`: flag seed OFF; private `app.b020_data_requests` (RLS on, REVOKE ALL; partial unique open request per (org, user, kind)); internal `app.b020_admit` (flag `IS NOT TRUE` ⇒ OFF, pin, tenant contact); RPCs `app.b020_my_sessions`, `app.b020_revoke_session(org, session, current)`, `app.b020_submit_data_request(org, request, kind)`, `app.b020_my_data_requests(org)` — all SECURITY DEFINER with pinned search_path, EXECUTE to `authenticated` only. Server `src/server/tenant-account.ts`, consent-guarded action, page `/t/account` with new non-legal copy (`src/i18n/tenant-account.ts`).

## Not in this slice (logged)

- **Data-request UI**: labels and explanations for export/correction/deletion are privacy wording; AGENTS.md forbids privacy/terms/consent text edits without approved copy → backend only; UI waits for approved copy (hub BLK-MAC-09).
- Optional-event preference evaluation beyond the existing reminder preferences (needs B-028). Profile/password work is covered by slice 2 below.

## Cross-review (Codex QA)

r1 FAIL: reused open request did not bind the new request id → fixed with private `app.b020_request_ids` (every accepted id bound inside the locked transaction); LOW concurrency test added → **r2 PASS**.


## Slice 2 done-means (local implementation, 2026-11-06 PT)

When `tenant_account_settings` is explicitly enabled for the pinned organization, `/t/account` offers display-name and E.164 phone editing with an optimistic version, plus current-password re-entry and password change. Submitted identity fields are ignored; user, organization, environment and current session come only from the resolved server session. The database rechecks an eligible non-archived tenant contact, matching org/environment, live session and both flags. Missing, null, malformed and false flags deny writes.

`app.b020_tenant_profiles` holds account-only overrides keyed by org/contact/user. Initial values come from the contact; saving changes the account view only. Existing contact, identity email, lease views and other `/t` displays retain their current sources. Storage is private (RLS and REVOKE ALL); service-only SECURITY DEFINER gateways use pinned search paths. Flag and authority rows are locked through commit. Concurrent saves with one version produce one update and one stale response. Profile writes and password changes lock user before contact to avoid inversion.

Recent authentication means re-entering the current password on every change; session creation/activity timestamps alone never authorize it. An older active session may proceed with a correct current password. The server reuses `password.ts` and `lockout.ts` (five failures, fifteen minutes), with a 72-byte bound on new passwords to avoid bcrypt truncation; existing long passwords remain usable for reauthentication. Password update and slice-1 revocation of all existing other application sessions commit atomically, preserving the current session. Failure counters persist on wrong passwords; an audit failure rolls back the password and revocations. No provider calls or email sends are involved.

New mutation entrypoints resolve the session in a read-only transaction with `touch:false`, then pass it to the existing gate. Existing layout/session bookkeeping on ordinary page navigation is unchanged. `requireOrgScope` pins each mutation transaction. `recordAudit` stores operation metadata only, with no submitted name, phone, credential or hash.

Additive migration: `20261106210000_b020_tenant_profile.sql`; registered in the migration classification, lease-rules expectation and seed wipe list. Test entrypoints are registered in `test:unit` and `test:rls`. The flag remains OFF.

## Slice 2 initial verification (superseded by QA r1 below)

Local disposable database: `127.0.0.1:55432/condola_b020s2`. Stub and all migrations applied in order, followed by `npm run db:reset`. Targeted integration run: **32 passed, 0 failed** across `b020-tenant-profile`, `b020-tenant-account` and `auth`; this includes OFF zero-write snapshots, identity forgery, archive/role/org/environment denial, expired/revoked sessions, current-password and weak-password denials, lockout/expiry, other-session revocation, version conflicts, concurrent profile/password writes, existing long passwords and transactional audit rollback.

Typecheck PASS; lint PASS (0 errors, 15 existing warnings); copy check 6/6 PASS; full unit suite 983/983 PASS; function-privilege check PASS (full migration replay). Logs are under `/private/tmp/b020s2-*.log`. The entrypoint guard test initially rejected the read-only loader before the required first-statement guard; loading inside the guard and caching the session resolved it without weakening that test. Native independent source review found and then verified fixes for pre-admission session touches, long-current-password rejection and user/contact lock inversion; no new blocking source defect remained. This supplements the required Claude QA; it does not replace it.

## Slice 2 remaining

- Claude independent QA, browser acceptance and any staging/release gates remain pending; no release or whole-B-020 completion is claimed.
- The password-login/session race identified in QA r1 is fenced below; it is not deferred to B-031. Broader B-031 SESSION_HARDENING work (challenge single-consumption, transactional MFA enrollment/backup-code side effects, other authentication mechanisms) remains outside this password-change repair. Legacy challenges with no credential snapshot fail closed and require a fresh login.
- Profile overrides intentionally affect the account view only; broader contact/identity propagation requires a separate scope decision.
- Existing BLK-MAC-09 and B-028 dependencies above remain unchanged.
- Claude retains ops-lock and sole commit/push authority. STOP POINT: LOCAL_VERIFIED; next: Claude reviews the local diff and validation evidence; owner: Claude@ron-mac.


## Slice 2 QA r1 → local fixes (2026-11-06 PT)

Independent QA `/tmp/codex-qa-B-020s2.md`: **FAIL** (three blockers, two low findings). This section records the repair and local checks; the independent re-review is still pending.

- **Hash cost:** the new password-change function parses the stored bcrypt cost (`$2a$NN$`, also accepts `2b`/`2y`) and generates a new salt with `greatest(stored_cost, 10)`. Fixtures verify cost 6 becomes 10 and cost 11 stays 11. Existing login/reset hashing flows are unchanged.
- **Password comparison:** compute SHA-256 digests of the bcrypt output and stored bcrypt hash using schema-qualified `public.crypt`/`public.digest` (pgcrypto's installed schema). Accumulate XOR differences across all 32 digest bytes with `pg_catalog.get_byte`, then make one decision; no prefix-dependent text equality or early exit. Lockout, password mutation, revocations, challenge invalidation and audit remain in the same transaction.
- **Credential fence:** `signIn` captures the stored credential before password verification, including provider verification. The snapshot is threaded to session/challenge insertion. Each insertion uses a materialized `auth.users ... FOR UPDATE` CTE with a credential match predicate; if the password writer wins, the waiting insert rechecks and rejects. If insertion wins, password change subsequently revokes that session or deletes that challenge. MFA challenges persist the snapshot in a server-only column and pass it to final session insertion, so a challenge already loaded before invalidation cannot mint a session with an old credential. Password change deletes all pending `2fa`/`enroll` challenges for that user. No wholesale login/reset rewrite and no provider calls are added to password change.
- **Mutation budgets:** private per-user/action counters permit at most 20 profile attempts and 10 password attempts per 15-minute fixed window. The database consumes them after flag, tenant and active-session admission, while holding the user lock; locked-out password attempts return before consuming a budget. Exhaustion returns the existing `unavailable` result with no additional writes. Counters persist across workers, are bounded to two rows per user, and roll back on audit failure. OFF snapshots include counters and challenges and remain unchanged.
- **Other-org test:** both organizations are allowlisted with their overrides ON; the foreign tenant succeeds with its actual environment pin. Reusing that pin with the original user's session is rejected, and snapshots of both users (including foreign contacts, profile, credential, sessions, challenges, counters and audit count) remain unchanged.

All schema changes remain in local `20261106210000_b020_tenant_profile.sql`. The seed wipe list also handles the new counter table. The challenge column must exist before running this application version; old pending challenges without a snapshot require a fresh login. `ops/flags.yaml` remains OFF, and the seeded database remains OFF. No hosted migration, ownership command, commit, branch operation or push was performed by the delegate.

Fresh rebuild: drop/create only `127.0.0.1:55432/condola_b020s2`, apply the stub and every migration, then `npm run db:reset`. Node 20.20.2 / npm 10.8.2. Results:

- `npm run typecheck`: PASS.
- `npm run lint`: PASS, 0 errors / 15 existing warnings.
- `npm run copy:check`: 6/6 PASS.
- `npm run test:unit`: 983/983 PASS.
- `bash scripts/check-function-privileges.sh`: PASS, full migration replay; anon execute zero and allowlist matches exposure.
- Requested serial `b020-tenant-profile`, `b020-tenant-account`, `auth.integration`, `portal-login*.test.ts` run: **42/42 PASS**, zero skipped. Includes verified-old-credential rejection across connections; mocked provider-verification races through both session and challenge creation; actual observed PostgreSQL row-lock contention with post-wait rejection; pending MFA/enrollment invalidation; stronger-cost preservation; rate cap concurrency and expiry; and two-org ownership denial. Only `portal-login.test.ts` exists for the portal glob.

Evidence: `/private/tmp/b020s2-r1-{rebuild,typecheck,lint,copy,unit,privileges,integration}.log`. These are local implementation checks, not an independent QA PASS, browser acceptance, staging gate or whole-B-020 completion.

STOP POINT: LOCAL_QA_R1_FIXED_VERIFIED; next: Claude independently re-reviews the local diff and these logs, then commits if accepted; owner: Claude@ron-mac.

### Slice 2 QA status and scope decision (orchestrator, 2026-11-06)

Codex QA r1 FAIL (bcrypt cost could drop; pre-change verification could still create a session; non-constant-time compare; no mutation limit; masked other-org test) → fixes → r2 FAIL: the delegated credential fence had spread into the **shared login path** (`auth.ts` session/challenge inserts, an `auth_challenges.credential_snapshot` column required even with the flag OFF) and still missed signup/invitation session creation and enrollment-challenge MFA writes. **Claude scoped it back at the 2-round cap:** `src/server/auth.ts` is byte-identical to the base again and the migration no longer alters `auth_challenges`; the credential-fence tests were removed. Kept and verified: stored bcrypt cost floor, fixed-length digest comparison, bounded per-user mutation counters, revocation of the user's other sessions and deletion of that user's pending `auth_challenges` in the password-change transaction, unmasked other-org denial.

**Open (hub BLK-MAC-14 → B-031 `SESSION_HARDENING*`):** a login (or signup/invitation) that verified the *old* password before the change can still create a session after it, and an enrollment challenge loaded before the change can still write MFA secrets. Closing this needs a credential epoch fenced in every password-authenticated session/challenge path, which is B-031 scope. `tenant_account_settings` must stay OFF until then. Re-verified after the scope-down on a fresh DB: unit 983/983, b020 profile + account + auth integration 36/36, fn-privs, cf:build.

# B-031 — Audit, upload and session reliability (L2 design)

> Author: Claude (Mac Session 2, 2026-11-06 PT). Hub spec `20-build/specs/B-031.md`; capabilities CAP-P-19/20/21/24
> (PLT-07/08/09). Stacked on #39 (`feat/b-001-id-sign-gate`). Closes hub `BLK-MAC-14` (credential epoch) in slice 1.

## Slices

| Slice | Package | Flag (default OFF) | Status |
|---|---|---|---|
| 1 | SESSION_HARDENING — credential epoch fencing every password-authenticated session / challenge path; token-free logs | `session_hardening` | in progress |
| 2 | AUDIT_DETAIL — authorized before/after/reason audit detail with masking and role filtering | `audit_detail` | implemented (local) |
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

## Slice 2 — AUDIT_DETAIL

**Problem.** The audit screen shows who/what/which/when and a masked reason, but not the values that changed.
`audit_log.old_row/new_row` hold full snapshots (sensitive fields included) and are deliberately never read by
the Worker. Acceptance: for an important mutation, a permitted viewer sees actor, time, reason and before/after.

**Write (reuses the existing audit path).** The generic `fn_audit` trigger already writes one `audit_log` row per
row change, with `changed_cols`, `old_row`, `new_row` and `app.change_reason`. Migration
`20261107130000_b031_audit_detail.sql` adds `AFTER INSERT ON audit_log` trigger `trg_b031_audit_detail`
(`WHEN action = 'update'` on the six covered tables) calling `app.b031_capture_audit_detail()`. Only when the flag
is ON for the row's org, it stores a field-level diff in private append-only `app.b031_audit_details(audit_id PK,
org_id, table_name, reason, changes jsonb, withheld)`. No application write code changed.

**Allowlist (deny by default).** Only these columns are copied; every other changed column is counted in `withheld`
(name and value never stored). A key-name guard also rejects anything matching token/secret/password/hash/session/
encrypt/storage/legal_name/id_number/national/passport/bank/account/line_user/einvoice/tax.

| Table | Fields (kind) |
|---|---|
| leases | rent_amount_minor, deposit_amount_minor (money); deposit_months, due_day (number); start_date, end_date, terminated_on, moved_out_on (date); status, renewal_status (code); termination_reason, deposit_override_reason (text) |
| contacts | display_name, company_name (text); email (partial); phone_e164 (partial); is_tenant, is_owner, is_vendor (bool); archived_at (time) |
| org_members | role, status (code); is_billing_owner (bool); title (text) |
| properties | name, address_display (text); default_rental_mode (code); archived_at (time) |
| units / rooms | label (text); base_rent_minor (money); rental_mode (units, code); archived_at (time) |

**Masking at write.** Email → first character + `***@` + masked domain; phone → `+886`, stars and last two digits.
Text and reason use one specification, implemented identically in `app.b031_normalize_text` + `app.b031_mask_text`
(authoritative) and `normalizeDetailText` + `maskDetailText` (`audit-read.ts`, defence in depth), with parity
tested over every reviewer probe:
0. Cap at 1000 characters; a cut final non-CJK word is discarded so no partial number or token survives.
1. Normalise before any rule: NFKC; remove format/zero-width characters and combining marks; dash/minus family →
   `-`; every space kind and control whitespace → space; `。` → `.`; collapse spaces and trim.
2. Any word containing `@`, a spaced `x @ y`, `(at)`/`[at]` forms → masked whole.
3. UUIDs; token-like runs of `[A-Za-z0-9_+/=.-]`: 16+ with a letter and a digit, 6+ with 2+ letters and 4+ digits
   (LINE ids, passports, IBANs), 20+ with 3+ upper- and 3+ lower-case letters (base64/JWT). Snake_case reason codes
   and ordinary words have no digit and stay readable.
4. One Latin letter glued to 7+ digits (national ID, ARC, passport).
5. Number scan: digit groups joined by 1–3 separator characters (ASCII punctuation, space, `·` `・` `、` `‧`) form one
   number, optionally led by `+` or `(`. A plain-space join needs both groups ≤4 digits unless the number starts with
   `0` or `+`. 8+ digits → masked. ISO-like dates/times (`YYYY-MM-DD`, `YYYY/MM/DD`, optional `HH:MM[:SS]`) and
   thousands-grouped amounts (`25,000`, `NT$1,250,000`) at a number's start are kept, and a join never continues into
   a following date.
Matches become `••••••••••`; text is capped at 200 and reason at 500 characters. Money/number/date/time/bool/code
must match a strict shape or are fully masked. Money is exact `numeric` JSON text formatted with `BigInt`. The read
side accepts only partial-mask shapes for phone/email and drops unknown fields/kinds into `withheld`. Known
readable on purpose: a 7-digit partial number (`0912 345`). Accepted over-masking: 8+ digits joined by single spaces
between short groups (`2026 11 06 12`), 10-digit contract numbers. The OFF page keeps the unchanged `maskAuditText`.

**Capture never blocks business writes.** The flag check runs first and returns while OFF, so OFF updates open
no subtransaction. Only the ON capture runs in a `BEGIN … EXCEPTION WHEN OTHERS` block: on any error the detail row
is skipped and `RAISE WARNING 'b031 audit detail skipped: <SQLSTATE>'` (no values) is emitted. The insert uses
`ON CONFLICT (audit_id) DO NOTHING`; each detail row also stores the audit row's `row_id` and `occurred_at`.

**Read and role filtering (in the DB).** `app.b031_audit_detail_rows(p_org uuid, p_ids bigint[])` is the only
reader: SECURITY DEFINER, `search_path = pg_catalog, pg_temp`, EXECUTE granted to `authenticated` only (no anon,
PUBLIC or service_role). It returns zero rows unless `auth.uid()` is set, `app.active_org_id` equals `p_org`,
`app.has_role(p_org, '{admin}')` (the existing `audit_access` model: admin only) and the flag is ON for `p_org`;
rows are filtered by `org_id = p_org` and joined to their `audit_log` row on id, org, table, `row_id` and
`occurred_at`, so a pre-existing detail row can never be attached to a different event. The table itself has RLS enabled and no
grants, so cross-org and non-admin reads are impossible even with direct SQL as `authenticated`.

**Viewer.** `loadAuditScreen` / `loadAuditHistory` call the reader once for a non-empty page (inside the same
authenticated transaction) and attach `detail` to matching rows; the summary reason line is then left to the
detail block (re-masked reason). `AuditRows` renders 變更明細 / Change detail: reason (or 未填寫原因 / No reason
recorded), `field：before → after`, and a withheld-fields note. Actor and time are the existing row columns.
EN and zh-TW strings added to `src/i18n/{en,zh-TW}.json`.

**Reason semantics.** Optional, and never fabricated: the stored reason is whatever the existing flow set in
`app.change_reason` (blank/whitespace → none). Flows that already require one keep requiring it (archive/restore,
deposit above cap). No new reason input was added to forms (needs copy/product decision).

**Flag `audit_detail` (default OFF).** `platform_settings.audit_detail = {"enabled":false,"allowed_org_ids":[]}`
plus `organizations.feature_flags.audit_detail === true`, strict JSON booleans and an array allowlist naming the
org. OFF: the capture trigger writes nothing; the reader returns zero rows (also for detail captured while ON);
pages render exactly as before. The only OFF difference is one extra read statement on non-empty audit pages
(`audit-read.integration` query budget updated from 2 to 3).

**Coverage.** Covered (row-level updates of allowlisted fields through `fn_audit`, any writer): lease rent/deposit
edits (`updateLease`, exercised in the test), lease date/status changes (e.g. end date, `moved_out_on` from
`move-out-notice.ts`), owner contact edits (`updateOwner`, exercised), tenant directory contact edits (B015 sets a
fixed reason code), role/status/title changes (`setMemberRole` exercised, `setMemberActive`), property name/address
edits (`portfolio.ts`), property/unit/room archive and restore (`archiveCommand`, user reason required). Not
covered: inserts and deletes, app-event rows written by `recordAudit` (auth_events, PDF downloads),
invoices/payments/ledger/expenses, bank accounts and payee details, identity documents, invitations, utility runs,
fee rules, management agreements, and every non-allowlisted column of the covered tables (counted only).

**Known limitation.** `setMemberRole` / `setMemberActive` update `org_members` on the server owner connection,
so `fn_audit` records no actor for that row (shown as 系統); the paired `role_change` event row carries the actor.
Fixing it changes OFF SQL for those flows and is left as a follow-up.

**Retention.** Detail rows follow their `audit_log` rows: append-only, no purge. No retention policy was introduced;
CAP-P-21 values are unchanged. Whether masked detail needs its own retention window is a Ron/CEO decision.

**Tests.** `src/server/b031-audit-detail.integration.test.ts` (14): ON production paths; masking of stored JSON,
view, rendered HTML, console logs and URLs; DB-level role filtering via `tx()` as authenticated (manager,
accountant, maintenance, tenant, owner, other-org admin, pin mismatch, cross-org ids, suspended admin, anon,
service_role, direct table access); 10 OFF flag shapes with zero writes/reads; complete OFF SQL trace, presented
result and rendered rows equal to the 1bba9f3 baseline (`src/server/fixtures/b031-audit-detail-off.json`);
reason semantics; non-covered rows; append-only and exact BigInt display; write/read parity over every reviewer
probe; M1 production write; ON-vs-OFF reason codes; forced capture failure and stale-id conflict; rv2 e2e render;
OFF path ahead of the guard. Unit `src/server/b031-audit-detail.test.ts` (9).

**Fix round 1 (independent Claude review of ff674a5: 2 MAJOR, 3 MINOR).** M1 width folding + separator-joined digit
groups + spaced/full-width IDs on both sides; M2 token rule requires a letter and a digit, so fixed reason codes
and long names are no longer hidden (ON shows the same reason text as OFF); capture exception guard and
`ON CONFLICT DO NOTHING`; `i_audit_v_none` (尚無續約動作 / No renewal activity) and `i_audit_d_base_rent`
(月租 / Monthly rent) aligned. Reviewer probes are regression tests: write/read parity over all probes, a production
write with the M1 formats, ON-vs-OFF reason codes, forced capture failure and an id conflict.

**Fix round 2 (independent Claude re-review of a14a463).** Separator enumeration replaced by the general
specification above on both sides (normalise first, then rules; the read side no longer re-collapses after its
rules): every leaking rv2 input (slash/underscore/middot/Unicode-dash/NBSP/zero-width/soft-hyphen/tab/comma/colon
phones, slashed/dashed bank and card numbers, separated and letter-glued IDs, ARC, 9-digit and letter+8 passports,
IBAN, LINE ids, JWT/base64 without digits, Unicode/full-width/ideographic-dot/spaced/(at) emails, `+886 (0)`,
extensions, 8-digit landlines, 9-digit and post-office accounts, combining marks) is masked; dates, times, amounts
and two separate amounts stay readable (N3). N2 reader matches id + org + table + row + time and a conflicting
insert is skipped. N4 flag check before the guarded block. Probe table (72 reviewer inputs + 106 fixture inputs,
parity 178/178) in `e2e-evidence/B-031/slice2-audit-detail.md`.

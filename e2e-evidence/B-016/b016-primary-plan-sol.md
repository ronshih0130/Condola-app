# B016 primary plan — existing-schema self-name editing

**Recommended next local product slice: let a current live-company staff member edit their own account display name on `/m/account`, behind one default-OFF control.** Company regional fields, verified login-email replacement and versioned fee editing need separate completed design/handoff; they do not block this narrow existing-schema flow. No implementation or runtime has occurred. This is primary planning, not final QA.

Requested Sol/high; actual model runtime identity unobservable. Branch `mode-b-repair-override-prep`, source baseline `f1be31ee77dff48d132ce71040af1c3d13e28d62`, root owner3099AC86-6AF0-4681-9944-304E930BFDC2, planning logc9e45de4-664e-47d8-8594-34a5fc60a318. Root owns reservations/claims/commits/evidence. Current root board/queue edits are recognized, not overwritten. Exact source Git blobs, policy/evidence hashes and hub bindings are in the companion JSON.

## Requirement and dependency reconciliation

Supplied PE hub snapshot (2026-10-29 context, not current deployment) maps to `/workspace/condola-hub` through its README. `capability-list-v1.md:102,106`: CAP-M-25 regional company details depends on CAP-M-03; CAP-M-29 requires maintained/audited fee rules plus personal name/Email modification. `current-state.md:110,126,130`: M-42 had no fee edit, M-58 profile was readonly, M-62 contact email/phone already built. MGT-04 at `user-stories.md:37` covers editable company/contact and region-specific identifiers/address.

Current source confirms these specific gaps. `/m/settings` already edits company contact mail/phone and reminders through admin-only settings.edit; do not recreate it. `/m/account:50–55` only displays personal name/email, alongside existing password/MFA/session functionality. `profiles` already stores global user display_name/email and self-RLS; it has no org_id. Existing signup/invitation email writes are not a verified signed-in email-change journey. No normal self-name mutation existed in inspected baseline; the now-reserved author may begin source preparation separately under root. No planner source edit or test is implied.

B003 at0fb7c15 has scoped local payee/gateway/isolation PASS. Its status/verdict/BLOCKED still require old-app/new-schema and approved rollback compatibility, exact staging/grants/Claude/Class B/Ron acceptance. This supports separating local personal-name work that does not call or mutate payee data; **B003 is not whole done and its hosted dependency is not waived**. B015 is likewise only scoped locally accepted, with owner/raw-old-writer DB and external acceptance still pending. No full B item newly done or queue scope cut.

## Narrow product contract

1. **Self name, account-wide, live staff only.** Support all existing staff roles editing only their own display name; no admin editing another user's identity. State that the name applies across the account. In sandbox keep the existing readonly name/email and expose the existing route back to the live company before editing. This preserves the sample-company promise without cloning identities or silently changing the real global profile. Owner/tenant personas, stale/missing/forged membership/session/env/live scope deny. Email remains readonly; no auth credentials/contact names are changed.
2. **One reconciled flag.** Use canonical `company_profile_edit` and explicitly reconcile the queue's uppercase proposed COMPANY_PROFILE_EDIT* spelling. Require strict global object enabledtrue+selected-live-org allowlist AND strict same-org feature flagtrue; missing/malformed/false is OFF. Register owner/expiry/ring/kill; do not create competing uppercase/lowercase aliases or provision operational settings/opt-ins. This first slice does not pretend to enable complete company/email editing.
3. **Small dedicated service/action.** New guarded action calls direct requireCurrentConsent before form parsing and gets the fresh server-selected session. Form contains name/expected version only; never authority/user/org fields. Service validates live staff before existing svc, then independently validates actual matching live org, active same-role member, current auth session and consent/partner state inside the transaction. Lock/re-read own profile, compare exact version, and recheck current authority/clock-time/flag after waits before changing one self row. No new DB function/grant/schema.
4. **Atomic metadata audit using existing primitives.** `audit_log` INSERT is revoked from authenticated; do not use authenticated tx plus a separate audit and call it atomic. Existing svc supports narrowly authorized server-side work and `writeAudit(...,sameClient)` can commit/roll back the name and metadata-only `auth_events` event together. Audit contains field/outcome/account scope/source/selected environment/actor metadata, no old/new names, emails, tokens or request payloads. Actual audit failure rolls name back. This is current-app enforcement, not raw/old-writer/hosted DB closure.
5. **Prevent silent overwrite.** Expected digest includes own profile identity/name/exact row version, observed after lock. Same requested current value is unchanged; stale different value gives conflict/reload. Missing profile gives unavailable, never creates a new identity. Trim one bounded nonempty Unicode name (proposed100 code points, controls rejected); no ASCII/legal-name rules. No generic durable command/receipt engine. Unknown network outcome means reload canonical name before retry; never claim saved without confirmation.
6. **Real form.** Small native form in the existing profile card, existing card/button styles, labels and account-wide/live note in `src/i18n/staff-profile.ts`. Distinguish saved/conflict/unavailable and explicit reload accurately; never claim an uncertain write saved. Existing password/MFA/session controls and readonly email remain. No legal text/global CSS redesign.

## Exact reservation and verification

Root has now reserved the following7 Terra source paths in `work/b016-self-profile-reservation.json`; root separately owns flags/package registration. This supersedes the earlier proposed filenames and keeps implementation under10 authored paths:

- `src/server/staff-profile.ts`
- `src/server/staff-profile-rules.ts`
- `src/server/staff-profile-actions.ts`
- `src/server/staff-profile-rules.test.ts`
- `src/server/staff-profile.integration.test.ts`
- `src/app/m/account/page.tsx`
- `src/i18n/staff-profile.ts`

Root only: `ops/flags.yaml`, `package.json`. All other auth/session/db/audit/consent/perms/company/payee/report/migrations are read-only dependencies. A small native form in the existing account card is sufficient; no new client component, permanent e2e test/config or runner edit is required. Runtime browser work is an outside root-owned probe after source authorization. If an additional path is essential, reconcile it with root first.

Targeted checks must prove actual self updates and current-session revalidation, not mirror rendering. Cover all four staff roles; wrong user/org/env/live/member/persona/session and sandbox denial; revocation/expiry/role changes during waits; malformed/OFF/allowlist flag matrix; no changes to trusted/auth email/password/contacts/org/payee/fee/statements; two-tab conflict and same-value retry; missing profile; real audit-failure rollback and metadata privacy. UI EN/zh390/1280 must show OFF readonly, local ON normal save/reload name, unchanged email, invalid/conflict/error/loading and natural pointer reachability. Strict console/pageerror/5xx/external request checks; no sender/provider call. Existing APIs do not become an alternate way to mutate target identity.

Proposed commands, **NOT RUN**, under root's approved disposable synthetic environment:

```text
node --import tsx --test src/server/staff-profile-rules.test.ts
node --import tsx --test --test-concurrency=1 src/server/staff-profile.integration.test.ts
node --import tsx --test src/server/consent-entrypoints.test.ts src/server/consent-enforcement.test.ts
node --import tsx --test src/server/auth.integration.test.ts
npm run typecheck
npx eslint src/server/staff-profile*.ts src/app/m/account/page.tsx src/i18n/staff-profile.ts
npm run copy:check
node /absolute/work/b016-staff-profile-browser-v1/probe.cjs
```

The named new test files and root-owned outside browser probe are future commands, not executed evidence. Use the actual absolute workspace path for the outside probe; no dispatcher edit is implied. Root owns a unique loopback port, approved existing core93 clone/seed, pinnedNode20.20.2/npm toolchain, source/helper freeze and server cleanup. Source/helper review precedes execution; targeted checks and EN390 focus precede a full immutable-candidate gate. Once stable: clean `scripts/gate.sh <exactSHA>`, then actual Next/CF/original GNU-awk preflight/Worker/final four-case browser/control readback and highest independent reviewer. Snapshot/restore exact existing flag rows and org flags, with readonly readback; no operational opt-in. No new/proposed SQL/parser/migration runs on Mac. Preserve failures, change approach after two, and do not repeat full gates while unstable. Staging/other machines/Claude/pilot remain separate.

## Dependent design/handoff, without SQL execution

Codex still owns complete schema/gateway/app design, source review and compatibility contracts; PE supplies actual target identity/catalog/security plus approved non-Mac application/backup/counts/rollback. Do not offload unspecified design to PE. This task produces only the outside primary plan. The following future considerations are **NOT_READY, pending closed handoff design**, not instructions to expand the immediate author scope. Future handoff Markdown/inactive unique-timestamp proposed additive SQL remains UNREVIEWED/UNPARSED/UNAPPLIED/NOT APPLY-READY until its own review.

**Regional company profile.** Reuse existing organizations name/legal_name/tax_id/country/jurisdiction/contact fields. Full address storage and jurisdiction-field/source/version contract are absent; generic settings JSON is not permission to invent one. `countries.ts` currently offers TW only and unknown codes fall back to TW: new identifier editing must fail explicitly for unsupported region, not quietly apply Taiwan validation/labels. Design structured versioned address/identifier representation, authorized field mapping, admin/current-org/version authorization, and audited changes without altering payee accounts or inventing identities/qualifications. Legal wording is unchanged.

**Verified email change.** Keep auth.users email/identities/login/recovery and profiles.email unchanged until actual verified transition. Do not repurpose signup_verifications or invitation acceptance. Design user-bound expiring one-time pending request with original+target identities, current reauthentication/MFA assurance, token hash/status/version/source/idempotency and cancellation/supersession. Specify new-address proof and old-address/step-up/session policy, unique normalized address/provider identity coherence and rollback; unresolved security/provider choices are explicit dependent decisions. Local capture/mocks only, no real mail. Test wrong user/token/expiry/replay/races and preservation before verification; a mock is not inbox delivery proof.

**Versioned fee rules and issued statements.** Existing fee_rules and management_agreements are useful foundations, not finished versioned editing. `calculateStatement:52` selects one owner rule with LIMIT1 at period end and applies it to total owner rent; no deterministic multi-property fee policy, shape/basis/max support, or safe live editor is supplied. Do not mutate these rows now. The future closed append-only revision/binding contract needs effective intervals/overlap enforcement, exact org/owner/property/currency/source/request attribution, old-worker safety and serialization against preview/issuance. Resolve fee policy before enabling writes: default vs property precedence, cutoff/midmonth behavior, fixed fee once per owner vs per property, unsupported formula handling. Do not silently invent financial rules.

Issuance already saves fee_rule_snapshot and amounts, and existing generate returns the stored statement. However `statementRoster` issued rows still look up the live rule name (`queries.ts:904–909`); full fee change must serve issued labels from their own snapshot, preserve prior amounts/snapshots/versions and define exact future report provenance. B014 explicitly leaves immutable corrected report versions pending. Coordinate that scope; do not call existing snapshots proof of whole DB immutability. Required later tests include boundaries/overlap/backdating/concurrent edits, deterministic owner/property/currency resolution, preview change detection, old issued bytes/amounts unchanged and correct future reports plus actual target/oldwriter/rollback verification.

**Decision:** independent review and root reservation may move the self-name slice into execution. Park only the dependent regional/email/fee/provider/schema scopes, with explicit remaining design. Whole B016, all39 items, four-party LINE and eventual ecosystem/pilot acceptance remain active and incomplete. No source/runtime/DB/flag/provider/legal operation occurred in this planning task.

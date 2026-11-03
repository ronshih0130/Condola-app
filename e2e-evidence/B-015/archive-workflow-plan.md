# B015 full archive workflow — independent implementation plan

**PLAN GO for the current-app property/unit/room archive + restore + history + scoped admission work below.** This is a source-based implementation plan, not source/runtime acceptance of unwritten code or a database application approval. Root may reserve the two disjoint author lanes now. Existing guard checkpoint source9b05732/publication516a5e8 remains separately accepted only within its scope; all113 previous artifact bindings stay immutable. The prior draft remains unchanged. No SQL/parser, DB, test, build, network or source implementation was run for this plan.

Ron explicitly answered the finance question: **“允許封存，保留帳務入口（建議）”.** Thus ended operations may be hidden from ordinary new-work selection while outstanding finance is warned and remains accessible through normal authorized queues/actions. No automatic settlement, payment confirmation, amount change, dispatch, invite, message, lease termination, ownership change or identity merge follows. No unanswered finance policy blocker remains. Whole B015 and all39/four parties/full LINE still remain active; this plan does not narrow those goals.

## 1. Real capability and rollout

Implement an actual persistent archive and restore operation for public.properties, public.units (including physical by-room units) and public.rooms, using their existing archived_at and updated_at. Use the existing audit trigger with transaction-local reason and request trace. No new column/table is necessary for those three targets. These are local source/DML development tasks, not operational Mac migrations.

Set only the chosen target timestamp. Property archive makes descendants effectively unavailable by ancestor visibility; it does not stamp every child. Unit archive similarly hides its rooms. A child already explicitly archived remains archived after parent restore. Show own versus inherited archive state. Archive may explicitly mark a target already hidden by its parent; it must still inspect any inconsistent operational work. Restore requires active existing ancestors and a structurally usable target (room in by_room mode); explain a parent/mode conflict rather than changing mode, moving rows or restoring ancestors automatically. A physical unit ID is never inferred from a room label; kind is a closed property|unit|room enum.

Proposed canonical rollout control: **record_archive**, strict public.platform_settings value.enabled===true, a well-formed UUID-string allowed_org_ids array containing selected org, and organizations.feature_flags.record_archive===true. Missing/malformed is OFF; registry defaultfalse/internal/Ron owner, expiry consistent with the current registry. Do not alias tenant_directory_edit. Application can read an absent key as OFF. Only synthetic fixtures may insert/update the row; later PE proposal may INSERT defaultOFF ON CONFLICT DO NOTHING, preserving an existing row. No operational activation.

The new control gates archive/restore buttons and mutations. Existing archived-state respect, new-work ancestry checks and authorized historical access must remain correct even when this control is OFF. Turning the feature OFF does not unarchive data, permit fresh work on it or remove existing authorized finance/file access. No new owner/tenant entitlement follows from an archive badge.

## 2. Typed service/UI contract and authority

Backend owns src/lib/record-archive.ts, shared pure types/validation, before the UI consumes it. It must not import database/node-only code into the browser.

- ArchiveKind=property|unit|room; ArchiveRef={kind,id}. RenderedArchiveScope={actorId,orgId,liveOrgId,environment}. This scope is a precondition compared with a fresh server Session, not client authority.
- ArchiveObserved contains exact ref, actual property/unit ancestry and mode, own archivedAtUtc, inherited archived ancestors, current opaque version, capabilities and safe display fields. PostgreSQL UTC strings preserve six fractional digits; no JS Date round-trip for CAS.
- ArchiveView is ready|unavailable. Ready includes observed target, writeEnabled, canArchive/canRestore, role-scoped blockers, finance warnings, verified category coverage, and already-authorized history/finance links. Unknown/missing/hidden category is not zero. Never return raw contact or audit snapshots to manufacture coverage.
- ArchiveCommandInput={ref,desired:archived|active,expectedVersion,renderedScope,reason,requestId}. Reason is nonempty/bounded; requestId is UUID tracing only, not a capability or exactly-once receipt. Targets/table SQL are closed server-side switches, never caller SQL/table names/callbacks.
- Outcome is changed | already_in_desired_state | stale | blocked | disabled | forbidden | busy | conflict | unknown. A changed response is sent only after actual awaited COMMIT. Already means observed current state, not that the original request committed. Stale never silently replaces expectedVersion or reapplies an old archive after an intervening restore.

New archive/restore action: require current consent and freshly resolve Session; compare rendered actor/org/env; current live/sandbox organization, live membership, actual admin/manager props.edit role and unrevoked/unexpired auth session before locks, after waits and immediately before COMMIT. Read uses current props.view (admin/manager/accountant) and existing masking. No maintenance/staff capability expansion. Tenant/owner badges or links must derive from a lease/ticket/statement they are already allowed to read; they do not use staff archive endpoints.

An opaque CAS may include the actual tuple xmin::text, exact stored updated_at/archived_at and stable target/ancestry/mode fields, hashed server-side. This is a short-lived change precondition, not a durable revision/receipt. updated_at=now() alone is not unique or monotonic. Under the locks, compare exact observed version before mutation; set only archived_at, set app.change_reason and app.request_id on that same transaction, flush constraints, reauthorize and directly COMMIT. Existing fn_audit records auth.uid(); its definer current_user actor_role is not necessarily the human business role. Do not display that field as verified current business role.

Manager cannot SELECT generic audit_log under the later admin-only policy (20261020140000_audit_access.sql:1–7). Do not widen it or pretend current viewer is past actor. The core history screen shows actual stored archive time/state and retained record history; Admin can use the existing authorized audit view. A future limited actor/reason projection is a separate narrowly scoped design, not a prerequisite for basic archive/restore. No generic request table is justified here.

Lost reply: preserve minimal tab-scoped ref/desired/original-version/rendered-scope/request trace, not reason/contact/finance payload. Keep reason in memory; reload may require re-entry. Read fresh current state, clearly distinguish it from original outcome UNKNOWN, and never autosubstitute a fresh version. If the target changed then restored, the original operation is stale. An explicit review-current-state action may end that uncertainty UI and start a new intentional operation. Malformed/unreadable recovery storage fails closed for mutations; no silent new-key retry. Key the client by actor/org/env. No claimed manager receipt recovery from generic audit.

## 3. Dependency matrix — actual operational work, not all history

Use exact org and actual target ancestry. Property covers its subtree; unit covers that unit; room covers that room plus a whole-unit lease or shared operation only where its source actually covers the room. Parent-only records are not assigned to a room by label or a guessed null. Required category queries must be authorized and complete; use EXISTS or bounded summaries, not a truncated result described as zero.

| Existing fact | Archive result | Reason and retained path |
|---|---|---|
| Lease active or pending_signature | Block with authorized lease link | Current occupancy/signing; no automatic ending/cancellation. Schema lease_status and leases target indexes:34–35,501–554. |
| Actual current sent/partially-signed e-sign workflow, even if lease state is inconsistent | Block; existing signing/void workflow link | Check public.esign_cases/versions scoped by lease and actual status, not every old pending signature or featureOFF as cancellation. esign core:16–35,450–468. |
| Unsigned draft/not_sent, or ended/terminated/cancelled lease without live signing | Informational retained history; no blanket block | A draft is not active occupancy. Activation/new signing must enforce active ancestry later. No draft/status mutation by archive. |
| Ticket open/triaged/assigned/in_progress/on_hold, or an actual unreported unexpired active dispatch | Block | These are operational states. A confirmed closed job is not blocked solely by active/token metadata. vendor-repair-rules.ts:15,44–55; vendor-repair.ts:342–450. |
| Resolved/completed repair awaiting cost confirmation or draft/submitted expense | Finance warning, allow visibility archive | submitVendorReport requires done and writes resolved/completed_on (:752–804); confirmVendorCost later posts expense/closes (:807–882). Treating this finance remainder as active work would contradict Ron's answer. Existing authorized confirmation/expense paths remain. Missing/inconsistent completion facts are guidance/unavailable, not invented completion. |
| Existing utility run draft/approved with an actual target contribution | Block, link run | Unfinished current preparation/posting. Shared runs require actual meter/line/lease relation; explain shared scope. |
| Posted/void utility runs, meters/readings, completed bills | Retain history; finance correction links | A live meter or historical bill alone never makes retirement impossible. Fresh preparation is denied on archived ancestry; existing posted correction/void remains under its ordinary rules. |
| Invoice open/partially_paid/draft for ended work; submitted payment; pending finance expense | Warn and allow after operational blockers absent | Explicit Ron approval. Show normal queues/actions. Archive changes none of their statuses, amounts, allocations, ledger, closed-period or issued-statement rules. |
| Paid/void/written-off invoice; confirmed/rejected/reversed payment; posted/void expense/ledger/report | Retain history, no block solely by existence | They are historical/financial records, not new occupancy. |
| Tenant invite pending AND unexpired for a live lease | Show guidance; live lease/signing already blocks | Do not count expiry from status alone. Ended-lease access invite may support financial/history access and does not itself become an active-space blocker. |
| Owner/team invitation not bound to target property; accepted/revoked/expired invite; delivery/export history | Not a target-work blocker | Do not fan a contact-wide invite into every property or auto-revoke/rotate/send. |

Restore checks target/ancestor coherence, mode and actual existing uniqueness, not a newly invented requirement that old debt or every old ticket be erased. Existing property import/address active indexes may conflict after another active record is created; surface a non-destructive conflict. Unit/room label uniqueness is already broader than active-only, so do not assume a new same-label record can always be created. No automatic merge or identity replacement.

## 4. Locking and current writer admission — implementable without new DDL

Use one fixed transaction-level advisory ancestry protocol for ALL participating current-app admissions and archive commands. Keys are derived server-side from the canonical org, closed kind and actual row UUID, never a caller-supplied lock key. Property archive takes its property key exclusively; unit archive takes property shared then unit exclusive; room archive takes property/unit shared then room exclusive. New work takes shared keys for its actual property/unit/room ancestry. New units require the property key, new rooms require property/unit keys. Mode changes affecting room eligibility take the unit key exclusively. Reparenting takes sorted old/new parent keys before the child key, re-reads actual ancestry, and bounds any rediscovery retry. Retain all locks to COMMIT. This is a scoped ancestry protocol, not a global organization lock. Hash collisions may serialize unrelated work but must never grant authority.

Then archive locks the actual mutated property/unit/room row FOR UPDATE and re-reads its tuple/CAS; admin/manager current authority permits this existing DML. Do NOT assume tenant/maintenance/accountant can take parent FOR SHARE: SELECT locking can require UPDATE policy coverage, while parent team_update is admin/manager only (schema2044–2104; tenant SELECT policies2159+ do not grant parent editing). Such callers retain their existing authorized SELECT/RLS or fixed-token path and recheck the actual ancestry after the common advisory wait; no widened UPDATE policy, role switch or generic owner callback is introduced. Existing staff lockFreshLeaseTarget physical parent locks remain an additional compatible protection. Acquire advisory ancestry keys BEFORE any existing physical parent/lease/ticket/run lock so the ordering is uniform.

Parent archive sees a fresh READ COMMITTED dependency snapshot after earlier admitted work finishes. Do not lock child work rows after parent while a caller holds the child and waits for admission: move admission BEFORE existing lease/ticket/run locks. If a specific old call path cannot establish authorized target scope before locking, identify and fix that exact path rather than treating an RLS-hidden row as no work or borrowing a broader role. Current-app tests must use real tenant/maintenance/accountant sessions as well as admin/manager so an UPDATE-policy mismatch cannot strand those normal workflows.

Archive-first makes a current new-work request wait then reject archived state. Work-first finishes; archive then sees operational work and blocks. A mere latest-row count, FK or lock on existing descendants does not protect absent-row phantoms or a nonparticipating writer after commit. Current-app coverage is concrete below; old/raw closure is section7, not falsely certified here.

| Actual writer | Required current-app change | Important preserved behavior |
|---|---|---|
| domain.ts:createLease (:843–1040) | Take the common shared advisory ancestry admission before existing lockFreshLeaseTarget physical locks; retain upstream historical replay and existing guard, with no duplicate fresh-guard rewrite | Existing original tenant identity/replay, signatures, first invoice unaffected. |
| portfolio.ts:createSpace/updateSpace/unitForFloor/updateProperty/seedPortfolio (:560–843,937+) | Take the canonical ancestry admission keys and lock/re-read actual active parent before create, reparent/mode or ordinary edit; deterministic old/new parent order | Read-only archived history is separate. Existing history records/owner links never silently detached. |
| import-batch.ts:commitImportBatch/loadIndex/insertion (:140–190,497–695) | Preview stays advisory; at commit lock sorted reused actual parents/targets, re-read/replan before child/active-lease inserts | New independent property IDs remain legitimate; no auto-restore/merge or treating an archived identity as authorization. Owner-only marker adoption later waits for its schema. |
| domain.ts:createTicket/updateTicket, repairs.ts:saveRepairRecord | Fresh ticket/reopen/new operative schedule/assignment requires active actual ancestry BEFORE ticket lock | Existing comments/photos and completion to resolved/closed do not become forbidden because parent archived. Preserve tenant/current ticket authorization and internal-photo privacy. |
| vendor-repair.ts:dispatchVendor (and any new operative reassignment) | Recheck active ancestry before ticket/jobs locks and retain existing flag/token/current auth checks | Existing reported-job finance confirmation and protected evidence reads remain; no auto dispatch/revoke/notifications. |
| utility-posting.ts:prepareUtilityRun; domain.ts:setMeterSerial new/ordinary configuration | Canonical shared ancestry admission plus authorized active property/unit/room rereads before new run/meter work, not just u.archived_at; no accountant parent UPDATE privilege assumption | Existing posted correction/void and historical readings/files retain existing rights/math. Do not blanket-filter financial source queries. |
| domain.ts:signLeaseOn/simulation/paper activation; esign/lock.ts+repo.ts | Resolve actual lease target and acquire ancestry before lease/case lock for new/live signing or activation. Recheck lease target tuple after waits. | Paper historical PDF replacement and completed document reads remain allowed; no changes to legal/signature semantics. Legacy signLeaseOn can set active (:1554), so archived-ended stale signatures must not reactivate it. |
| portal-invite.ts:issuePortalInvite and token acceptance | No new blanket archive predicate or automatic side effect | Existing named-party portal access to retained finance/history may still be needed; preserve current scope/expiry/role rules. Archive/history page itself does not expose a new invite action. |
| Payment/invoice/expense/statement/reversal finance paths | Separate historical eligibility from operational assignment; see section5 | No generic archived-parent finance trigger. Keep balances, current recipient/ownership, allocations, math and month locks intact. |

The structural admission helper does not authorize arbitrary users or SQL callbacks. Callers keep their existing staff/tenant/signing/vendor authority model and recheck it after waits. New archive actions enforce the full fresh Session contract; vendor token operations must not be given invented staff-session authority. E-sign lock entrypoints already authorize before and after waits; insert ancestry before their lease lock, not after it. Do not turn this work into a generic auth rewrite.

## 5. History, files and Ron-approved finance — concrete casewalks

Archive/history view is an actual usable destination, not a new edit form. Add an archived list/filter and target page with own/inherited status, actual hierarchy, blockers/warnings, retained lease/repair/finance history links and restore action when allowed. Existing propertyDetail already reads a property regardless of its archive state (queries.ts:290–310); the current property page still offers edit/new lease/phone visibility/meter controls. Return archive capability metadata and disable those operational controls on archived/inherited views. Room/whole-unit URLs currently are editors; route an archived effective target to the authorized read-only archive view, without removing all filters and exposing its form.

Fix active-only readers coherently: SPACE_LIST_SQL room branch lacks unit.archive (:1570–1615), propertyDetail room subtree (:330) lacks it, and spaceEditor (:1676,1696) does not fully reject archived parents. Ordinary new-work pickers must check every ancestor and mode, while history queries deliberately retain archived rows. Do not use listProperties/listOwners indiscriminately for finance and new assignment.

Required actual financial casewalks (same canonical authority as before archive):

1. Ended lease + unpaid/partial invoice + submitted payment: archive property/space with warning; staff listPayments/lease ledger and already authorized tenant payment/history remain reachable. Confirm/reject/reverse/late report use existing permitted role, source, amount, allocation and period checks. queries.ts:listPayments and leaseDetail join retained parents without archive filters (:643–795), and domain.ts:record/confirm/reject/reversePayment work from stored lease/payment/invoice context. Do not add parent archive denial to those actions.
2. Pending existing expense: listExpenses/getExpense/approveExpense/voidExpense retain rows; BUT updateExpense calls active-only loadProperty/loadUnit (expenses.ts:186–205,463–480), and expenseFormOptions omits stored archived targets (:318–344). Fix existing-record correction by allowing its exact unchanged stored property/unit even when archived; preserve active-only checks for a reassignment TO another target. A correction FROM archived source to an otherwise eligible active target remains under existing permission/ledger/issued-statement/closed-month rules. Include the exact stored archived option in this expense's form; do not offer every archived property as an unrelated new expense assignment. Keep historical currency from the stored context where required; never revalue old entries from a changed property. New ordinary unrelated expense creation remains active-target selection.
3. Vendor report completed/resolved + unconfirmed cost: after archive the normal authorized confirmVendorCost still creates its existing source-bound repair expense and closes the ticket. insertPostedRepairExpense does not require active property (:596–659); retain that. No new job is dispatched and no work is marked paid by archive.
4. Statements/reports: statementRoster and calculateStatement already retain property relations regardless of property.archive (queries.ts:886–945; statement-calculation.ts:27+). Keep issued reports/PDF and permitted new financial reconciliation/generation accessible. Report filter options currently hide archived properties (income-expense.ts:94–110); include authorized archived historical choices with label so an existing archived property can still be selected. Do not change cash formulas, owner entitlements, versioning or B008/B014 unresolved authority to claim parity.
5. B014 staff-assertion journal: published source already replays original UUID from stored snapshot BEFORE current ownerContext and reverses from stored context, so archive must not break exact replay/history/reversal. Its new-record options and ownerContext both currently require p.archived_at NULL (owner-transfers.ts:30–34,44). For an otherwise already-authorized B014 manual financial record, treat property archive as visibility only: remove that visibility-only barrier from financial choices/context, label archived property, and retain EVERY existing role, consent, current org/env/session, owner-contact eligibility, ownership-effective-date, feature, expected currency/scale, exact amount, month, replay/reversal/dedup and source-shape rule. This is the same manual staff assertion, not a bank transfer, new payee/ownership right, payout processing or automatic journal insertion. Prove the pre/post case differs only by archive state. If that equivalence cannot be established for a case, return unsupported for that case and record it; do not invent a new financial authority.

Lease list/detail/PDF, paper versions and handover attachment endpoints retain their existing RLS/principal checks (queries.ts:612–753,1710+; pdf-download.ts; paper-lease-versions.ts; handover.ts:18–48,218+). Add archive status where useful without granting files to a new party, reviving expired vendor tokens or altering ID retention. Staff/tenant/owner authorized history must be tested; a former owner who has lost an existing entitlement does not regain it just because rows are retained. Full vendor/owner portal extensions elsewhere in all39 remain in scope, not silently accepted here.

The generic /api/export currently exports active listProperties only, not a complete archive backup (src/app/api/export/route.ts). Do not claim archive export completeness from its existence. B015 retained-record/history/PDF acceptance proceeds via actual scoped routes; broader export scope remains B032/PLT14 work unless separately implemented. No new export promise or destructive deletion.

## 6. Exact disjoint file ownership for parallel authors

Backend author owns these NEW paths:
- src/lib/record-archive.ts
- src/lib/record-archive.test.ts
- src/server/record-archive.ts
- src/server/record-archive-admission.ts
- src/server/record-archive-actions.ts
- src/server/record-archive.integration.test.ts
- src/server/record-archive-admission.integration.test.ts
- src/server/record-archive-finance.integration.test.ts

Backend owns these EXISTING shared paths, limited to the functions/contracts above:
- src/server/queries.ts
- src/server/portfolio.ts
- src/server/domain.ts
- src/server/import-batch.ts
- src/server/repairs.ts
- src/server/vendor-repair.ts
- src/server/utility-posting.ts
- src/server/esign/lock.ts
- src/server/esign/repo.ts
- src/server/expenses.ts
- src/server/income-expense.ts
- src/server/owner-transfers.ts
- src/server/perms.ts (only explicit archive route permission mapping if required)
- ops/flags.yaml
- package.json (explicit unit/RLS registrations; scripts are not globs)
- scripts/run-e2e.ts (only private-profile dispatch)

UI author owns these NEW paths:
- src/components/record-archive.tsx
- src/components/record-archive-entry.tsx
- src/i18n/record-archive.ts
- src/app/m/archive/page.tsx
- src/app/m/archive/[kind]/[id]/page.tsx
- e2e/b015-archive-workflow.spec.ts
- e2e/b015-archive-workflow-private-playwright.config.ts

UI owns these EXISTING paths:
- src/app/m/properties/page.tsx
- src/app/m/properties/[id]/page.tsx
- src/app/m/properties/[id]/edit/page.tsx
- src/app/m/units/page.tsx
- src/app/m/units/room/[id]/page.tsx
- src/app/m/units/whole/[id]/page.tsx
- src/app/m/leases/[id]/page.tsx
- src/app/m/expenses/[id]/page.tsx
- src/app/m/reports/page.tsx
- src/components/owner-transfers.tsx (only archived finance-option label; keep recovery protocol)

No simultaneous ownership overlap. UI imports the agreed backend DTO/actions; it does not edit backend contracts. Backend exposes archive metadata/choices/capabilities and does not edit JSX/dictionaries. Freeze an early literal contract before both progress; routine source changes require coordinating interface consumers, not parallel edits to the same file. No global stylesheet, unrelated wizard refactor, protected legal copy or identity/auth redesign is reserved. Root owns board/evidence/BUILD/BLOCKED/HANDOFF, commits/push/mirror and outside runtime helpers; root does not author product implementation. Additional file needs must be concretely justified and reserved before editing, not implicitly broadened.

## 7. Concrete narrowly dependent database handoff

Owner archive is NOT implemented by contacts.archived_at: that is shared with tenant/vendor identity and auth/session helpers (auth.ts:193,234; session.ts:156–187; schema:1981–1995). Do not clear is_owner, delete/recreate contacts or end property_owners effective dates. Source assessment work/b015-owner-archive-db-assessment.md SHA963986e4684b8ec07e20894f19a2ace84625c6d6b41f672071e053983e726afa supports one nullable contacts.owner_directory_archived_at as the minimal candidate, scoped org/contact. It hides owner directory/new-assignment choices, not existing ownership, portal identity or legitimate finance/history. Adding that field does not grant authority or make old readers filter it.

Codex must prepare Downloads/b015-record-archive-db-handoff.md and a root-reserved unique-timestamp proposed SQL file, UNAPPLIED/NOTRUN/NOTAPPLYREADY. Initial exact contracts:

1. Add owner_directory_archived_at nullable/defaultNULL with existing org/contact identity. Define fixed owner-only archive/restore/current-state operations and safe new-assignment checks. Preserve dual owner+tenant login, all role/user links and existing ownership; no positive app writer queries this absent column until actual approved non-Mac application and returned target evidence.
2. Protect ONLY archive-marker admission and known operational transitions needed for old/raw closure. Existing properties/units/rooms archived_at have broad authenticated UPDATE grants. A narrow fixed NOLOGIN/noninheritable function-owner role with no login/membership/SET ROLE grants plus parameterized current-authority gateway can control marker changes; an invoker guard must test real current_user, not caller GUC/JWT role. INSERT with forged nonNULL marker and UPDATE transitions both need treatment. Column REVOKE alone does not override table-level UPDATE. Preserve unrelated legitimate field edits.
3. Fixed gateways lock actual ancestors and recheck the accepted dependency matrix. Narrow child/transition guards must make current parent→child admission effective for old/raw new operational unit/room, lease activation/new tenancy, ticket reopen/dispatch and new utility preparation. They must NOT blanket-block historical invoices/payments/expense corrections, posted utility corrections, retained signed PDFs or normal finance. Address both orders, absent child phantoms and reparenting, not just trigger presence.
4. Existing mode conversion can archive rooms (20261022170000_archive_whole_unit_rooms.sql). A new marker seal must explicitly preserve or migrate that legitimate path without a caller-spoofable bypass. Existing current direct TS marker writes would be blocked after a seal: this is NOT a drop-in migration. Codex must port the service to reviewed fixed gateways before hosted use, with unchanged UI contract.
5. If a manager needs extra archive-action audit projection or durable original-request receipts later, design only the exact read/command boundary needed. This current-state workflow does not require a generic command table or raw audit grant. Keep UNKNOWN where no original commit proof exists.

PE owns actual target catalog/history/roles/grants/RLS/security validation and approved non-Mac application; Codex retains product/gateway design and implementation. Test PG16 local approved fixture versus target PG17, old/new workers and SELECT* serializers, default/inherited ACLs, actual current_user trigger semantics, cold/rollback paths, restore conflicts, before/after counts, retention, backups and replica/demo reset. The owner field disappears with its parent but that does not prove reset/audit safety. No Mac operational DDL or prod use. Only owner-field positive writes and stronger old/raw/hosted guarantees are parked; the substantial current-app timestamp workflow/history/finance/admission work above proceeds now. Whole B015 cannot be declared done until those dependent scopes and full acceptance are satisfied.

## 8. Focused tests and evidence for the actual workflow

Backend unit tests: exact typed refs/reasons/scopes, UTC6/string CAS and stale version behavior; no helpers that merely mirror implementation. Integration must prove actual stored archive/restore for all3 kinds, own/inherited child semantics, active parent/mode rejection on restore, current admin/manager versus accountant/maintenance/tenant/owner and cross-org/live/sandbox/revoked/expired/role-change denial, missing/malformed/OFF controls, constraint/audit failure rollback, no-op versus stale after archive→restore, and original tenantContactId reuse without duplicate contact/login. Raw audit actor/reason/request checks run only under explicitly owned test authority, never as a false manager capability.

Deterministic admission tests: archive-first and new-work-first using owned DB/PID/blocker witnesses; include fresh lease, new/moved space/imported active lease, new/reopened ticket/dispatch, new utility and activation. Prove archive sees admitted active work and blocks, while archive-first rejects fresh work. Use explicit locks/barriers and always drain promises; do not accept either Promise.all outcome as proof. Add unrelated target progress, rollback, reparent/mode drift and actual restored positive operation. Keep old/raw races separate and explicitly not solved by app locks.

Finance tests instantiate ended operations with outstanding invoice/partial payment/submitted payment/expense and prove archive succeeds with warnings, unchanged finance facts from archive itself, then the NORMAL authorized financial action still succeeds under existing rules. Prove source-bound reported vendor cost completion, existing expense edit/approve/void and reassign-to-active rules, statement/report/PDF access, original B014 replay/reverse and otherwise-identical manual staff assertion under its strict flags. No fake remittance, broadened payee/owner rights, month bypass or release of immutable reports. Positive/zero/negative parity beyond these existing actions remains its original B008/B014 requirement, not inferred.

UI/browser source must exercise actual persistent archive and restore for property/unit/room, visible inherited status, blocker guidance, finance-warning path and real follow-through, readonly history/file navigation, duplicate restore conflict, current-state UNKNOWN recovery and stale old-tab binding; EN/zh390+1280 initial/loading/error/blocked/archived/history/restored states. Do not inflate counts before the final spec exists. Known cosmetic wizard clipping/devbadge is recorded as a limit, not a new blocking task. Review only blocking bugs/core security/important UX.

New private profile may use port43152, exact owned condola_b015_workflow_* names and B015_WORKFLOW_OWNED_DATABASE, no providers, no reused server, trace/video off. Root's three outside helpers remain DRAFT until exact source review. If browser fixtures turn on owner_transfers or another control to prove finance, spec restores EVERY changed row including absence/value/description/UTC6, and independent readback must compare those additional controls too; a record_archive-only readback is insufficient for mutated B014 controls. Preserve whole selected-org flags; no whole-DB restore claim. Root freezes reviewed app/dependency/helper literals on a fresh immutable candidate, then appropriate focused checks, standard gate/build/original preflight/Worker and actual private browser/readback; no blanket --release or borrowing prior 9b/CF PASS. Final independent evidence and visual review is scoped to the actual candidate. No production/main merge/operational flag activation/message/legal-text work.

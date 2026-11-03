# B015 independent UI/privacy source review A1

**SOURCE_NO_GO — two blocking findings for full workflow acceptance.**

Independent reviewer: Sol/high, `/root/b015_ui_security_review_sol`; did not author implementation. Read-only static source review only.

Baseline: `516a5e8c2e7bc7f54cefe425e6551d9ea0fc793e`. Frozen request SHA256 `b5aa8c02cd8a902871ab2cca250aeb883c08cbc8feb9f235d9d332829e587670`; literal 128-source map SHA256 `ad371c3a8113efd6b1b43ea0262d023204bf5ddb8400ed321895d42063f8fde4`. All 128 actual Git blobs match, including all53 changed paths and22 UI paths.

## UI-A1-01 [P1] Archived draft leases still expose and accept ordinary terms edits

src/app/m/leases/[id]/page.tsx:212

Trigger: A staff admin/manager has an unsigned draft lease with esign not_sent and no active signing/repair/utility work. Archive its property, unit, or room (drafts intentionally do not block archive), then open its existing /m/leases/<id> summary and submit changed rent/deposit.

Evidence: The new archive badge and sign-button guards do not guard LeaseTermsForm. Lines 212-229 check role, status and signature only. updateLease locks the lease then writes rent/deposit/document_sha256 with no active-ancestry admission or archive predicate. leaseTermsEditable accepts unsigned draft/not_sent. Existing active-lease signing admission does not run on updateLease.

Impact: Ordinary operational editing continues on an effectively archived space, violating the full workflow requirement and archive flag-OFF invariant. It also permits this writer to race archive without the agreed ancestry protocol.

Required: Hide ordinary terms editing on effective archive, and add the same active ancestry admission/recheck before the existing lease lock in updateLease. Preserve authorized historical finance and paper/PDF corrections. Add focused archived draft UI/direct-action and archive-versus-terms-edit ordering evidence.

## UI-A1-02 [P2] Active by-room physical units have no normal UI entry to their archive action

src/app/m/units/room/[id]/page.tsx:41

Trigger: An admin/manager wants to archive an active physical unit whose rental_mode is by_room, without archiving the whole property or each individual room.

Evidence: The room editor renders only ArchiveEntry(kind:room). The whole-unit editor is the only unit entry but spaceEditor(kind:whole_unit) requires rental_mode=whole_unit. The active space list emits room IDs for by_room units and only whole_unit physical unit IDs. Property detail contains room/unit labels but no physical by_room unit archive link. /m/archive only lists already own/inherited archived rows. The archive panel displays ancestry labels/timestamps without parent links.

Impact: The explicitly required physical by-room unit archive capability is reachable only by knowing its UUID and manually typing a route, or temporarily archiving its entire property. Normal users cannot perform a core B015 action through the rendered interface.

Required: Expose a clearly identified physical by-room unit archive/history link using its actual server-provided unit UUID (for example from the room editor or property hierarchy). Prove navigation by clicking from a normal entry; the current browser test directly navigates to /m/archive/unit/<fixture UUID> and misses this gap.

## Scoped source observations without additional blockers

- Tenant history pages and byte GET call fresh getSession and current consent, stay outside /t/lease selectedLease layout, and expose no business mutation/selection action. Tenant layout history link survives null active lease.
- tenant-lease-history uses tx with authenticated role, canonical org/env pins and actual org/live-parent, current auth-session, non-archived current tenant contact and exact same-org ended lease-party predicates. Exact PDF bytes are selected in the same constrained query; no service-role byte read or generic file fallback.
- Signed PDF detail gate hides version/count metadata when unavailable. Existing current-pointer/newest fallback and stored UTC6 upload time are reused. URL lease/pdf identifiers do not supply actor/org authority.
- Existing fixed download audit writes only canonical org/user/lease/PDF/server request trace after authorized read and response construction; failure returns private503 without the PDF. No IP or client-delivery claim. Private no-store/nosniff/type/length/generated filename preserved in source.
- Archive recovery validates exact minimal storage shape, fails closed for malformed/null serialized data, preserves reason only in memory, keeps UNKNOWN/stale/already distinct from receipts, and requires explicit current-state review before a new decision. archiveViewAction expectedScope plus UI scope passing rejects an A-to-B actor switch before recovery review without clearing A pending.
- Archive-aware existing expense options and report/B014 labels preserve normal finance forms; owner transfer change is label-only and retains its original recovery protocol.
- Private browser source pins loopback port43152 and owned disposable database naming, reuseExistingServer=false, sanitized server environment, no trace/video, external browser request blocks and local synthetic PDF bytes. It snapshots/restores all three control row absence/value/description/timestamp and selected whole-org flags transactionally, including failure cleanup.

## Limits

NOT_RUN: no SQL parser, DB, tests, build, browser, network, secrets, providers, production, messages or source changes performed. Authored tests are hypotheses, not executed evidence. No screenshots/visual QA exist for this frozen candidate.

- This is source-only NO_GO for the reviewed full UI scope, not acceptance of the baseline guard, complete B015, owner-only schema proposal, old/raw writer closure, all39, four portals/LINE, gate, staging or release.
- No additional blocking tenant privacy finding in this static pass is not runtime/RLS/catalog proof.
- Root draft runtime helpers are not accepted by this review; the separate backend/helper reviewer owns them.
- Historical memory supplied boundaries only; live repository/source pins supply findings.

Exact path Git-blob and SHA256 pins are in companion JSON. These findings were sent directly to root; no author/source edits performed.

<!-- DRAFT for Ron + CEO approval (2026-10-27 PT). Not committed. -->
# Switch B → A

- [ ] Ron: Stop new Codex/Claude desktop work and local automation; maintain lock renewal while draining.
- [ ] QA: Complete staging monitoring or emergency production T+15/incident resolution before releasing relevant claims.
- [ ] Ron: If takeover is needed, record shutdown/fencing and outstanding operation checks; retain production claim through resolution.
- [ ] Ron: Drain desktop terminal children, browser/test workers and remote jobs; record completion evidence.
- [ ] Ron: Preserve dirty/divergent work; push code, lanes, checkpoints and recovery refs to Origin.
- [ ] Ron: Upload private evidence and commit sanitized manifests, verdicts and approvals.
- [ ] Ron: End session logging via `scripts/session-log.sh`; commit JSONL and Model/Role/Session trailers with tokens unknown.
- [ ] Ron: Record any emergency prod promotion/rollback, authorization, token scope/expiry, deployed version, T+0/T+15 and unresolved checks for post-hoc Class B review.
- [ ] Ron: Revoke any short-lived prod Worker token immediately after use; remove local copies and record revocation/expiry confirmation.
- [ ] Ron: Append PT STOP POINT lines with exact next commands and owners.
- [ ] Ron: Rewrite HANDOFF and board with ranges, do-not-touch paths, staging/prod state, compatible rollback, flags, queue, quotas and claims.
- [ ] Ron: Push final operational updates to Origin, then run `scripts/mirror-github.sh` while B still owns; verify refs.
- [ ] Ron: Release completed resource claims and record B STOPPED → RELEASED after all jobs drain.
- [ ] PE: Fetch Origin and inspect locks; remain dormant while B owns.
- [ ] PE: Read canonical policies, HANDOFF, board, statuses and verdicts.
- [ ] PE: Inspect `git log --all --since="$LAST_HANDOFF"` and `git log --oneline "$OLD..$NEW"`; check `llm-route --quota`.
- [ ] PE: Fetch all recorded lanes; preserve divergent/uncommitted box work before reconciliation.
- [ ] PE: Claim A only after RELEASED using `scripts/claim.sh acquire repo A`; rejected CAS requires refetch/reassessment.
- [ ] PE: Run `scripts/mirror-github.sh` after claiming A to capture fresh Origin state, including ownership transition; Ron does not mirror after releasing B.
- [ ] QA: Reconcile production/staging identities, flags, rollback, R2 access and quotas against records.
- [ ] CEO: Schedule post-hoc Class B review of each emergency production action; unresolved evidence remains explicit.
- [ ] PE: Record acceptance, generation, reconciliation and blockers; push Origin and mirror while A owns.
- [ ] PE: Refresh roles from `ops/roles/*.md`; all A model work resumes through `llm-route`.
- [ ] PE: Resume recorded next command only with adequate implementation and independent-QA reserve.
- [ ] CEO: Through 2026-11-10, next production release remains blocked until previous T+15 PASS.

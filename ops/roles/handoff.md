<!-- DRAFT for Ron + CEO approval (2026-10-27 PT). Not committed. -->
# Handoff — end the owning session
Handoff context: $ARGUMENTS
Read AGENTS.md, canonical policy, HANDOFF, board, latest status/verdicts and scripts/claim.sh status.
Invoke Codex $condola-handoff or Claude /condola-handoff; fallback: "follow .claude/skills/handoff/SKILL.md".
Stop new dispatch, implementation, deployments and flag promotions; retain ownership while preparing handoff.
Renew manually at checkpoints; no heartbeat daemon.
Finish production monitoring through T+15 PASS or incident resolution before ordinary release.
Unfinished incidents require explicit fenced takeover by Ron; never label them clean handoffs or casually release PROD_LOCK.
Drain desktop-agent terminal processes, children, remote model jobs, CI/deploy jobs and DB operations; verify STOPPED.
Preserve unfinished/divergent work on named lane/recovery branches; scan staged material for secrets/customer identifiers.
Commit checkpoints, sanitized logs, verdicts and manifests with Model:, Role:, Session: trailers.
Push work/lane/recovery branches individually to Origin without force; ops-lock changes only through claim.sh.
Only the current lock holder runs scripts/mirror-github.sh after each Origin push and at handoff.
Never push directly to GitHub or enable GitHub→Origin sync; report drift and preserve it for reviewed porting through Origin.
Keep candidate SHAs immutable; operational records go on main without unapproved implementation.
Use HANDOFF.template.md, or its canonical installed template, to rewrite HANDOFF.md.
Record modes, owner, session UUIDs, app/model, checkpoint ranges, branch→SHA inventory and dirty/divergent work.
Record lane/class/claimed files/dependencies, blockers, exact next commands and release order.
Record prod SHA/version, baseline, rollback version, monitoring phase, full-traffic time and T+0/T+15 evidence.
Record Class A verdict or Class B draft/conditions, QA, exact-SHA/slot GO and frozen hashes.
Mode B is staging-only; ordinary prod waits for Mode A Class B.
Record every Ron emergency B P0 fix/rollback: staging-verified SHA, locks, rollback version, gate/wrapper/runbook and model-run T+0/T+15.
Record transient Worker-only token expiry/revocation evidence without values, no Mac DB migrations and pending post-hoc Class B review.
Record mirror status, last mirrored main SHA plus PT time and ref inventory; TODO for unknowns.
Record staging bundle ID/date/expiry/hash, never values; Mac uses scripts/secrets-run.sh staging -- <cmd>.
Record flags/rings/org overrides/kill/expiry, quotas, artifact access/retention and verification limits.
Record repo/prod/staging holders/generations, STOPPED evidence, STOP POINT and “release pending; ops-lock is authoritative.”
B runs scripts/session-log.sh for start/end records; retain sanitized ops/log/<date>/<session>.jsonl paths.
Use numeric-offset PT (America/Los_Angeles) timestamps; update ops/board.md through the owning session.
Verify receiver's Origin, artifact, desktop-app and staging-bundle access without exposing values; model CLIs are not required.
Freeze/publish activation waits for every PE lane to ship with T+15 PASS or CEO parking with recovery refs; follow checklists/freeze-and-publish.md.
Commit/push HANDOFF, board and status; verify branch tips and mirror completion while still holding the lock.
For releases set CLAIM_STOPPED=YES and CLAIM_EVIDENCE to committed sanitized evidence.
Release staging with CLAIM_RESOURCE=staging scripts/claim.sh release after jobs stop.
Release prod only with CLAIM_RESOURCE=prod and CLAIM_PHASE=T15_PASS or INCIDENT_RESOLVED, backed by evidence.
Once resource claims are RELEASED and checkout is clean, release repo through scripts/claim.sh with STOPPED evidence.
Because repo release itself pushes Origin, finish the final ops-lock mirror within the lock-holder release procedure; TODO verify script support before release.
On push, mirror, drain, evidence or release failure, retain ownership and report the blocker; never announce completion.
After successful release, make no further writes/dispatch; receiver fetches, claims and follows start.md.
Report handoff commit, published SHAs, mirror status, lock commit, STOP POINT, release result and exact receiver command.
Receiver records acceptance after claiming; through 2026-11-10 PT the next release requires prior T+15 PASS.

<!-- DRAFT for Ron + CEO approval (2026-10-27 PT). Not committed. -->
# One-time freeze and publish

Every in-flight lane must be shipped with T+15 PASS or explicitly parked by CEO with a recovery ref before the write freeze or publication starts. The queue below comes from decisions.md; reconcile any board additions before proceeding.

## Readiness: every lane

- [ ] PE/QA: errors-redact — record shipped SHA and T+15 PASS, or CEO parking decision and recovery ref.
- [ ] PE/QA: end_auth_sessions — retry candidate `46d1f99`; record shipped SHA and T+15 PASS, or CEO parking decision and recovery ref.
- [ ] PE/QA: id-photo-90d — record shipped SHA and T+15 PASS, or CEO parking decision and recovery ref.
- [ ] PE/QA: e-sign — record shipped SHA and T+15 PASS, or CEO parking decision and recovery ref.
- [ ] PE/QA: privacy-ai — record shipped SHA and T+15 PASS, or CEO parking decision and recovery ref.
- [ ] PE/QA: react-418 investigation — record completed release/T+15 evidence if shipped, or CEO parking decision and recovery ref.
- [ ] PE/QA: backup-acl — preserve condola-backup merge and first scheduled-run evidence; obtain CEO disposition/recovery ref if not satisfying the freeze condition.
- [ ] PE/QA: brand-v2 — candidate `65a676c`, no deploy yet; record shipped SHA and T+15 PASS, or CEO parking decision and recovery ref.
- [ ] CEO: Reconcile all board lanes, dependencies and sequential release order; explicitly approve readiness only when every lane satisfies the precondition.

## Freeze, preserve and publish

- [ ] CEO/PE: Declare PT freeze window and controlled migration executor; stop Cursor cloud automations and all unrelated box writes, draining jobs and maintaining ownership.
- [ ] PE: Inventory Git worktrees, branches/tags, dirty/untracked files, tarball-only changes, scripts, policies, specs and evidence.
- [ ] PE: Back up Git repositories and non-Git work; verify recoverability and capture inventory checksums.
- [ ] PE/QA: Scan proposed files/history for secrets and sensitive evidence; sanitize before publication, retaining protected recovery copies.
- [ ] PE: Add canonical Origin remote, fetch and preserve stale Origin `2bedb89`, current prod `5d8b002`, lane tips and sanitized recovery refs.
- [ ] PE/QA: Review Origin-only changes and create DESIGN's two-parent bridge preserving both histories and reviewed production tree; never blind force-push.
- [ ] PE: Push recovery refs, lane branches/tags and reviewed bridge/main to Origin under controlled ownership.
- [ ] QA: Verify remote SHAs, both histories, production reachability, bridge tree and every recovery ref from a fresh fetch.
- [ ] Ron: Create private GitHub repository `ronshih0130/condola-app` (name decided 2026-10-27 11:44 PT); disable Actions and do not attach Cursor inbound GitHub sync.
- [ ] PE: Configure box's single-repo Contents read/write mirror PAT outside Git and mirror-only writer restrictions.
- [ ] PE: As current holder, run `scripts/mirror-github.sh` from fresh Origin refs for first mirror push; verify main, ops-lock, lanes and tags.
- [ ] PE: Regenerate `/workspace/ops/handoff/evidence-cleanup-plan.md` with `scripts/evidence-plan.py` right before running (plan approved by Ron 2026-10-27 11:44 PT; PE runs it, Grok never deletes).
- [ ] PE: Delete exactly the paths in the regenerated `--emit-list`; code artifacts (.patch/.mbox/.sql/tree .tgz) only after QA confirms Origin publication verified; record deletions and retained manifests.
- [ ] QA: Verify kept evidence/recovery refs remain accessible and record cleanup results.

## Canonical tooling and Mac provisioning

- [ ] PE: Publish compact docs/policies, HANDOFF/board, gates, claims, mirror/session/bundle wrappers and generated-role source; replace box policy copies with pointers.
- [ ] QA: Verify lock supervision, CAS rejection, gate parity, secret exclusions and wrapper readiness before handoff.
- [ ] Ron: Install/check Codex desktop and Claude desktop, Git, pinned Node/npm, PostgreSQL 16, age and Origin CLI; no model CLI requirement.
- [ ] Ron: Run `origin auth login`, `origin auth status` and `git ls-remote https://origin.cursor.com/ron-shih/condola-app.git`; resolve access before B ownership.
- [ ] Ron: Clone published Origin repo and configure separate GitHub keychain authentication; fallback GitHub access alone does not authorize B.
- [ ] Ron: Generate plain age key file `~/.config/condola/age/mac.key` (chmod 600, outside repo; no Touch ID); send only the public recipient to the box.
- [ ] Ron: Store one offline backup copy of `mac.key` on an encrypted medium you control (APFS-encrypted USB or encrypted .dmg); never iCloud/Drive/chat/email/repo.
- [ ] PE: Build allowlisted staging-only encrypted bundle on box; publish checksum and variable names without secret values.
- [ ] Ron: Download bundle, verify checksum and test `scripts/secrets-run.sh staging -- true`.
- [ ] Ron: Open repo in Codex Local project and Claude Code tab Local environment; run `scripts/install-prompts.sh` under ownership or controlled setup authorization.
- [ ] QA: Verify AGENTS/CLAUDE loading, both skill trees, explicit invocation and Claude path fallback; exclude secrets from worktree copying.
- [ ] Ron/QA: Run staging gates via Terminal/app terminal and verify session JSONL plus commit trailers; tokens remain unknown.
- [ ] PE/QA: B staging-only scope + emergency path approved by Ron (2026-10-27 11:44 PT); implement and test the emergency wrapper/monitoring before it may be used (Open).

## Drill and unfreeze

- [ ] PE/Ron: Execute staging A→B handoff with drained jobs, Origin checkpoints, holder-only mirroring and explicit lock transfer.
- [ ] QA: Exercise competing claims, network loss, interrupted staging deployment and compatible staging rollback; preserve evidence.
- [ ] Ron/PE: Execute staging B→A handoff; A claims then mirrors fresh Origin, and reconciles all state.
- [ ] QA: Confirm final ownership, staging/prod identities, recovery refs, evidence access and absence of leaked secrets.
- [ ] CEO: Approve drill results and unfreeze; restart only gated automation under current holder with sequential-release policy intact.

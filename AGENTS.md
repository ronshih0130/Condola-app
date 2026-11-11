<!-- DRAFT for Ron + CEO approval (2026-10-27 PT). Not committed. Target path: repo root AGENTS.md -->
# Condola operating contract

## Mission and authority
- Build against `ops/ROADMAP.md`: P1 four applications/design partners; P2 pricing/UX; P3 global readiness; P4 user AI.
- Canonical remote `origin`: `https://origin.cursor.com/ron-shih/condola-app.git`; default branch `main`.
- `main` holds code, policy, board, handoff and verdicts; lane branches preserve unfinished work.
- `ops-lock` alone holds `ops/LOCK`, `ops/PROD_LOCK`, `ops/STAGING_LOCK`; never merge it into `main`.
- `/workspace/ops` contains thin pointers to this checkout, never editable policy mirrors.
- Operational documentation commits do not change the immutable candidate SHA identified by a verdict.
- Private GitHub mirror: `ronshih0130/condola-app` (decided by Ron 2026-10-27 11:44 PT). GitHub Actions disabled by default.
- Only the repo lock holder runs `scripts/mirror-github.sh`, after each Origin push and at every handoff.
- Mirror tooling fetches Origin with pruning, then mirrors main, ops-lock, lane branches and tags from freshly fetched Origin refs only, using per-ref force-with-lease.
- Never push to GitHub directly or enable GitHub→Origin sync. Report mirror drift; port reviewed changes through an Origin PR, never automatic reverse sync.
- Mac mirror authentication uses its own macOS Keychain credential, outside the staging bundle; box uses protected `GITHUB_MIRROR_TOKEN`.

## Modes and Rules 1/6 amendment
- A: Grok CEO/PE/QA/R&D orchestrate external models through `llm-route`; Grok only orchestrates.
- A: implementation, review, tests, evidence, research and copy—including production tests—use `llm-route`.
- B: Ron is CEO; Codex desktop app implements; Claude desktop app Code tab provides independent QA and zh copy.
- B: model-authored/executed checks run through the desktop apps; Ron decides acceptance within the release scope below.
- These mode provisions explicitly amend Rules 1/6; `ops/RULES.md` must carry the same amendment.
- Desktop model CLIs are not required. Run bash scripts in macOS Terminal or an app's terminal tool.
- Neither mode starts execution before acquiring repository ownership; read-only discovery is allowed first.
- Claude 端到端 mode: see section below.

## 「Claude 端到端」模式
- This is a mode for local Claude (with local Codex as implementer/QA per the handoff below); it governs how Claude-authored work reaches production.
- (a) Claude never self-reviews. Non-author QA is mandatory, and the QA model MUST NOT be the author model. Allowed non-author QA: Gemini or Codex. Claude may not sign off on Claude-authored work.
- (b) The Step-6 system design / spec (condola-hub `01-mission/dev-workflow.md` step 6) MUST include a production checklist covering: migrations, Worker config, secret NAMES only (never secret values), external console settings (e.g. LINE), flag plan, and rollback. Acceptance criteria MUST cover failure states, permissions, and concurrency.
- (c) Done means production-usable, not merely "PR opened" or "CI green." The path is: hosted CI → staging → non-author QA → CEO exact-SHA GO → prod with flag OFF → T+0/T+15 → ON for the 4 internal orgs → Ron acceptance. The status table MUST be generated from the actual main/prod state (live SHAs, Worker versions, flags), never from memory or a planned board. Claude may run on its own up to staging; production never changes without the gates above.
- Authoritative handoff (do not copy here): condola-hub `20-build/LOCAL-DEV-MODE-HANDOFF.md` — https://github.com/ronshih0130/condola-hub/blob/main/20-build/LOCAL-DEV-MODE-HANDOFF.md
- That handoff is the single source for stories, AC, mockups, BUILD-ORDER, PRINCIPLES 49–57, QA standard, release gates, safety red lines, and switch-to-local / switch-back steps. When Ron announces a switch to local development mode, follow that handoff so local Claude or Codex use the same pipeline as Grok Bot.
- This mode does not waive CEO exact-SHA GO, prod flag-OFF ship, T+0/T+15, or Ron acceptance.
- Docs-only / no secrets: never put secret values in this file.

## Start of every session
1. Fetch Origin and inspect `ops-lock` read-only; remain dormant while another executor owns it.
2. Read `AGENTS.md`, `ops/{RULES,PRINCIPLES,ROADMAP,deploy-checklist}.md`, `HANDOFF.md`, board, flags and toolchain.
3. Read the selected role, lane PRD/spec, latest status, verdicts and approvals.
4. Inspect recorded git ranges and `git log --all --since="$LAST_HANDOFF"`; fetch lane/recovery branches.
5. Preserve divergent/dirty work; reconcile production, flags, artifacts, quota and outstanding operations.
6. Acquire ownership; record acceptance/reconciliation in `HANDOFF.md`; start the recorded next command.
- Repository records and live evidence override memory; unknown facts remain TODO or explicitly blocked.

## Docs map
- Start at `docs/README.md`; read `docs/prd/<feature>.md` for the lane.
- `DECISIONS.md` is the ADR log; keep documentation short and link to canonical detail.

## Ownership and supervision
- Acquire with `scripts/claim.sh acquire repo <A|B> <who>`; use one ownership-session UUID.
- `claim.sh` fetches `ops-lock`, requires RELEASED and records owner, host, UUID, generation, timestamps and handoff commit.
- Generation increases monotonically; a claim commit is a direct child of the fetched lock commit.
- CAS push: `git push origin "$new:refs/heads/ops-lock" --force-with-lease="refs/heads/ops-lock:$old"`.
- Rejected CAS: refetch and reevaluate; never blindly retry or overwrite another claim.
- Run `scripts/claim.sh status` before mutations and renew manually at checkpoints/commits; no heartbeat daemon.
- Network/ownership failure stops new work. After six hours without renewal a claim is SUSPECT, never auto-available.
- Release only through `claim.sh` after draining children/jobs, pushing checkpoints and writing handoff; record STOPPED, then RELEASED.
- Only Ron may break glass after confirmed shutdown or fencing, checking outstanding deploy/DB operations and recording evidence.
- An unreachable executor without fencing cannot be replaced.
- Production claims require repo ownership and record lane, SHA, baseline, rollback version and phase.
- Hold `PROD_LOCK` through T+15 PASS or completed incident resolution; it never expires automatically.
- Staging uses the same claim mechanism; informal notes grant no ownership.

## Roles and adapters
- Sources: `ops/roles/{pe,qa,ceo,rd,start,handoff}.md`; generate adapters with `scripts/install-prompts.sh`.
- Codex skills: `.agents/skills/<role>/SKILL.md`, names `condola-<role>`; invoke `$condola-pe`, `$condola-qa`, `$condola-ceo`, `$condola-rd`, `$condola-start`, `$condola-handoff`.
- Generated Codex skills need name/description frontmatter and `agents/openai.yaml` with `policy.allow_implicit_invocation: false`.
- Claude skills: `.claude/skills/<role>/SKILL.md`, names `condola-<role>`; invoke `/condola-pe` etc.
- Claude desktop slash autocomplete may be limited; fallback: "follow .claude/skills/pe/SKILL.md" (substitute the role).
- Never edit generated adapters as independent policy; check them with `scripts/install-prompts.sh --check`.
- PE implements approved scope; QA independently inspects exact diff/evidence; CEO prioritizes and approves; R&D produces sourced specs.
- Ron makes all B CEO decisions. QA never reviews its own implementation conversation.
- Class A retains a fresh independent Codex verdict; Claude supplies independent B QA and supplementary Class A findings.
- Codex worktrees may start detached: preserve work on named branches; never include secrets in `.worktreeinclude`.

## Lanes, classes and release order
- Board records lane, owner, class, branch/SHA, claimed files, status, next action, dependencies and release position.
- Rule 7: one unshipped PR per file; reserve paths before edits, including migrations, dictionaries and shared scripts.
- Overlap: combine scope or wait until the earlier PR ships, then branch from main; no stacked overlapping PRs.
- Serialize board/handoff writes through the owning session on main; record classification before implementation.
- Class A: fresh independent Codex `e2e/results/<lane>/verdict.md`.
- Class B: Codex `classb-draft.md`, independent QA sign-off, CEO GO naming exact SHA/slot and all five release conditions.
- Through 2026-11-10 inclusive, ship sequentially; the next release requires the previous T+15 PASS.
- Rebase and CI execution belong to Codex; validate the final shipping SHA. Candidate/baseline changes invalidate approvals.

## Gates and release
- Run `scripts/gate.sh "$SHA"` on both machines and Depot: clean pinned checkout, pinned Node/npm, PostgreSQL 16, disposable DB.
- Gate includes npm ci, typecheck, lint, unit, RLS, copy and flag-expiry checks; release gate adds build, Worker and relevant browser checks.
- Preserve failures privately; known baseline failures require named exact-SHA QA disposition. Missing evidence or independent QA blocks release.
- Preserve e-sign G0–G5, catalog manifests, lock sampling, preview smoke and frozen script hashes; invent no migration ledger.
- Mode B deploys to staging only; ordinary prod promotion waits for Mode A and the Class B gate.
- Emergency B exception: Ron himself may deploy a staging-verified SHA only for a P0 customer-impacting fix or rollback; prefer rollback.
- Emergency requires repo ownership, PROD_LOCK, recorded rollback version, `scripts/gate.sh --release "$SHA"`, deploy/rollback wrapper and rollback runbook.
- Ron creates a short-lived Cloudflare Worker-deploy-only token for `condola-prod` (expiry ≤24h), injects it transiently and revokes it afterward; never store it on Mac.
- No DB migrations from Mac. Emergency T+0/T+15 checks must be model-run; record actions for post-hoc Class B review when Mode A returns.
- Production deploy: `TARGET_SHA="$SHA" scripts/deploy.sh production`; rollback: `TARGET_VERSION="$ROLLBACK_VERSION" scripts/rollback.sh`.
- Wrappers validate ownership, PROD_LOCK and applicable approvals, including the documented emergency path.
- Worker `condola-prod`, environment `production`; rollback wrapper uses `wrangler versions deploy "$OLD@100%"`; verify `/api/version` three times.
- Dashboard rollback is also available to Ron; retain all emergency lock, evidence, monitoring and review requirements.
- Class B conditions: migration/catalog fingerprint, restore-verified backup, before/after row counts, rollback ID, T+0/T+15.
- Before ordinary deploy require pre-deploy evidence for conditions 1–4 and an approved monitoring harness; post-deploy evidence remains pending.
- T+0/T+15 inspect client errors versus baseline, pages, roles, Worker logs and row counts; T+15 ≥900 seconds after full traffic.
- Unknown cause means NO-GO and compatible code rollback; DB recovery is approved fix-forward on Mode A.

## Flags and wording
- Ship flags OFF with owner, expiry, ring, global kill and per-org overrides in `ops/flags.yaml`.
- Internal→ea→ga requires separate CEO GO; Ron reviews legal/paid features before GA; use only approved production test orgs.
- Delete release flags/obsolete branches within 14 days after stable GA; CI blocks expired flags; review enduring kill switches quarterly.
- 租客 and 房客 are both approved. Never use 房東 (use 屋主), verified-tenant claims, 收款/收租/代收/入帳/已收, 保證 or registered-company claims.
- Never imply Condola manages property; do not hardcode Taiwan in data, timezone or currency.
- Product copy belongs in `src/i18n`; run `npm run copy:check`.
- Until PE ships the guard change, avoid introducing 房客 in `src/` copy: `src/i18n/copy-guard.test.ts` line 9 still bans it.
- PE must reserve the guard file, remove 房客 and add missing prohibited terms with false-positive review; use narrower patterns/allowlists where needed.

## Secrets, evidence and logs
- Never print secret values or place them in git, prompts, chat or transcripts; reference names/protected paths only.
- Mac receives only a staging age bundle; run `scripts/secrets-run.sh staging -- <cmd>` to inject credentials in memory.
- Never put plaintext secrets in the repo; ignore env/age files. Mac receives no prod keys, ID_DOC_* keys or prod backup identity.
- Use a separate Mac-generated age identity; Ron shares only its public recipient. Reissue staging bundles after 30 days or suspected exposure.
- Ordinary Mac access is staging-only; the transient Ron-created emergency Worker token is the sole prod exception above.
- Private R2 holds large evidence; git holds sanitized summaries/manifests with object key, SHA-256, size and retention date (TODO Ron confirm retention).
- A retains `usage.log`; B runs `scripts/session-log.sh` at session start/end, writing `ops/log/<date>/<session>.jsonl`.
- Log PT time, mode, role, app/provider/model, reasoning, session, lane/SHA, outcomes, failed calls, evidence and quota/reset state.
- Unavailable tokens/cost are `unknown`; desktop logs do not measure every internal request.
- Every operational/code commit carries `Model:`, `Role:`, `Session:` trailers.
- Update lane status with offset-bearing PT time and `STOP POINT: <state>; next: <exact command>; owner: <owner>`.

## Handoff and completion
- Check A `llm-route --quota`; record B app/account quota/reset evidence or unknown, including shared-account limits.
- Switch below 20%, insufficient execution-plus-QA reserve, exhaustion, Ron's choice or incident; follow `ops/checklists/switch-{A-to-B,B-to-A}.md`.
- Freeze/publish only after all in-flight PE lanes ship with T+15 PASS, or CEO explicitly parks them with recovery refs; follow `checklists/freeze-and-publish.md`.
- Initial freeze then publishes to Origin and mirrors GitHub; preserve `2bedb89` and reachable `5d8b002`, reconcile histories without blind force-push.
- Before activation, install scripts/skills, disable ungated automation and pass staging handoff drills; unknown implementation status is TODO.
- At handoff rewrite HANDOFF with mirror SHA/PT time, staging bundle ID/date, app/model, emergency actions and pending post-hoc reviews.
- Implementation done: exact SHA pushed, claims reconciled, gates/evidence and independent verdict complete, next command recorded.
- Release done: approvals valid, T+0/T+15 PASS, flags/production/rollback records current, board/HANDOFF updated and locks safely released.
- Rollback resolves an incident; it is not a successful shipment and does not waive the sequential-release requirement.

<!-- DRAFT for Ron + CEO approval (2026-10-27 PT). Not committed. -->
## 1 Architecture overview

```text
Mode A: Grok CEO/PE/QA/R&D → llm-route → external models (box)
Mode B: Ron CEO → Codex desktop implementation + independent desktop QA (Mac)
                                  ↕ exclusive ownership
Cursor Origin ron-shih/condola-app (private, canonical native repository)
  main: code, policy, board, handoff, verdicts
  lane branches: unfinished work; ops-lock: ownership/resource claims
                                  ↓ our scripts/mirror-github.sh
Private GitHub mirror (one-way Origin→GitHub; no inbound app sync)
Private R2 evidence + separate existing encrypted backup repository
```

Only the current repository lock holder pushes. Neither mode starts execution before claiming ownership. All timestamps in operational records include PT and offset.

## 2 Key decisions + rationale

- **Q1 (decided 10/27 11:44 PT):** Native Origin is canonical; our script maintains the private outbound mirror `github.com/ronshih0130/condola-app`.
- **Q2:** Origin documents macOS user login and Git access; verify Ron's account before Mode B ownership.
- **Q3 (decided):** Mac receives an age-encrypted staging-only bundle, encrypted to a plain age key file generated on that Mac (no Touch ID / Secure Enclave).
- **Q4:** Use Codex desktop and Claude desktop skills; model CLIs are unnecessary.
- **Q5 (approved 10/27 11:44 PT):** Normal B stops at staging; Class B production waits for A; Ron's constrained emergency override stays as designed.
- **Q6:** 租客 and 房客 are allowed; retain the other copy prohibitions and fix substring false positives.
- **Q7 (plan approved 10/27 11:44 PT):** PE executes `evidence-cleanup-plan.md` (regenerate first; code artifacts kept until Origin push verified); Grok does not delete.
- **Q8:** Freeze only after every in-flight lane has T+15 PASS or CEO parking with recovery refs.
- **Q9:** Add compact product, PRD, design, architecture, engineering, QA and decision documents mapped to existing assets.

Root `AGENTS.md` defines the contract and required `ops/{RULES,PRINCIPLES,ROADMAP,deploy-checklist}.md` reading; `CLAUDE.md` imports `@AGENTS.md`. Amend Rules 1/6: A model calls use `llm-route`; B permits logged desktop sessions. Grok only orchestrates.
Move box policy into the canonical checkout, then leave thin pointers. Verdicts name immutable candidate SHAs separately from documentation commits.

## 3 Repo directory layout

```text
AGENTS.md CLAUDE.md HANDOFF.md
docs/
  README.md PRODUCT.md DESIGN_SYSTEM.md ARCHITECTURE.md
  ENGINEERING_STANDARDS.md QA_PLAN.md DECISIONS.md
  prd/{README.md,_TEMPLATE.md,<feature>.md}
ops/
  RULES.md PRINCIPLES.md ROADMAP.md deploy-checklist.md
  board.md flags.yaml toolchain.json
  roles/{pe,qa,ceo,rd,start,handoff}.md
  templates/{verdict,classb-draft,prod-verdict}.md
  log/<date>/<session>.jsonl
design/<feature>/...
e2e/results/<lane>/
  status.md classb-draft.md prod-plan.md approvals.md
  verdict.md verdict-T0.md verdict-T15.md artifacts.json
scripts/
  claim.sh session.sh session-log.sh gate.sh install-prompts.sh mac-setup.sh
  deploy.sh rollback.sh prod-check.sh prodro.sh secrets-run.sh
  mirror-github.sh make-staging-bundle.sh
.agents/skills/<role>/SKILL.md
.agents/skills/<role>/agents/openai.yaml
.claude/skills/<role>/SKILL.md
# ops-lock branch only: ops/{LOCK,PROD_LOCK,STAGING_LOCK}
```

`make-staging-bundle.sh` executes on the box only. `docs/README.md` maps documents, including root AGENTS/HANDOFF and `ops/ROADMAP.md`.
PRDs derive from `/workspace/pm-saas/design/<feature>/spec.md`; design-system sources are brand-v2 `tokens.css`, `src/brand/tokens.json`, `guideline/index.html` and `flag-on-decisions.md`.
Engineering standards derive from rules/gates/CI; QA points to PRD acceptance and Class A/B gates; DECISIONS is an ADR log seeded from PRINCIPLES, `_app_decisions.md` and the Q&A.
`board.md` records lane, owner, class, branch/SHA, file claims, status, next command, dependencies and release position.
Git stores sanitized summaries/manifests; private R2 stores large evidence with object key, SHA-256, size and retention date.

## 4 Lock/claim protocol

`claim.sh acquire repo B` fetches `ops-lock`, requires RELEASED, and creates a direct child commit recording owner, host, UUID, generation, timestamps and handoff commit.
Push uses explicit compare-and-swap; rejection requires refetch and reassessment:
```sh
git push origin "$new:refs/heads/ops-lock" \
  --force-with-lease="refs/heads/ops-lock:$old"
```
`session.sh` supervises desktop terminal jobs, agents and automation, checks ownership before mutations and renews every two minutes. Network failure stops new work.
Release requires draining local/remote jobs, publishing checkpoints, then STOPPED → RELEASED.
Ten minutes without renewal means SUSPECT, never available. Ron may take over only after shutdown or credential/network fencing, outstanding deployment/DB checks and recorded evidence.
`PROD_LOCK` requires repository ownership and records lane, SHA, baseline, rollback version and phase; retain through T+15 PASS or completed incident resolution. Never auto-expire. Apply equivalent staging claims.

### Origin access from the Mac

Official Origin CLI/Git documentation fetched 2026-10-27 supports macOS browser login and a Git credential helper; Origin is early beta.
No repository is on the Mac yet. At inventory time, production `5d8b002` and lanes exist only in `/workspace/condola-i12/.git`; Origin main is stale `2bedb89`.
```sh
curl -fsSL https://downloads.cursor.com/origin/install.sh | sh
# Add ~/.local/bin to PATH in ~/.zshrc.
origin auth login
origin auth status
git ls-remote https://origin.cursor.com/ron-shih/condola-app.git
```
SSH alternative: `origin ssh-key add ~/.ssh/id_ed25519.pub -t mac-mini`; host fingerprint is `SHA256:EgIVKsf8fXGd7oj12nE0juHrGGPU8QLVfpGM3ymunGM`.
Fallback: authenticate GitHub via `gh auth login`/macOS keychain, read the private mirror and push only `mac/<lane>` branches. A, holding Origin's lock, reviews and imports those branches to Origin.
This explicit fallback import is not automatic reverse mirroring. The Mac cannot hold the lock or execute Mode B until Origin access works.

## 5 Quality gates and verdict formats

`scripts/gate.sh "$SHA"` uses a clean pinned checkout, pinned Node/npm, PostgreSQL 16 and a disposable DB:
```text
npm ci; typecheck; lint; test:unit; test:rls; copy:check; flag-expiry check
```
Both machines and Depot use this entrypoint. Releases add build, Worker and relevant browser checks. Preserve raw failures; baseline exceptions need exact-SHA QA disposition.
- **Class A:** final SHA/base, independent reviewer/session, scope, changed files, findings, acceptance matrix, evidence, limitations and PASS/FAIL.
- **Class B:** Codex draft; migration/catalog reconciliation, fresh restore-verified backup, before/after counts, verified rollback ID, T+0/T+15 monitoring.
- **Pre-deploy:** first four conditions ready, including before-counts/after-count plan; approved monitoring harness; independent QA and CEO GO naming SHA/slot.
- **Production verdict:** SHA/version, timestamps, baseline errors, pages/roles, Worker logs, counts, PASS/NO-GO and action; T+15 ≥900 seconds after full traffic.

Preserve e-sign G0–G5, catalog manifests, lock sampling, preview smoke and frozen script hashes. Never invent a migration ledger. Candidate/baseline changes invalidate approvals.
Wrappers validate ownership, resource claims and applicable approvals:
```sh
TARGET_SHA="$SHA" scripts/deploy.sh production
TARGET_VERSION="$ROLLBACK_VERSION" scripts/rollback.sh
```
Unknown cause means NO-GO and compatible code rollback; DB recovery is fix-forward.
Flags require owner/expiry, global kill, org overrides and internal→ea→ga CEO approvals; remove release flags 14 days after stable GA.

## 6 Role reproduction in Mode B

`install-prompts.sh` generates six roles (`pe,qa,ceo,rd,start,handoff`) from `ops/roles/*.md` into both skill trees; stop writing `~/.codex/prompts` and `.claude/commands`.
Codex: add repo as a Local project. It reads root `AGENTS.md` and global `~/.codex/AGENTS.md`; combined default cap is 32 KiB (`project_doc_max_bytes`). Keep instructions short.
Codex skills use name/description frontmatter, explicit `$pe` etc.; generated `agents/openai.yaml` sets `policy.allow_implicit_invocation: false`.
Codex app worktrees start detached under `$CODEX_HOME/worktrees`; attach a lane branch before publishing. Never list secrets in `.worktreeinclude`. A `.codex/` local environment may run `npm ci`.
Claude desktop: Code tab → Local environment → Open folder; loads project/global CLAUDE.md, with project `@AGENTS.md` import.
Claude skills use `/`; desktop slash autocomplete has known limitations. Fallback: “follow .claude/skills/qa/SKILL.md”.
No Codex/Claude CLI installation is required. Bash gates/claims/secrets wrappers run in Terminal or an app's terminal tool; require Git, pinned Node/npm, PostgreSQL 16 and age.
`mac-setup.sh` checks desktop apps and installs those tools plus Origin CLI; TODO(Ron): confirm exact app bundle names.

| Role | Contract |
|---|---|
| PE | Read state, reserve files under Rule 7, implement approved scope, run gates, checkpoint next command. |
| QA | Independently inspect exact diff/evidence; record omissions, verdict and limits. |
| CEO | Prioritize roadmap, decide GO/NO-GO and rings; Ron decides in B. |
| R&D | Source research, options/spec/acceptance; reserve files before implementation. |

QA uses another model or a fresh unshared session. Class A retains fresh Codex verdict; Class B retains Codex draft and independent QA.

## 7 Secrets to Mac

Ron generates a dedicated key ON THE MAC:
```sh
brew install age
age-keygen -o ~/.config/condola/age/mac.key
chmod 600 ~/.config/condola/age/mac.key
```
Decided (Ron 10/27 11:44 PT): plain key file, no Touch ID/Secure Enclave. Dir `~/.config/condola/age/` is mode 700, key 600, outside the repo; `secrets-run.sh` refuses a key with looser mode or inside a git checkout.
Backup: Ron keeps ONE offline copy of `mac.key` on an encrypted medium he controls (e.g. APFS-encrypted USB drive or encrypted .dmg), never in iCloud/Drive, chat, email or any repo. If the key is lost or exposed: generate a new key, send the new public recipient, box re-issues the bundle, PE rotates staging keys on suspected exposure.
Send ONLY the public recipient to the box. Never send private identity material.
Box `make-staging-bundle.sh <recipient>` reads an explicit staging-variable allowlist from `/home/box/.secrets/condola_staging.env` plus staging QA envs.
Reject production-looking names/values, including prod project ref, `condola-prod`, `PROD`; exclude `ID_DOC_*` and production service-role keys.
Encrypt `.env.staging` to `condola-staging-<date>.env.age`; print SHA-256 and variable names only; shred plaintext temp. Ron downloads and verifies checksum.
Mac `scripts/secrets-run.sh staging -- <cmd>` decrypts into process environment only; no plaintext repo file or tracing. Ignore `*.env*` and `*.age`; do not commit bundles.
Include staging Supabase, staging-only Worker deploy token and staging QA accounts. No routine production credentials.
On suspected exposure PE rotates staging keys and reissues; bundle policy expires after 30 days.
1Password would require Ron's adoption, paid account, CLI and vault setup; consider later. The offline `condola-backup` identity unlocks prod backups and must never live on this daily-driver Mac.

### Release scope in Mode B

Normal B verifies and deploys staging only. Production waits for A's Class B process when Grok returns.

| Option | Scope | Reason |
|---|---|---|
| Staging-only | B never promotes prod | Smallest credential exposure; incidents wait for A. |
| Staging + emergency **[approved 10/27]** | Ron-only P0 fix or rollback | Preserves owner incident response with short-lived access. |
| Full prod | Routine Mac production releases | Not recommended: box backup/catalog/count tooling is not provisioned on Mac. |

Emergency requires repository ownership, `PROD_LOCK`, recorded rollback version, staging-verified SHA for a new fix, `gate.sh --release`, deploy/rollback wrapper and model-run T+0/T+15 checks.
Only Ron himself creates a Cloudflare token scoped to Worker deployment for `condola-prod`, expiry ≤24h; revoke after use. Never add it to the staging bundle or persistent Mac configuration.
Prefer rollback via wrapper (`wrangler versions deploy <OLD>@100%`); dashboard Deployments → rollback is also available and must be recorded.
No DB migrations from the Mac; fix-forward waits for A. Missing monitoring blocks a PASS. Record emergency authorization/evidence and require post-hoc Class B review when Grok returns.
Reasons: staging-only credentials, five-condition box tooling, sequential releases through 2026-11-10 and reduced production exposure.
Open: PE/QA must implement and test the emergency wrapper/monitoring path before relying on it (see §13).

## 8 Model-call logging parity

A retains `llm-route` usage.log and sanitized exports. Desktop apps do not write that log.
Ron/agent runs `scripts/session-log.sh` at session start/end, writing `ops/log/<date>/<session>.jsonl`: PT timestamp, mode, role, app/model, reasoning if known, session, lane/SHA, outcome and evidence links.
Commit trailers: `Model:`, `Role:`, `Session:`. Tokens/cost are `unknown` when unavailable; never imply complete internal-call accounting. Do not commit secret-bearing transcripts.

## 9 Resume protocol for Grok agents

1. Fetch Origin, inspect claims, remain dormant while B owns.
2. Read policies, HANDOFF, board, statuses and verdicts.
3. Inspect `git log --all --since="$LAST_HANDOFF"` plus explicit recorded commit ranges.
4. Fetch lanes; preserve divergent/uncommitted box work before reconciliation.
5. Read live production/flags/artifact/quota records; acquire A before execution.
6. Record acceptance, mirror fresh Origin refs, then resume exact next command; memory never overrides evidence.

## 10 Switch triggers + summary of both checklists

Check `llm-route --quota`; proposed triggers: <20% remaining, inadequate execution/QA reserve, exhaustion, Ron's choice or incident.
A→B: stop dispatch → finish monitoring/incident → drain → publish checkpoints/HANDOFF → mirror while A owns → release A → claim B → reconcile → stage only.
B→A: drain desktop jobs → publish checkpoints/logs/emergency record → mirror while B owns → release B → A claims → A mirrors fresh Origin → resume.
Only the holder pushes; Ron never mirrors after releasing B. Every holder mirrors after Origin pushes and at handoff.
Mirror script fetches Origin with prune, then mirrors fresh Origin main, ops-lock, lane refs and tags using explicit per-ref leases against freshly observed GitHub refs; never working-tree refs.
Box uses single-repo Contents read/write PAT `GITHUB_MIRROR_TOKEN` under `/home/box/.secrets/`; Mac uses its own GitHub keychain login, never the staging bundle.
GitHub direct commits are drift: report and port through Origin PR review, never auto-merge. Do not attach inbound Cursor GitHub sync; Actions disabled by default.
HANDOFF includes SHAs/ranges, next commands, blockers/order, prod/rollback, flags, quotas, claims and PT STOP POINT; rewrite on departure/acceptance.
One-time freeze/publication waits for ALL current lanes: errors-redact → end_auth_sessions (`46d1f99`, retry) → id-photo-90d → e-sign; also privacy-ai, react-418 investigation, backup-acl scheduled-run verification, brand-v2 (`65a676c`, undeployed).
Every lane must ship with T+15 PASS or be explicitly parked by CEO with recovery refs. Through November 10, next release requires previous T+15 PASS.

## 11 One-time migration + rollout steps with effort hours

1. **Readiness, 2–3h:** reconcile entire board and obtain all-lane completion/parking evidence; shipping time excluded.
2. **Freeze/preserve, 4–6h:** then stop Cursor cloud automations and box writes; inventory worktrees/dirty/tarball work, back up Git and scan secrets.
3. **Publish/bridge, 3–5h:** preserve Origin `2bedb89`, production `5d8b002` and every lane/recovery ref; review Origin-only changes; create a two-parent bridge retaining reviewed production tree and both histories. Verify remote reachability/tree; no blind force-push.
4. **Mirror/cleanup, 2–3h:** create private GitHub mirror and verify first push; regenerate `/workspace/ops/handoff/evidence-cleanup-plan.md`. Plan approved by Ron (10/27 11:44 PT); PE regenerates it right before running and deletes only listed paths; code artifacts wait until Origin publication is verified.
5. **Canonicalize/tools, 10–14h:** compact docs/policies, gates, locks, templates, skill generation, mirror, bundle and session wrappers; retain sanitized evidence.
6. **Mac provisioning, 4–6h:** tools/apps → Origin login/access → clone published repo → GitHub credential → skill generation → Mac key/public recipient → box bundle → checksum/decrypt → staging access/gates.
7. **Drill, 4–6h:** competing claims, network loss, staging rollback and A→B→A; no routine Mac prod deployment.

Total: **29–43 engineering hours**, excluding lane shipping, approval waits and transfers. Use `checklists/freeze-and-publish.md`.

## 12 Risks + mitigations

Origin early beta: verify account/Git access; GitHub fallback cannot hold Origin locks or authorize Mode B.
Outbound mirroring is our script: monitor failure/drift, verify remote SHAs, restrict mirror writers; never accept GitHub as automatic upstream.
Staging bundle leak: allowlist, no prod/ID keys, memory-only decrypt, checksum, 30-day reissue and immediate rotation on suspicion.
Rule 7 prevents overlapping edits; disable ungated automation. Missing independent QA/evidence blocks release.
Wording: 租客 and 房客 allowed; use 屋主, never 房東. Ban verified-tenant claims (已驗證/實名認證 etc.), 收款/收租/代收/入帳/已收 and 保證. No company-status, property-management or rent-guarantee claims.
Exact PE change at production `5d8b002`, `src/i18n/copy-guard.test.ts:9`:
```ts
// Existing:
const FORBIDDEN = ["房東", "房客", "收款", "收租", "即將推出", "測試模式", "範例沙盒", "示範"];
```
Remove `"房客"`; retain other entries; add `"代收"`, `"入帳"`, `"已收"`, `"保證"` coverage. Reserve file first; drafts do not edit product code.
PE must inspect approved strings before implementation: literal 已收 matches legitimate 已收到. Use a reviewed narrower pattern (e.g. `/已收(款|租|訖)/`) or allowlist; preserve existing lease-asset exclusion for legal 保證 text.
Update AGENTS wording; remove “respect 房客 ban”. Test fixtures may retain 房客. Keep zh-TW in dictionaries; avoid hardcoded Taiwan locale/timezone/currency.

## 13 Decided and Open

Decided (Ron, 2026-10-27 11:44 PT): GitHub mirror `ronshih0130/condola-app` (private); plain age key file at `~/.config/condola/age/mac.key` (600, outside repo, one offline encrypted backup); Mode B normally staging-only with the emergency prod path as designed; evidence cleanup plan approved, executed by PE.

### Done (2026-10-27 12:30–12:45 PT, Ron-approved pre-freeze steps)
- Mac Origin access confirmed: Origin CLI logged in on Ron's Mac mini; `git ls-remote https://origin.cursor.com/ron-shih/condola-app.git` works.
- Mac age key: `~/.config/condola/age/mac.key` (600, dir 700); public recipient saved at box `ops/handoff/mac.pub`.
- Staging bundle `condola-staging-20261027.env.age` (SHA-256 `e69743b755154de0937c3e56e81520185143c71ddac634fbe0cb34ffb75eceee`, issued 2026-10-27, expires 2026-11-26) built by `make-staging-bundle.sh` with allowlist `ops/staging-bundle.allowlist`; installed at Mac `~/.config/condola/staging.env.age` (600); decrypt verified names-only. Vars: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL, DATABASE_URL_SESSION (all verified against the staging project ref, none equal prod).
- Kit copied to Mac `~/condola-handoff-kit` (local git init, no remote, no commits); `install-prompts.sh` generated project skills there; user-level copies installed at `~/.agents/skills/condola-<role>/` (Codex in ChatGPT.app) and `~/.claude/skills/condola-<role>/` (Claude.app Code tab).

### Open
- GitHub mirror created by Ron 2026-10-27 13:42 PT: `github.com/ronshih0130/Condola-app` (private, empty, no branches; GitHub names are case-insensitive so the script URL works). Actions disabled (Ron confirmed 13:44 PT). First push still waits for the freeze.
- Staging bundle omits staging QA logins and a staging-only Worker deploy token (none NAME=value-ready / not provisioned); add explicitly if needed.
- After the canonical repo is cloned on the Mac, remove the user-level `condola-*` skill copies (or keep and drop repo duplicates) to avoid duplicate entries.
- Ron: approve the production test organizations.
- Ron/CEO: how long to keep the remaining (kept) evidence, and whether it moves to private R2.
- PE/QA: confirm the exact Mac app bundle names (Codex/ChatGPT, Claude) in `mac-setup.sh`.
- PE/QA: implement and test the emergency prod path (wrapper, short-lived token flow, T+0/T+15 monitoring) before relying on it.

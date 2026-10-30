<!-- DRAFT for Ron + CEO approval (2026-10-27 PT). Not committed. -->
# HANDOFF

- Written by / role / session: `<name> / <role> / <session>`
- App / provider / model used: `<app and mode-specific runner / provider / exact model or unknown>`
- Departing mode → receiving mode: `<A|B> → <A|B>`
- Written at PT: `<YYYY-MM-DD HH:mm:ss America/Los_Angeles UTC±HH:mm>`
- State: `<departure|accepted|blocked>`
- Departure checkpoint / accepted checkpoint: `<full SHA> / <full SHA|pending>`
- Receiving owner / acceptance time PT: `<owner> / <time|pending>`

## Ownership and remotes
- Canonical Origin: `https://origin.cursor.com/ron-shih/condola-app.git`
- Repo lock: generation `<n>`; UUID `<uuid>`; owner/host `<owner/host>`; state `<state>`.
- Last renewal PT / lock commit / recorded handoff commit: `<time> / <SHA> / <SHA>`.
- Production lock: `<free|lane/SHA/baseline/rollback/phase/generation>`.
- Staging lock: `<free|lane/SHA/phase/generation>`.
- Local children and remote jobs: `<drained evidence|remaining jobs and owners>`.
- Outstanding deployment/DB operations: `<none|operation, phase, owner>`.
- Fencing/break-glass evidence: `<path|none>`.
- Private GitHub mirror repository: `ronshih0130/condola-app` (decided 2026-10-27 11:44 PT; creation pending Ron as of 12:45 PT, connector cannot create repos; no push before freeze).
- Mirror status / last mirrored main SHA / completion PT: `<success|blocked|unknown> / <SHA> / <time>`.
- Mirrored lane/tag/ops-lock inventory and drift/blockers: `<sanitized evidence path|TODO>`.
- Mirror executed by current lock holder via `scripts/mirror-github.sh`; no direct GitHub pushes or GitHub→Origin sync.

## Staging access
- Staging bundle ID / issue date / expiry date / SHA-256: `<nonsecret identifier> / <date> / <date> / <hash>` (first issue: `condola-staging-20261027.env.age` / 2026-10-27 / 2026-11-26 / `e69743b7…eceee`; Mac path `~/.config/condola/staging.env.age`).
- Staging access verification: `<PT time / sanitized evidence|pending>` (2026-10-27 12:33 PT: Mac decrypt verified, names only).
- Mac role skills: `~/condola-handoff-kit/.agents|.claude/skills/<role>/`, user-level `~/.agents/skills/condola-<role>/`, `~/.claude/skills/condola-<role>/` (installed 2026-10-27 PT).
- Mac staging commands use `scripts/secrets-run.sh staging -- <cmd>`; record no secret values.
- Mac has no stored prod keys, ID-doc keys or prod backup identity.

## Production
- Live code SHA: `<full SHA|unknown—block release>`
- Worker / environment: `condola-prod` / `production`
- Live Worker version / traffic: `<version UUID> / <allocation>`
- Last observed PT / `/api/version` x3 evidence: `<time> / <path>`
- Rollback code SHA / Worker version: `<SHA> / <version UUID>`
- Rollback compatibility / verification evidence: `<path>`
- Last release T+0 / T+15 verdicts: `<paths and results>`
- Approved production test organizations: `<reference|TODO—block affected checks>`
- Ordinary Mode B release scope: staging only; prod waits for Mode A Class B.

## Emergency production actions taken in Mode B
- Actions / incident / Ron's authorization: `<none|P0 customer-impacting fix or rollback; evidence>`.
- Staging-verified SHA / deployed version / recorded rollback version: `<SHA / version / version|not applicable>`.
- Repo and PROD_LOCK claim / phase / disposition: `<evidence|not applicable>`.
- Release gate / deploy or rollback wrapper / runbook evidence: `<paths|not applicable>`.
- Ron-created Worker-deploy-only token expiry / revocation evidence: `<PT time / sanitized path|not applicable>`; never record the token.
- T+0 / T+15 model, session, timestamps and verdicts: `<references|pending|not applicable>`.
- No Mac DB migrations confirmation: `<evidence|not applicable>`.
- Required post-hoc Class B review on Mode A return: `<owner / next action / status|not applicable>`.

## Flags and overrides
- Registry SHA/path: `<SHA>:ops/flags.yaml`
- Ring approvals / global kill state / per-org overrides: `<reference>`
- Flags shipped OFF / pending transitions / expiry and deletion deadlines: `<details>`
- Legal/paid GA review by Ron: `<reference|pending|not applicable>`

## Release-order queue
| Position | Lane | Candidate SHA | Dependencies | QA / CEO GO + slot | Previous T+15 | Next action |
|---|---|---|---|---|---|---|
| `<n>` | `<lane>` | `<SHA>` | `<lanes>` | `<paths/status>` | `<PASS path|pending>` | `<action>` |

## In-flight lanes
| Lane | Branch | SHA | Class | Status | Next exact command | Owner |
|---|---|---|---|---|---|---|
| `<lane>` | `<branch>` | `<full SHA>` | `<A|B>` | `<state>` | `<command; cwd; nonsecret prerequisites>` | `<owner>` |

- Claimed files / Rule 7 conflicts: `<ops/board.md reference>`
- Divergent, dirty or tarball-only work and recovery refs: `<refs/paths|none>`
- Pending gate failures / exact-SHA QA dispositions: `<paths|none>`
- Freeze/publish eligibility: `<blocked|all PE lanes shipped with T+15 PASS, or CEO-parked with recovery refs>`.
- `checklists/freeze-and-publish.md` evidence / outstanding lanes: `<path / details>`.

## Blockers / decisions needed from Ron
| Decision or blocker | Evidence | Blocked action | Owner |
|---|---|---|---|
| `<test orgs / retention / GitHub mirror repo creation / other TODO>` | `<path>` | `<action>` | `<owner>` |

## Quota snapshot
| Observed PT | App / provider / account alias | Remaining / reset | Execution + QA reserve | Source |
|---|---|---|---|---|
| `<time>` | `<app / provider / alias; no credentials>` | `<value or unknown>` | `<sufficient|insufficient|unknown>` | `<sanitized path>` |

- Grok/router availability: `<state>`
- Shared account exhaustion risk: `<state>`
- Tokens/cost unavailable: `unknown`

## Last STOP POINTs
| Lane/session | PT timestamp with offset | Exact STOP POINT | Evidence |
|---|---|---|---|
| `<lane/session>` | `<time>` | `<state; next command; owner>` | `<status.md path>` |

## What changed since last handoff
- Previous handoff checkpoint → current checkpoint: `<OLD>..<NEW>`
- Additional lane ranges / divergent ranges: `<ranges>`
- Changes, decisions and invalidated approvals: `<summary>`
- Inspect: `git log --all --since="$LAST_HANDOFF"` and `git log --oneline "$OLD..$NEW"`.
- Artifact manifests / access verification / retention dates: `<paths>`
- Sanitized session logs: `<paths>`; Mode B start/end records from `scripts/session-log.sh`.
- Commit trailers checked: `Model:`, `Role:`, `Session:`.

## Do not touch
- `<paths/resources; reason; owning lane; release condition>`
- Secrets and raw transcripts never enter this document.
- Preserve active production locks, recovery refs, frozen scripts and evidence.
- `<unresolved incident operations or migration ordering constraints>`

## Acceptance
- [ ] Receiver fetched branches and inspected locks, policies, ranges, lane PRDs and latest verdicts.
- [ ] Production, rollback, flags, artifacts, quota and mirror status reconciled against evidence.
- [ ] Staging bundle ID/date and access verified without exposing values.
- [ ] Emergency B actions and required post-hoc Class B reviews acknowledged.
- [ ] Receiver acquired repository ownership and recorded the new generation.
- [ ] Differences resolved or explicitly blocked; next commands and owners confirmed.
- [ ] This handoff and `ops/board.md` updated on `main`.

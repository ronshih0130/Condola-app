<!-- DRAFT for Ron + CEO approval (2026-10-27 PT). Not committed. -->
# <lane> production verdict — <T+0|T+15|rollback verification>

- Outcome: `<PASS|NO-GO>`
- Candidate / deployed code SHA: `<full SHA> / <full SHA>`
- Worker / environment / version: `condola-prod / production / <UUID>`
- Traffic allocation: `<allocation>`
- Baseline SHA / version: `<SHA> / <UUID>`
- Rollback SHA / version: `<SHA> / <UUID>`
- Mode / executor session / independent QA session: `<values>`
- Reviewer / provider/model / reasoning: `<values>`
- Repo generation / production claim / phase: `<values>`
- CEO GO SHA/slot / QA approval: `<approvals.md references>`
- Frozen harness / script hashes: `<references>`

## Timing
- Full traffic confirmed PT: `<YYYY-MM-DD HH:mm:ss America/Los_Angeles UTC±HH:mm>`
- Full traffic UTC/epoch: `<value>`
- Check start / finish PT: `<times with offsets>`
- Elapsed seconds at check start: `<n>`
- Baseline / observation windows: `<windows>`
- T+15 requires elapsed ≥ 900 seconds; early execution cannot satisfy T+15.

## Deployment identity
| `/api/version` request on app.condola.app | Observed identity | Expected match | Evidence |
|---|---|---|---|
| 1 | `<SHA/version>` | `<yes|no>` | `<path>` |
| 2 | `<SHA/version>` | `<yes|no>` | `<path>` |
| 3 | `<SHA/version>` | `<yes|no>` | `<path>` |

## Checks
| Area | Baseline / expected | Observed | Result | Evidence |
|---|---|---|---|---|
| Client-visible errors | `<comparable baseline>` | `<counts/rates/window>` | `<PASS|NO-GO>` | `<path>` |
| Key pages / flows | `<routes and expectations>` | `<results>` | `<result>` | `<path>` |
| Roles / cross-org denial | `<identities and access rules>` | `<results>` | `<result>` | `<path>` |
| Worker logs | `<baseline noise/errors>` | `<new anomalies>` | `<result>` | `<path>` |
| Flags / overrides / global kill | `<approved state>` | `<observed state>` | `<result>` | `<path>` |
| Feature-specific acceptance | `<required live checks>` | `<results>` | `<result>` | `<path>` |

## Row counts
| Table | Before / time | After / time | Delta | Approved explanation | Result |
|---|---|---|---|---|---|
| `<table>` | `<count/time>` | `<count/time>` | `<delta>` | `<normal activity or finding>` | `<PASS|NO-GO>` |

## Findings and limits
- New client-visible errors versus baseline: `<none|details>`
- Known baseline noise / tracking reference: `<reference>`
- Missing checks or evidence: `<none|details; blocks PASS>`
- Verification limits: `<limits>`
- Unknown cause or unexplained anomaly: `NO-GO`.
- Evidence manifest: `e2e/results/<lane>/artifacts.json`
- Private objects: `<keys, SHA-256, sizes, retention dates; no secrets/customer identifiers>`

## Decision and action
- Independent QA conclusion / signature / time PT: `<values>`
- CEO decision / identity / time PT: `<values>`
- Action: `<continue monitoring|accept release|kill flag and rollback|continue incident recovery>`
- Next exact command / owner: `<command> / <owner>`
- T+0 PASS: retain production claim; T+15 remains pending.
- T+15 PASS: update handoff/board, then release production claim.
- NO-GO: compatible code rollback; DB fix-forward; retain claim until incident resolution.
- Rollback command: `TARGET_VERSION="$ROLLBACK_VERSION" scripts/rollback.sh`
- Rollback verification / incident resolution evidence: `<paths|not applicable>`
- Queue advancement permitted: `<yes only with required T+15 PASS|no>`
- Status entry: `<PT timestamp> STOP POINT: <state>; next: <exact command>; owner: <owner>`

Model: `<provider/model>`
Role: `QA`
Session: `<session ID>`

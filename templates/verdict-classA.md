<!-- DRAFT for Ron + CEO approval (2026-10-27 PT). Not committed. -->
# <lane> Class A verdict

- Final SHA: `<full immutable SHA>`
- Branch / base SHA: `<branch> / <full SHA>`
- Classification / rationale: `Class A / <reason>`
- Reviewer / provider/model / reasoning: `<values>`
- QA session / implementation session: `<distinct IDs>`
- Independence: `<fresh unshared Codex session; additional reviewer if any>`
- Reviewed at PT: `<YYYY-MM-DD HH:mm:ss America/Los_Angeles UTC±HH:mm>`
- OVERALL: `<PASS|FAIL>`
- Release/deployment status: `<not deployed|separate production verdict paths>`

## Review scope
- Exact diff: `<base>..<final SHA>`
- Inspected directly: `<files, code paths, evidence>`
- Executed by this reviewer: `<commands/results|none>`
- Supplied evidence only: `<paths, producer/session>`
- Excluded scope: `<limits>`
- This verdict does not assert unperformed staging or production verification.

## Files changed / Rule 7
| Path | Change | Claiming lane | Overlap evidence |
|---|---|---|---|
| `<path>` | `<summary>` | `<lane>` | `<board/check reference>` |

## Findings
| Severity | File/location | Finding | Required action / disposition |
|---|---|---|---|
| `<blocking|nonblocking|none>` | `<location>` | `<finding>` | `<action>` |

## Acceptance matrix
| Requirement | Rating | Evidence | Limit / required live check |
|---|---|---|---|
| `<criterion>` | `<PASS|FAIL|NOT-VERIFIABLE-HERE>` | `<path and result>` | `<limit>` |
| Wording and dictionary-only copy | `<rating>` | `<copy:check + inspection>` | `<limit>` |
| Authorization / cross-org isolation | `<rating>` | `<evidence>` | `<limit>` |
| Client-visible errors | `<rating>` | `<window/environment>` | `<limit>` |

## Gate evidence
| Check | Candidate SHA | Result | Evidence / producer |
|---|---|---|---|
| `scripts/gate.sh "$SHA"` | `<SHA>` | `<result>` | `<path/session>` |
| Build / Worker / relevant browser checks | `<SHA>` | `<result|not applicable + reason>` | `<paths>` |

- Known baseline failures: `<none|exact failure, baseline/candidate SHAs, named QA disposition>`
- Unexplained failures: `<none|blocking details>`

## Evidence provenance
- Manifest: `e2e/results/<lane>/artifacts.json`
- Each artifact: `<private R2 object key, SHA-256, size, retention date>`
- Environment / toolchain / frozen script hashes: `<references>`
- Raw failures retained privately: `<references|none>`
- Missing/inaccessible evidence: `<none|blocking details>`

## Verification limits and required live checks
| Check | Environment / identity | Expected result | Owner | Required stage |
|---|---|---|---|---|
| `<check>` | `<approved test org/role>` | `<result>` | `<owner>` | `<preview|T+0|T+15>` |

- Blocking before release: `<none|items>`
- Deferred live checks do not count as executed PASS.
- Approval invalidated by candidate/baseline change.
- Reviewer sign-off: `<name/session/time PT>`
- Next exact command / owner: `<command> / <owner>`

Model: `<provider/model>`
Role: `QA`
Session: `<session ID>`

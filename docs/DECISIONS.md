# Decision log
Format: ID | date PT | status | decision | why | consequences | source.
“Accepted” records the decision; it does not assert implementation or deployment.
Later decisions override conflicting older scope; unresolved conflicts remain TODO(owner).
Dates without a source year are interpreted within the attached October 2026 context.

## Core principles
ADR-001 | 2026-10-27 PT | Accepted | Dark-launch large features; low-risk fixes may ship enabled | Limit exposure | Separate deployment from activation | PRINCIPLES.md §1.
ADR-002 | 2026-10-27 PT | Accepted | internal→ea→ga, CEO GO each step; Ron reviews legal/paid GA | Controlled exposure | Record promotion approvals | PRINCIPLES.md §2.
ADR-003 | 2026-10-27 PT | Accepted | Org overrides plus global off for every flag | Operational control | Activation supports both scopes | PRINCIPLES.md §3.
ADR-004 | 2026-10-27 PT | Accepted | Prod test orgs default to all features; CEO approves org list | Avoid extra test restrictions | Maintain approved org list | PRINCIPLES.md §4.
ADR-005 | 2026-10-27 PT | Accepted | Register flag owner/expiry; remove release flags after 14 stable GA days; quarterly kill-switch review | Flag hygiene | CI blocks expiry | PRINCIPLES.md §5.
ADR-006 | 2026-10-26 PT; amended 2026-10-27 PT | Accepted | Through 11/10 PT, sequential releases after prior T+15 PASS; Class B has five conditions plus QA/CEO approval | Release safety | Unknown cause means NO-GO/rollback; DB fix-forward | PRINCIPLES.md §6.
ADR-007 | 2026-10-27 PT | Accepted | Gate on client-received errors; track existing noise separately | Measure user impact | Release noise must not exceed baseline | PRINCIPLES.md §7.
ADR-008 | 2026-10-26 PT | Accepted | External LLM writes/runs prod tests and verdicts | Separate execution from decisions | Bot interprets verdicts | PRINCIPLES.md §8.
ADR-009 | 2026-10-27 PT | Accepted | External AI may receive necessary customer fields; mask ID/bank numbers; disclose processors | Minimize data exposure | Secrets referenced only by path/name; RULES additionally bans ID-photo attachments | PRINCIPLES.md §9; RULES.md.
ADR-010 | 2026-10-26 PT | Accepted | Sensitive data follows least privilege | Restrict unnecessary access | Accountant cannot view ticket photos | PRINCIPLES.md §10.
ADR-011 | 2026-10-27 PT | Accepted | Keep review period; use manual lease upload for notarization/identity-confirmation failures | Proceed with defined fallback | 租客 and 管理方 handle review-period withdrawal directly | PRINCIPLES.md §11.
ADR-012 | 2026-10-27 PT | Accepted | Continue LGPL use with unmodified, independently loaded packages and notices | Stated licensing policy | Preserve notices/loading constraints | PRINCIPLES.md §12.
ADR-013 | 2026-10-27 PT | Accepted | Read latest status/verdict before reporting to Ron | Avoid stale reports | Memory alone is insufficient | PRINCIPLES.md §13.
ADR-014 | 2026-10-27 PT | Accepted | Escalate only Ron-only legal/business/account/key decisions | Keep routine work moving | CEO decides other matters | PRINCIPLES.md §14.

## App decisions
ADR-020 | 2026-10-25 PT | Accepted | Tenant app is mobile web sharing `/t`, with LINE entry/login/LIFF/rich menu in P1's free scope | Reuse existing app | No separate native app required for this scope | app_decisions.md, form.
ADR-021 | 2026-10-25 PT | Accepted | Shared Condola LINE account pushes only payment-report results and repair status; switch to email at 180 messages/month | Bound notification scope | Other notices use email, Reply API or LIFF | app_decisions.md, LINE Push.
ADR-022 | 2026-10-25 PT | Accepted | Basic signing uses uploaded files; optional in-house online signing, no third-party signature service | Defined basic/optional paths | Support PDF/JPG and other file types | app_decisions.md, signing.
ADR-023 | 2026-10-25 PT | Accepted | Move-in/out uses free-form tenant photos with time/account records | No template in scope | Preserve provenance | app_decisions.md, handover.
ADR-024 | 2026-10-25 PT | Accepted | Delete ID documents 90 days after lease end; open-ended leases require expected move-out date | Retention rule | TODO(owner): reconcile older deposit-settlement rule and current implementation | app_decisions.md, ID; MVP_Scope_v0.5.md.
ADR-025 | 2026-10-25 PT | Accepted | Trial is three calendar months | TODO(owner): rationale not supplied | TODO(owner): reconcile with P2 pricing | app_decisions.md, trial; ROADMAP.md.
ADR-026 | 2026-10-25 PT | Accepted | Ship repair #55 to spec; Vendor link in separate PR; fixed onboarding data and simple completion fields | Defined delivery split | Completion records service, amount and date | app_decisions.md, repair.
ADR-027 | 2026-10-25 PT 12:43 PT | Accepted | Electronic-stamp receipts are P1/Class B, no flag or accountant wait; individuals use work-completion/cost details without ID number | Explicit scope/timing | Target before 11/1 PT; no tax-outcome promises | app_decisions.md, receipts.
ADR-028 | 2026-10-25 PT | Accepted | Features before 11/1 PT; test-data E2E 11/2–11/6 PT; design partners 11/9 PT | Delivery schedule | Dates are targets, not completion evidence | app_decisions.md, schedule.

## Ron's Q1–Q9
ADR-101 | 2026-10-27 PT | Accepted design; implementation TODO | Native Cursor Origin is canonical; our tooling mirrors one-way to private GitHub | Origin documents inbound mirroring only | Lock holder mirrors fresh Origin refs; no inbound app sync; GitHub name TODO(owner) | decisions.md Q1.
ADR-102 | 2026-10-27 PT | Accepted approach; access unverified | Mac signs into Origin via CLI/browser credentials or SSH | Enable native Origin work | Verify account access; GitHub fallback allows branch work, not Mode B lock ownership | decisions.md Q2.
ADR-103 | 2026-10-27 PT | Recommended design | Transfer staging-only secrets in an age-encrypted bundle; decrypt to process env | Limit daily-driver exposure | No prod/ID-doc keys; 30-day policy expiry; Mac key-storage choice TODO(owner) | decisions.md Q3.
ADR-104 | 2026-10-27 PT | Accepted direction | Support Codex/Claude desktop apps with repo skills; no model CLIs required | Match Ron's workflow | Replace deprecated prompt generation; session trailers/logs; scripts still need local toolchain | decisions.md Q4.
ADR-105 | 2026-10-27 PT | Release policy | Mode B deploys staging; normal prod promotion waits for Mode A Class B gate | Mac lacks prod keys and box checks | Ron-only P0/rollback override with short-lived deploy credential, lock, probes and later review; no Mac DB migration | decisions.md Q5.
ADR-106 | 2026-10-27 PT | Accepted; code change pending | Permit 租客 and 房客; use 屋主; prohibit misleading verification, money-handling and outcome claims | Ron clarified copy policy | PE reserves copy-guard file, checks false positives and updates agent wording | decisions.md Q6.
ADR-107 | 2026-10-27 PT | Plan authorized | Prepare old disposable-evidence cleanup plan | Ron permits cleanup planning | No deletion executed by this decision; retention/scope TODO(owner) from cleanup plan | decisions.md Q7.
ADR-108 | 2026-10-27 PT | Accepted | Freeze/push only after every board lane ships with T+15 PASS or CEO parks it with recovery ref | Preserve in-flight work | Then freeze→Origin push→GitHub mirror; queue is a dated snapshot | decisions.md Q8.
ADR-109 | 2026-10-27 PT | Accepted | Keep ten short docs; PRDs per feature with index/template; map existing assets | Reduce agent reading cost | Agent order: AGENTS→HANDOFF→lane PRD; migrate design specs | decisions.md Q9.

Sources: `/workspace/ops/PRINCIPLES.md`; `/workspace/ops/RULES.md`; `app_decisions.md` (referenced as `_app_decisions.md` in Q9); `decisions.md` Q1–Q9; `MVP_Scope_v0.5.md`; `ROADMAP.md`.

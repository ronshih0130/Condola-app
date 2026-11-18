# AGENTS.md — Condola agent contract

This is the single operating contract for every agent working in this repo: Mac Claude Code and the box PE/QA bots read the same rules here. If a rule here and an older file disagree, this file wins. (The previous repo-root AGENTS.md / CLAUDE.md described a Cursor-Origin "Mode B" contract; PRINCIPLES P46 made GitHub canonical, so those are obsolete and replaced.)

## 1. Purpose and sources
Living detail stays in the private hub `condola-hub` (do not paste long hub text here, do not publish hub URLs):
- `00-ops/PRINCIPLES.md` (through P82) and `00-ops/RULES.md`
- `01-mission/dev-workflow.md` — the 10-step flow and templates
- `20-build/REVIEW-CHECKLIST.md`, `20-build/deploy-checklist.md`, `20-build/AUTONOMY-1113.md`
- `11-decisions/DECISIONS.md`

Box copies: `/workspace/ops` and `/workspace/condola-hub`. Cite hub paths/sections (e.g. `00-ops/PRINCIPLES.md` §51, `20-build/REVIEW-CHECKLIST.md` item 14) rather than copying.

## 2. Stack and commands
Production runtime is Cloudflare Workers + Supabase (Postgres, RLS) + TypeScript. This is NOT a Vercel/Next.js host. Local `npm run dev|build|start` invoke the Next.js CLI only because the Worker is built with OpenNext (`npm run cf:build` = `opennextjs-cloudflare build …`). Do not assume Vercel, `next start` in production, or generic Next.js hosting.

Node: version in `.nvmrc` (20.20.2). Tests run under `tsx --test` (node:test), assertions almost all `node:assert/strict` (a few use `expect`).

Real npm scripts (there is no script named exactly `test`):
- `typecheck` — `tsc --noEmit`
- `lint` — eslint
- `test:unit`, `test:rls`, `test:worker`, `test:e2e`
- `copy:check`
- `cf:build`, `cf:deploy:staging`
- `db:reset`, `db:migrate`

## 3. 10-step product flow (P51)
Every capability follows the 10 steps; proactively walk Ron through them when a new capability comes up. See `01-mission/dev-workflow.md`:
1. Problem & users (Persona, competitor/UX research) → 2. grill-me framing (decision record) → 3. User journey / user story + acceptance criteria → 4. Feature spec & BUILD-ORDER → 5. UX/UI design (each page/button has a purpose mapped to a story) → 6. System design + non-author QA security review → 7. Implementation (design note first; tests derive from AC; no page/button without a story) → 8. Verification (CI, model-swap non-author QA, staging four-role E2E) → 9. Release (CEO exact GO, flag OFF, T+0/T+15, internal org, rollback ready) → 10. Acceptance & feedback.

Steps 1–3 cannot be skipped: no Persona, no Ron-confirmed decision record, no story + AC ⇒ no design and no implementation.

## 4. User stories and AC (P71, P77)
- Acceptance criteria are markdown Given/When/Then written inside the story. No `.feature` files.
- Tests cite the story ID.
- Design order is fixed: grill → story/AC (Ron-approved) → screens rows + mockup → Ron approval → docs PR.
- Do not draw a mockup before an approved story.

## 5. Mockups before front-end work (P52)
Ron reviews the mockup (step 5) before any implementation (step 7):
- New page / new flow: clickable mockup covering empty, loading, error, success states and mobile.
- Existing-page edit: before/after static mockups, each changed element tagged with its purpose and story ID.
- Copy or small style tweak: annotated screenshot.

## 6. Non-author review (P82, P83, P66; REVIEW-CHECKLIST items 12, 14, 15)
- Any model family other than every author family of the PR (claude / codex / gemini incl. agy) satisfies review. Codex-first is a preference, not a requirement.
- Before `llm-route review`, derive each PR's author family from git — `Co-Authored-By` trailers, `Authored via llm-route <provider>`, `author rN <provider>`. Never infer family from the branch name. Never reuse one `--author-source` for a mixed-family batch; split mixed batches.
- Run `/workspace/ops/review-author-check.sh --repo <app> --author-source <src> --prs <list>` or `--range A..B` (use `--range` for unmerged PRs); keep the result with the review receipt.
- Every finding is tagged BLOCKING / SHOULD / NIT and carries a `repro:` field: a failing test, a script, or an exact command and its output showing the defect on the exact reviewed SHA (P83), e.g. `grep` / `psql` / `curl`; for an omission (e.g. a missing `REVOKE EXECUTE FROM PUBLIC`), a command whose output shows the absence (`grep -c 'REVOKE EXECUTE' <file>` → `0`). Findings without one are UNVERIFIED: record them in the receipt or OPEN-QUESTIONS (P69); they do not make the verdict FAIL.
- A reviewer that lacked needed code or files writes `INCOMPLETE CONTEXT: <missing files>`. That review is INCOMPLETE: re-run it with the missing files as a new call (never resend a call that succeeded). A FAIL verdict with no reproduced BLOCKING finding is also INCOMPLETE. INCOMPLETE reviews do not count toward P66.
- Two FAILs from non-author reviews, each with a reproduced BLOCKING finding, stop the item → log it in PENDING-RON; no third round without a CEO ruling.

## 7. Feature flags default OFF
New flags ship OFF with an expiry set. Flag-OFF table test (REVIEW-CHECKLIST item 13): every new flagged route/page/layout/server action must be listed in `src/server/b073-flag-off-endpoints.test.tsx` (or its successor) before merge. With the flag OFF and with a failing flag lookup, the endpoint must: return 404, read no body or request input, read no data beyond session and consent, perform no write, and write no audit row. Registry-completeness must pass.

## 8. RLS and tenant isolation (checklist items 2–3)
On every migration and every endpoint:
- Queries/functions scoped by `org_id` from the session, never from client input.
- RLS enabled on every new table; no anon grants; never disable RLS.
- `SECURITY DEFINER` functions pin `search_path` and `REVOKE EXECUTE FROM PUBLIC`.

## 9. Releases
No production deploy without: QA exact-SHA sign-off AND CEO exact-SHA GO, then T+0 and T+15 checks with rollback ready. Flags stay OFF unless a separate approved flag-on. Unknown cause = rollback the Worker; DB issues are fixed forward.

## 10. Secrets
No secrets in code, commits, logs, fixtures, chat, or transcripts. Reference names and protected paths only.

## 11. Outbound sends (P56)
Zero real outbound (SMS / email / LINE) without Ron's explicit, scoped, original-words approval for that specific send. Prior approval does not carry over to another send. Flags OFF must make every real outbound path unreachable (checklist item 5).

## 12. Git safety
Never force-push, admin-merge, or bypass required checks. Rebase your own docs branch onto current `origin/main`; never force-push a branch you don't own.

## 13. R1 — Bug-fix loop
Fix in this order: (1) update the spec's edge case first, (2) write a failing repro test, (3) then fix. Do not patch first and backfill tests.

## 14. R2 — Don't change existing test assertions silently
Never change an existing test assertion unless the PR cites a spec change. Put a `Spec-Change:` line in the PR body pointing to a hub spec path or commit, e.g.:
- `Spec-Change: 10-product/<pkg>/stories.md`
- `Spec-Change: <git sha>`

Newly added tests are always allowed. Enforced by `scripts/check-pr-rules.mjs`.

## 15. R3 — Green gates on every PR
`npm run typecheck` (`tsc --noEmit`) and `npm run test:unit` must pass on every PR. These two gates — and only these two — are what `scripts/check-pr-rules.mjs` enforces for R3; the script does no schema/SQL inspection and never runs `test:rls`.

When a change touches schema, RLS, or SQL, `npm run test:rls` is also required. That conditional gate is real, but it is enforced by hosted CI / gate scripts, not by `check-pr-rules.mjs`. So: `check-pr-rules.mjs` green means typecheck + unit are green — it is not a substitute for running `test:rls` on schema/RLS/SQL changes.

# Codex autonomous build pack

Authority: Ron’s 2026-10-29 16:15 PT instruction via CEO.

Build the complete queue. LINE includes `/t`, `/v`, and `/o` together, using the free 輕用量 OA plan specified in the approved setup: 200 messages/month, with a shared 180-push guard and Email fallback. Webhook conversational responses use Reply API only.

The queue determines whether 2026-11-09 is achievable. Do not remove scope to manufacture that date. Build completion, staging acceptance, production release, and production activation are separate states.

## Start here

1. Read the existing operating contract at `/workspace/ops/handoff/AGENTS.md`.
2. Read this pack’s `AGENTS.md`, `BUILD-ORDER.md`, and `QA-STANDARD.md`.
3. Select an eligible item and follow its `specs/B-NNN.md`.
4. Record evidence, blockers, and status; continue with the next eligible item.

This pack supplements the operating contract. Preserve Origin ownership, `ops-lock`, modes A/B, independent QA, and handoff requirements. It grants no production authority.

**The Mac gets no production keys. No emergency exception applies to this pack.**

## Sources

Canonical source root: `/workspace/condola-hub/`.

- `INDEX.md`
- `04-journeys/{journeys,user-stories}.md`
- `05-capabilities/{capability-list-v1,current-state,p0-build-queue,qa-flag-gates,line-access-plan,ron-line-setup,line-tenant-slice-design}.md`
- `11-decisions/{DECISIONS,banned-words-slim-proposal}.md`
- `07-brand/brand-v2/`, particularly `brand-guide.md`, `tokens.json`, `tokens.css`, responsive states, templates, and portal mockups
- `brand-v2/impl-plan.md`
- `/workspace/ops/{RULES,PRINCIPLES,ROADMAP,TRAIN,deploy-checklist,GATE-B}.md`
- `/workspace/e2e/preflight-deploy.sh`

Inspected code reference: `/workspace/condola-t02-audit`, `next-batch-1029 @1d97c35`. This is a discovery baseline, not an instruction to reset Origin to that commit.

## Source reconciliation

Current-state is a historical inventory, not proof of today’s deployment. The P0 build log contains later implementation/release evidence. Verify the current branch and latest verdict before implementing; reuse existing work.

Ron’s latest instruction supersedes the tenant-only LINE recommendation, earlier capacity-cut proposals, and any Mac production-token exception. It does not authorize legal-copy changes.

A source showing “partial” does not automatically require recreating intentionally removed behavior. B-002 and B-032 document the retention-setting and legacy-demo cases.

## Shared specification contract

Every specification inherits:

- Its traceability, dependencies, flag, class, and estimate from `BUILD-ORDER.md`.
- Every requirement in `QA-STANDARD.md`.
- Additive-only schema changes; inspect existing migrations before proposing another.
- Proposed migration names use `<unique_timestamp>_bNNN_<purpose>.sql` under `supabase/migrations/`. Allocate a real unused timestamp at implementation; never edit an applied migration.
- New writes retain organization, timestamp, source identifier, and relevant count/bytes; distinguish sandbox data.
- UI/copy uses approved hub sources and repository `src/i18n/`. Never invent or edit privacy, terms, consent, or ID-notice text.
- All external Email/LINE calls are mocked or captured in a local sink. Codex sends no external messages.
- Evidence root: `/workspace/e2e/results/B-NNN/`; on Mac use repository `e2e-evidence/B-NNN/`.
- Required evidence files: `status.md`, `verdict.md`, command results, acceptance results, and screenshots at 390/1280 where UI exists. Class B also requires `classb-draft.md`.
- No production DB access, production deployment, production flag changes, or secret values.

## Pack maintenance

Keep queue IDs stable. Add discovered work to the existing item where it shares reserved files; otherwise add an item without deleting scope. Record source disagreements and unresolved product choices in `BLOCKED.md`.

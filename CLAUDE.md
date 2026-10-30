<!-- DRAFT (2026-10-27 PT). Not committed. Target path: repo root CLAUDE.md -->
@AGENTS.md

## Claude desktop notes
- Open the repository in the Claude desktop app Code tab, Local environment.
- AGENTS.md is the operating policy; role sources are `ops/roles/*.md`.
- Run `scripts/install-prompts.sh --check`; adapters are generated, never independent policy.
- Invoke `/condola-pe`, `/condola-qa`, `/condola-ceo`, `/condola-rd`, `/condola-start` or `/condola-handoff`.
- If desktop slash autocomplete is limited, type "follow .claude/skills/qa/SKILL.md", substituting the role.
- Mode B: independently review Codex desktop implementation and provide zh copy; never review your own implementation conversation.
- Class A still requires a fresh independent Codex verdict.
- Run scripts in macOS Terminal or the app's terminal tool; model CLIs are not required.
- Follow AGENTS.md wording rules and the temporary 房客 guard restriction; run `npm run copy:check`.
- Use staging secrets only through `scripts/secrets-run.sh staging -- <cmd>`; never print values.
- Record app/model and session start/end through `scripts/session-log.sh`; include required commit trailers.

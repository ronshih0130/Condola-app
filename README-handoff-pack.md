# handoff-pack
Extract at the condola-app repo root:  tar xzf handoff-pack.tgz -C <repo-root>
- AGENTS.md, CLAUDE.md, DESIGN.md, HANDOFF.template.md, INVENTORY.md, ron-mac-steps.md -> repo root
- docs/ (canonical handoff docs, DECISIONS, PRD), docs/policy/ (RULES, PRINCIPLES, ROADMAP, deploy-checklist, GATE-B)
- scripts/ (claim.sh, secrets-run.sh, gate.sh, mac-setup.sh, ...), ops/, templates/, checklists/
No secret values included. Staging secrets come separately as staging.env.age.

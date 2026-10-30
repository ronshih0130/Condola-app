# Documentation map
Cadence column follows Ron's 10-doc proposal (2026-10-27); owners are a CEO proposal.
Read order for agents: `AGENTS.md` → `HANDOFF.md` → PRD of the lane.
PRDs are per feature: `docs/prd/<feature>.md`; no single monolithic PRD.
“New skeleton” means drafted documentation; it does not establish implementation status.
Existing ops/design sources remain authoritative until their migration is completed.

| Ron's doc | Repo path | Status | Source | Update cadence | Who updates |
| --- | --- | --- | --- | --- | --- |
| Product | `docs/PRODUCT.md` | new skeleton | MVP scope; live_features; ROADMAP | when product direction changes | CEO (Ron approves) (proposed) |
| PRD | `docs/prd/README.md`, `<feature>.md`, `_TEMPLATE.md` | new skeleton | `pm-saas/design/` specs | per feature (before build; AC updated at ship) | R&D (proposed) |
| Design system | `docs/DESIGN_SYSTEM.md` | new skeleton | brand-v2 tokens and decisions; prod tokens | when design changes | R&D (design) (proposed) |
| Architecture | `docs/ARCHITECTURE.md` | new skeleton | repo facts at `5d8b002` | when architecture changes | PE (proposed) |
| Agent instructions | `AGENTS.md` | exists (draft per Q9) | `decisions.md` Q4/Q9 | when process changes | CEO (Ron approves) (proposed) |
| Engineering standards | `docs/ENGINEERING_STANDARDS.md` | new skeleton | RULES; PRINCIPLES; CI | ongoing | PE (proposed) |
| QA plan | `docs/QA_PLAN.md` | new skeleton | RULES; deploy checklist; e2e tree | per feature | QA (proposed) |
| Roadmap | `ops/ROADMAP.md` | pointer | `/workspace/ops/ROADMAP.md` | weekly (ROADMAP is planned in weeks) | CEO / Ron (proposed) |
| Decisions | `docs/DECISIONS.md` | new skeleton | PRINCIPLES; app decisions; Q1–Q9 | every significant decision | CEO (proposed) |
| Handoff | `HANDOFF.md` | pointer | `HANDOFF.template.md` per Q9 | every handoff (departure and acceptance) | departing executor; receiver records acceptance (proposed) |

TODO(owner): reconcile Q9's handoff template with `HANDOFFS.md` in the production tree.
TODO(owner): confirm destination files and migrate sources without losing history.
Dates and operational times in these docs use PT.

Sources: `decisions.md` Q1/Q4/Q9; `tree.txt`; `/workspace/ops/ROADMAP.md`.

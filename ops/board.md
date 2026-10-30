# Mode B bootstrap board

Updated: 2026-10-29T17:13:29.182087-07:00. Coordinator: Ron / Codex app. Ownership session: `3099AC86-6AF0-4681-9944-304E930BFDC2`.

| Lane | State | Files | Next |
|---|---|---|---|
| bootstrap | verifying | HANDOFF.md; ops policy pointers/toolchain/board; generated adapters | publish sanitized startup evidence |
| B-001–B-004 | pending source recovery | no implementation reservation | recover hub-cited lane commits/migrations before reconstruction |
| B-005 | in_progress, Class B | src/server/domain.ts (markTryout only); src/server/tryout.integration.test.ts; e2e-evidence/B-005/ | initialize persistent trial progress for organizations with empty settings; mock/local checks; invitation lane reconciliation remains pending |

Other scopes remain in 20-build/BUILD-ORDER.md; no items are complete. Ownership is bootstrap per Ron's direct instruction, not an inferred Mode A release. No production scope.

B-006 in_progress, Class A: reserve src/server/owner-import.ts, import-feature.ts, import.test.ts, src/components/import-wizard.tsx, src/app/m/import/page.tsx, src/i18n/en.json and zh-TW.json. Default-OFF diagnostic improvement; source line/field preservation and error union; regional handling remains incomplete. Shared files are integrated in the single mode-b-bootstrap lane, no stacked overlapping PRs.

## Recovered-source train update 2026-10-29T18:03:33.428084-07:00

Active integration branch: mode-b-build (source bridge53391dd, trial replay4a61269, diagnostics replay8cbb9e5). Original mode-b-bootstrap79c3353 remains preserved and clean; main unchanged. All7 recovered lane refs preserved on Origin.

B-001 Class B in_progress: reserve new20261031100201 internal-helper migration, targeted esign privilege integration test, existing esign integration summary caller, shared migration inventory and package registration. Security changes align DB RLS with existing admin/manager and exact-version signer access, no table/column/data removal; old service signatures retained. Classified truthfully non-add-only privilege/policy change, not a blanket schema-policy waiver.

Packaging prerequisite: reserve write-pr-migrations.mjs, migration-classification.mjs and manifest regression test. Truthful classification of recovered historical files and deletion-aware guard; no historical SQL edited.

Staging API401, missing historical b888ccd fixture and remaining acceptance evidence are scoped blockers, not done states. No deployments, scheduler activation, production reads or external messages.

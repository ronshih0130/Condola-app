# Mode B bootstrap board

Updated: 2026-10-29T17:13:29.182087-07:00. Coordinator: Ron / Codex app. Ownership session: `3099AC86-6AF0-4681-9944-304E930BFDC2`.

| Lane | State | Files | Next |
|---|---|---|---|
| bootstrap | verifying | HANDOFF.md; ops policy pointers/toolchain/board; generated adapters | publish sanitized startup evidence |
| B-001–B-004 | pending source recovery | no implementation reservation | recover hub-cited lane commits/migrations before reconstruction |
| B-005 | in_progress, Class B | src/server/domain.ts (markTryout only); src/server/tryout.integration.test.ts; e2e-evidence/B-005/ | initialize persistent trial progress for organizations with empty settings; mock/local checks; invitation lane reconciliation remains pending |

Other scopes remain in 20-build/BUILD-ORDER.md; no items are complete. Ownership is bootstrap per Ron's direct instruction, not an inferred Mode A release. No production scope.

B-006 in_progress, Class A: reserve src/server/owner-import.ts, import-feature.ts, import.test.ts, src/components/import-wizard.tsx, src/app/m/import/page.tsx, src/i18n/en.json and zh-TW.json. Default-OFF diagnostic improvement; source line/field preservation and error union; regional handling remains incomplete. Shared files are integrated in the single mode-b-bootstrap lane, no stacked overlapping PRs.

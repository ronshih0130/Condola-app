# ADR-114 — Four-party shell (B-061 / WB-1) vs existing nav (B-043): chrome only

| | |
|---|---|
| Status | **PROPOSED (Phase 0 draft, needs Ron/CEO review)** |
| Date | 2026-11-13 PT |
| App SHA | `1e0a8ab` (GitHub `main`) |
| Requirement | hub `20-build/MAC-CLAUDE-HANDOFF-1112.md` §2.4, §3(b) |
| Sources | hub `10-product/workbench-four-party-1112/handoff.md` (PLT-44, approved mockup `d62a681`, desktop **B**); hub `10-product/b042-b043-1111/handoff.md` (B-043, 7 areas, mockup `f9ecf4e`) |
| Related | `docs/phase0/architecture-map.md` §2, §8, G12 |

Docs only. No component, route, permission or flag is changed.

**Before building:** read hub `INDEX.md` § "Do NOT build" (hub repo `condola-hub`, `INDEX.md#do-not-build`). It includes the rejected workbench desktop shell A. The table is linked, not copied.

## Context

**What was approved.**

- **B-043** (Ron 2026-11-11): 管理方 app nav is **7 areas** — 今天 → 訊息 → 物件與租客 → 租約 → 收款 → 維修 → 設定; phone has 5 tabs (D2=A: 今天／訊息／物件與租客／租約／更多); accountant and maintenance have no 訊息; maintenance sees 維修 + 設定 only and lands on 維修 (MGT-47, MGT-48-AC5). Flag key in BUILD-ORDER is still `nav_six_areas*` "until PE／CEO rename it".
- **B-061 / WB-1, PLT-44 AC1…AC15** (Ron 2026-11-12): one shared shell for all four parties — phone 390: navy top bar (brand + party label, context copy, bell + avatar; page title below); desktop 1280: **variant B only** — navy sidebar with brand + context on top, nav areas below, light page-title row with bell + avatar. Management header copy = company｜name（role） with a company switcher only when the user has more than one company. Bottom tabs per party "as already drawn".
- The workbench handoff states the boundary: WB-1 "Depends: approved **B-043** nav items and permissions (do not reopen the tab set). This is chrome only." Approved 今天 / B-043 nav items / notification page / daily-ops / money-flow "change **only the shell**, not their content".
- Queue order: … B-042d (D0) → **B-043** → **B-061 (WB-1)** → B-057 … (handoff §3b).

**What the code has today (`1e0a8ab`).**

| Fact | Evidence |
|---|---|
| Management nav and permissions live in **one module**: `MANAGER_NAV` (sections/links, each with a `perm`), `visibleNav(role)`, `permForPath(pathname)`, `assertPerm`, `roleHome` | `src/server/perms.ts:62-196` |
| Nav is still the pre-B-043 sidebar ("Admin sees 19" links in sections) | `perms.ts:61-102` |
| Layouts exist per app for `/m`, `/o`, `/t`; **no `/v` layout** (vendor pages are token pages) | `src/app/m/layout.tsx`, `src/app/o/layout.tsx`, `src/app/t/layout.tsx` |
| Shared chrome and owner nav components exist | `src/components/chrome.tsx`, `src/components/owner-nav.tsx` |
| Org selection uses cookies `condola_env` / `condola_org`; only `active` members resolve an org | `src/server/org-scope.ts:108` |
| `middleware.ts` does no auth; authorization is in server modules | architecture-map §2 |
| None of `nav_six_areas*`, `four_party_shell*` is in `ops/flags.yaml` | grep at `1e0a8ab` |

**Risk.** Because the nav list and the permission map are the same data structure, a "visual" rewrite of the sidebar can silently change which roles see which links, or tempt a rewrite of `permForPath`. The company switcher in the header also looks like chrome but changes the active org — a security-relevant action.

## Decision drivers

1. Do not reopen approved nav items or permissions (B-043, MGT-47/48) — Ron's approval covers chrome only.
2. Server-side authorization must be identical before and after the shell (403s unchanged).
3. One shell implementation for four apps; party-specific tab sets are data.
4. Flag OFF = current layouts unchanged.
5. B-043 lands first in the queue; B-061 must not fork or duplicate its nav data.

## Options

**Option A — Shell and nav as one change.** Build the new chrome and the 7-area nav together in one component tree per app.
Consequence: fewer PRs; but couples a Ron-approved content change (B-043) with a chrome change (B-061), makes QA unable to say which caused a permission regression, and breaks "one unshipped PR per file" ordering between the two items.

**Option B — Shell as a pure presentation layer that receives nav as data (recommended).**
The shell renders: brand + party label, context copy, bell, avatar, page-title slot, a sidebar (desktop B) and bottom tabs (phone). It takes an already-filtered list of nav items from the party's own source — for `/m` the output of the existing role filter (`visibleNav` or its B-043 successor), unchanged. The shell imports **no** permission function and makes **no** authorization decision. The company switcher is a separate small control that calls the **existing** org-selection path; no new membership rule.
Consequence: B-043 owns nav content; B-061 owns chrome; either can ship or roll back alone. Requires B-043 to expose its filtered nav as data (a constraint on B-043's design note).

**Option C — Per-app shells that share only CSS tokens.** Each app keeps its own layout component and adopts the navy bar/sidebar styles.
Consequence: least refactoring; but four implementations drift, and PLT-44's "one shared shell" intent is met only visually.

## Recommended option

**Option B**, with these guardrails for the design notes of B-043 and B-061:

1. `permForPath`, `PERMS`, `assertPerm`, `roleHome` are **out of scope** for B-061. Any diff to `src/server/perms.ts` in a B-061 PR beyond what B-043 already merged is a review blocker.
2. Nav visibility stays computed on the server from the role; the shell never hides an item by itself and never shows one the filter removed.
3. A snapshot test per role (admin, manager, accountant, maintenance; plus owner, tenant, vendor) pins **the set of hrefs and their order** before and after the shell — equal by construction.
4. Direct-URL authorization tests (403 / no-permission page) are re-run unchanged.
5. Company switcher: shown only with > 1 active membership; switching re-resolves through the existing server path; sandbox/live rules unchanged.
6. Vendor: the shell must not make `/v/[token]` look logged-in or expose a history list (token grants one job only — workbench handoff Q4; VEN-14/15 remain release-blocked on V-12/V-13).
7. Desktop is **B only**. Variant A is not built, not kept behind a flag, not offered as a setting (see the "Do NOT build" link above).
8. 0 outbound; flags default OFF.

## Consequences

- B-043's design note gains one requirement: expose role-filtered nav as plain data usable by any chrome.
- Two flags may exist in sequence (`nav_six_areas*` for content, a shell flag for chrome) → four combinations to test; the design note must say which combinations are supported (Q2).
- Already approved screens (今天, daily-ops, money-flow) get the new header/sidebar when their slices are built — no content or AC change.
- `/v` has no layout today; giving vendor token pages the shared top bar is new structure and must be shown not to change token handling.
- Tablet 768 is deferred; the layout must still not break.

## What this ADR does NOT decide

| # | Open question | Owner |
|---|---|---|
| Q1 | Does the shell ship behind its own flag (`four_party_shell*`, name OPEN) or inside each later slice's flag? (handoff: "PE chooses") | CEO, in the B-061 design note |
| Q2 | Supported combinations of nav flag × shell flag; is new-shell + old-19-link nav ever shown? | CEO |
| Q3 | Rename of `nav_six_areas*` now that nav has 7 areas | CEO / PE (ADR-113 Q6) |
| Q4 | Company switcher: does switching keep the current path or go to the role home? Behaviour for a member `suspended` in the target org; interaction with sandbox/live choice | Ron via CEO if not fixed by PLT-44 ACs / mockup `d62a681` |
| Q5 | Interaction with ADR-111: a manager paused after trial expiry — what does the shell/switcher show for that company? | Ron, via CEO |
| Q6 | Vendor token pages: which shell elements appear before login (bell, avatar, tabs)? Confirm against PLT-44 ACs | CEO (stop for Ron on any visual delta, P52) |
| Q7 | Whether any nav item, tab, or permission should change | **Not open** — closed by B-043 approval; a change needs a new Ron decision |

## Implementation sketch

| PR | Content | Gate |
|---|---|---|
| PR-0 | B-043 design note includes "nav as data" requirement; B-061 design note cites this ADR | CEO review (P37) |
| PR-1 (B-043) | 7-area nav content + phone tabs, behind its flag; role href-set snapshot tests added here | hosted CI green + non-author QA; CEO exact-SHA GO |
| PR-2 (B-061) | Shared shell component + adoption in `/m`, `/o`, `/t` layouts, flag OFF; no `perms.ts` diff | same; QA checks guardrails 1–4 |
| PR-3 (B-061) | Company switcher control | same; permission/cross-org cases explicit |
| PR-4 (B-061) | Vendor pages adopt the shell (new `/v` layout) | same; token-scope tests |

No schema or RLS change is expected. If the switcher or shell needs stored state (e.g. last-used company), that becomes a separate schema PR: **non-author QA + CEO exact-SHA GO before any staging apply**.

## Verification

Per GLOSSARY "Verify" — real interface, real input, on staging with synthetic users:

1. For each of the four staff roles, log in at 390 px and 1280 px with the shell flag OFF then ON: the list of nav destinations is identical; only the chrome differs (screenshots side by side; desktop matches variant B).
2. As accountant and maintenance, request an admin-only `/m` URL directly: same 403 / no-permission result with the flag OFF and ON.
3. A user with two companies switches company in the header: the page shows the other company's data and the previous company's records are not reachable by URL; a single-company user sees no switcher.
4. Open a vendor token link logged out: one job only, no history list, no workbench tabs.
5. Owner and tenant apps show the navy top bar with their own tab sets; zero page errors, zero horizontal overflow at 390 px.
6. Capture sink shows zero sends for the whole run.

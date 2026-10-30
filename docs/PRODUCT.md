# Product
Condola（租多啦）is rental-management software for self-managing 屋主 and management firms.
It organizes leases, 繳租回報, bank matching, repairs, and 屋主 statements into clear records.
It provides software; it does not manage properties on a user's behalf or handle their money.

## Users and four apps
| App | Users | Purpose |
| --- | --- | --- |
| 管理方 `/m` | Admin, Manager, Accountant, Maintenance | Portfolio, leases, records, operations |
| 屋主 `/o` | Owners | Statements and property visibility within permissions |
| 租客 `/t` | Tenants | Lease access, 繳租回報, repair requests |
| Vendor `/v/[token]` | Repair vendors | Case-specific mobile workflow |

Four complete apps and design-partner readiness are P1 priorities.
Earlier MVP scope excluded a Vendor app; the later roadmap and app decisions expand that scope.

## Core scenarios
- Add a property, unit or room; establish a lease and its tenant relationship.
- Record a tenant's payment report; let 管理方 confirm or reject it and approve bank CSV matches.
- Allocate shared utility readings and review the resulting records.
- Prepare a monthly 屋主 statement and inspect its underlying details.
- Let 租客 report a repair; track the work through 管理方 and Vendor workflows.
- Upload a signed lease; optional in-house online signing is a separate delivery lane.

## Live-feature evidence
The inventory below is dated **2026-10-21 PT**, from Origin tree `2ba84e3`, not production `5d8b002`.
| Inventory-confirmed capability | Evidence |
| --- | --- |
| Properties, units and rooms | `/m/properties`, `/m/units` |
| Tenant list and tenant portal | `/m/tenants`, `/t` |
| Lease wizard, details and signed PDF | `/m/leases` |
| Rent records and payment confirmation/rejection | `/m/rent`, `/m/payments`, `/t/pay` |
| Bank CSV import and approved matching | `/m/bank` |
| 屋主 monthly statements and month close | `/m/statements`, `/o/statements`, `/m/close` |
| Shared-meter electricity allocation | `actionSetMeter`, allocation runs/lines |
| Team accounts and permissions | `/m/team`, `/m/roles`, `server/perms.ts` |
| Organization environment modes | `/m/env`, `server/org-scope.ts` |

That inventory reported partial repairs and missing expense/report/audit UIs, existing-tenant selection and live reminders.
The production tree contains later related routes and tests; route presence alone does not prove exposure or acceptance.
TODO(owner): refresh the inventory against production and flag/ring verdicts.

## Boundaries and direction
No tenant-screening service, listings/applications, tax filing, insurance, or full trust accounting in MVP scope.
Do not promise tenant identity verification, outcomes, or tax treatment.
Native store apps were outside MVP; P3 may revisit them.
Follow [P1–P4](../ops/ROADMAP.md): four apps → usage-based pricing and UX → global expansion → user AI experience.
Prepare usage hooks for P2 and configurable locales, timezones and currencies for P3.
TODO(owner): reconcile the older three-calendar-month trial with the future P2 pricing model.

Sources: `MVP_Scope_v0.5.md`; `/workspace/pm-saas/live_features.md`; `tree.txt`; `app_decisions.md`; `ROADMAP.md`; `decisions.md` Q8.

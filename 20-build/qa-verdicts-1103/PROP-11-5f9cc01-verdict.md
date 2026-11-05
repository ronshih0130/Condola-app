# PROP-11 — r1 5f9cc01 — VERDICT: PASS-with-conditions

Bound to **f1a0f6e...5f9cc01**, PR #22, base B-007 `f1a0f6e`. **No 阻塞 findings for this BUILD-ONLY SHA.** Conditions below must be closed before activating consumers.

File shorthand: **M** = `supabase/migrations/20261105160000_prop11_repair_cost_foundation.sql`.

| # | finding | file:line | 阻塞/低優先 |
|---|---|---|---|
| 1 | Composite FKs enforce org agreement, **not ticket agreement**. An allocation can reference ticket A and an item on ticket B within one org. Items, documents and statement links can similarly select unrelated same-org vendor jobs; documents can select an item from another ticket. | M:25–27, M:60–62, M:87–91, M:110–113 | 低優先 |
| 2 | `owner_statement_line_id` is soft: existence, org and reconciliation-source agreement are unenforced. Acceptable while inert; the comment establishes a future consumer obligation, not enforcement. | M:94–103 | 低優先 |
| 3 | Due-component uniqueness permits duplicate logical rows when `source_ref_id IS NULL`, because ordinary PostgreSQL UNIQUE treats NULLs as distinct. Different source IDs also permit multiple rows for the same period/component; aggregation semantics remain undefined. | M:146–151 | 低優先 |
| 4 | Currency accepts arbitrary text. Nonnegative bigint amounts prevent negative/floating storage but impose no business ceiling, currency consistency, source cap or aggregate/double-counting rules. | M:18–19, M:141–145 | 低優先 |
| 5 | Authorized UPDATEs can change confirmed/void costs and overwrite allocations without audit, revision history or transition guards. Correction CHECK only requires a non-NULL reason when `corrected_at` is supplied; callers can omit both or supply an empty reason. Prior shares are unchecked. | M:41–46, M:59, M:180–188 | 低優先 |
| 6 | Evidence XOR validates source presence only. Attachment ownership, storage scope, actual MIME/hash and truthful photo classification are unenforced; metadata may be NULL. | M:65–79, M:83–86 | 低優先 |
| 7 | `service_role` access is trusted and not tenant-isolated by these policies. Visibility rows do not enforce viewer identity, vendor ownership or accountant photo exclusion. | M:116–134, M:154–188 | 低優先 |
| 8 | Behavioral database coverage remains incomplete: schema tests inspect SQL text; QA did not rerun staging or meet the local PG17 RLS test requirement. CI cancellation supplies no successful CI evidence. | `src/server/repair-cost.schema.test.ts:30`, `src/server/repair-cost.gateway.test.ts:9` | 低優先 |

## Writer-activation conditions for B-013/B-021

Every condition is **低優先 at this SHA; 阻塞 for activation of the affected writers/readers**.

| # | condition | file:line |
|---|---|---|
| 1 | Enforce item/allocation/document/job ticket agreement, using stronger composite constraints or transactional validation with appropriate concurrency protection. Include same-org wrong-ticket adversarial tests. | M:25–27, M:60–62, M:87–91, M:110–113 |
| 2 | Resolve statement lines by scoped org and validate reconciliation ownership/source; handle concurrent target changes/deletion safely. Resolve due-component soft sources by kind, org and lease, preventing analogous cross-lease/cross-settlement contamination. | M:94–103, M:136–151 |
| 3 | Define NULL-source idempotency and component aggregation; enforce duplicate prevention atomically. Any future payment request needs its own idempotency key—link-pair uniqueness is not payment idempotency. | M:109, M:150 |
| 4 | Validate supported currency, currency agreement, amount ceilings, applicable source/aggregate caps and deterministic split rounding. The existing 10,000-bp split CHECK already enforces share totals. | M:18–19, M:36–38, M:52–58, M:141–145 |
| 5 | Enforce audited state transitions, immutable finalized history, correction attribution/prior values and meaningful reasons; protect concurrent updates. Sanitize money/PII audit payloads. | M:41–59, M:180–188 |
| 6 | Verify attachment/storage authorization, actual content metadata and photo classification; enforce party-specific visibility and accountant photo exclusion before reads. | M:65–91, M:116–134 |
| 7 | Require scoped authorization on every service-role operation and complete database privilege, isolation and regression tests before activation. | M:154–188; `src/server/repair-cost.ts:7–9` |

**Focus answers:** Migration is additive: six new private tables, no DROP, destructive ALTER, existing-table modification, enum creation/alteration or flag seed. It reuses `public.cost_bearer` and existing matching unique keys. All six tables enable RLS; PUBLIC/anon/authenticated privileges are revoked; service_role receives SELECT/INSERT and only the listed column UPDATEs, with **no DELETE grant**.

Amounts use nonnegative bigint. Cross-org declared FKs are sound; cross-ticket and soft-source integrity remain consumer conditions. The soft statement-line reference is acceptable for the inert foundation and does not make a safe future writer impossible.

The gateway calls `requireOrgScope` before returning `{enabled:false}`; the supplied diff adds no production caller, public route or writer. QA’s reported 9/9 targeted, 732/732 unit and clean TypeScript results support this verdict. Staging 51/51 remains **PE evidence, not a QA rerun**.

SHA reviewed: 5f9cc01 (PR #22 head at review). QA no-DB: repair-cost targeted 9/9; unit 732/732 PASS; tsc 0 errors. Raw: llm-route/PROP-11-5f9cc01-review-r1.md

# PROP-08 — r1 9b29a46 — VERDICT: PASS-with-conditions

Independent review of the supplied `5f9cc01...9b29a46` diff. **No 阻塞 findings for this BUILD-ONLY SHA.** Resolver activation remains conditional on the items below.

| # | finding | file:line | 阻塞/低優先 |
|---|---|---|---|
| 1 | Locale/timezone validation checks only truthiness. Invalid nonempty values, including whitespace or an unsupported timezone, are returned successfully. Existing locale constraints do not establish runtime locale support; timezone has no supplied validation constraint. Validate selected values and reject invalid values without silently falling back. | `src/server/localization.ts:67–72` | 低優先 |
| 2 | Cycles terminate through path deduplication, but malformed ancestry is silently truncated. A rule from that partial chain can still be returned; the resolver does not reject cyclic jurisdiction data. | `src/server/localization.ts:105–121` | 低優先 |
| 3 | Ancestry traversal has no explicit depth limit. The visited path prevents infinite cycles, but a sufficiently deep acyclic hierarchy still incurs unbounded traversal relative to an application limit. Define a maximum and fail closed when exceeded. | `src/server/localization.ts:105–112` | 低優先 |
| 4 | Unit tests inspect SQL text rather than execute jurisdiction precedence, effective dates, cycles, or cross-org isolation against PostgreSQL. PG17 integration/RLS evidence remains deferred; reported staging 55/55 was not independently rerun, and CI remains pending. | `src/server/localization.resolver.test.ts:165–182` | 低優先 |

These are activation risks and verification gaps, rather than introduced live money, permission, leak, or data-loss failures: the supplied QA search found no production consumers.

### Activation conditions for B-032

All conditions below are **低優先 now** and must be satisfied before activation.

| # | condition | file:line |
|---|---|---|
| 1 | Derive `orgId` exclusively from an authorized session after `requireOrgScope`; never forward a request-supplied org. The resolver checks only nonempty strings and cannot authenticate ownership. Preserve property/org binding. | `src/server/localization.ts:30–43,58`; `src/server/regional-format.ts:8` |
| 2 | Match each amount’s currency to the resolved currency; reject mismatches. Convert stored amounts using `minorUnit`, then format using `displayDecimals`. Do not infer FX conversion. | `src/server/localization.ts:7–11,80–85` |
| 3 | Validate locale/timezone, reject malformed selected values, and preserve errors through consumers. Missing jurisdiction is intentionally nullable; rule-dependent operations must explicitly handle `null`/unknown jurisdictions and absent rules without granting permission. | `src/server/localization.ts:67–85,124` |
| 4 | Resolve cycle/depth handling and prove org isolation, ancestor/org precedence, and half-open effective windows using PG17 integration tests; obtain passing CI and required staging evidence. | `src/server/localization.ts:105–124`; `src/server/localization.resolver.test.ts:165–182` |
| 5 | Implement activation and consumer rewiring as separately reviewed B-032 work, retaining session authorization and applicable PII masking/export controls. | `src/server/regional-format.ts:4–10` |

**Focus answers**

- **Money scale:** Correctly separated, independently selected from `currencies`, and explicitly documented. Tests lock `280000 / 10² = 2800`, displayed as `NT$2,800`, and demonstrate the erroneous 100× alternative.
- **Global defaults:** Neither new production module hardcodes Taiwan, TWD, zh-TW, or Asia/Taipei. Supplied schema defaults are pre-existing context.
- **Fail closed:** Missing currency/locale/timezone and absent currency rows throw. Currency reference integrity benefits from existing FK/check constraints. Invalid nonempty locale/timezone values remain a gap. No jurisdiction legitimately returns `null`; unknown rule jurisdiction returns no rule.
- **Rules:** Queries bind org/key/date and exclude other-org overrides. Org override precedes platform default, then nearest ancestor, then latest effective start; windows are `[from,to)`. Cycle termination exists; cycle rejection and depth limits do not.
- **Gateway/scope:** `requireOrgScope` runs before the exact `{enabled:false}` response. No context or PII is returned.
- **Change boundary/evidence:** Supplied diff adds no public route, flag, migration, writes, or consumer rewiring. QA-reported results: targeted **14/14**, unit **746/746**, TypeScript **0 errors**. This review did not rerun tests, staging, or CI.

SHA reviewed: 9b29a46 (PR #23 head at review). QA no-DB: targeted 14/14; unit 746/746 PASS; tsc 0 errors. Raw: llm-route/PROP-08-9b29a46-review-r1.md

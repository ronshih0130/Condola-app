# B-031 slice 2 — AUDIT_DETAIL local evidence

**LOCAL PASS · flag `audit_detail` default OFF · committed as `ff674a5` on `feat/b-031-audit-detail` (base `1bba9f3`); fix round 1 (independent review) uncommitted on top.**
Design: [`20-build/specs/B-031-design.md`](../../20-build/specs/B-031-design.md) § Slice 2.

## Acceptance

> Given important mutation, when audited, then permitted actor/time/reason/before/after fields are available.

| Check | Evidence |
|---|---|
| Permitted actor/time/reason/before/after | `b031-audit-detail.integration.test.ts` #1: production `updateLease` (rent NT$30,000 → NT$33,000, deposit NT$60,000 → NT$66,000), reason-bearing end-date change, `updateOwner` (partial phone/email), `setMemberRole` (會計 → 經理); actor 林雅婷 and Taipei time on the same row; zh-TW and EN render |
| Privilege filtering (DB, API role) | #3: `app.b031_audit_detail_rows` through `tx()` as `authenticated` returns rows only to an active admin of the pinned org. Zero rows for manager, accountant, maintenance, tenant, owner, another org's admin, pin mismatch, cross-org ids and a suspended admin. `anon`/`service_role` EXECUTE and direct table SELECT/INSERT as `authenticated` fail with 42501 |
| Masking | #2: stored JSON, view model, rendered HTML contain no raw national ID, resident certificate number, token-like string, 16-digit account number, phone, email, legal name or LINE id; secret-shaped columns are withheld (count only). Unit `b031-audit-detail.test.ts` re-mask checks |
| Log scan | #2: console log/info/warn/error/debug captured during read + render; no secret present. The migration and reader emit no log lines |
| URL scan | #2: every rendered href is an existing record link (`/m/owners/<uuid>` etc.); no query parameters, audit ids or secrets |
| OFF zero-write / zero-read | #4: 10 flag shapes (default, global off, string booleans, org not allowlisted, allowlist missing/string, org flag absent/string/false, row absent) write no detail rows and read none, even with detail captured earlier while ON |
| OFF equality | #5: complete SQL trace of `loadAuditScreen` and two `loadAuditHistory` flows equals the 1bba9f3 baseline apart from exactly one reader statement; presented result (cursors excluded) and `AuditRows` markup are identical. Baseline `src/server/fixtures/b031-audit-detail-off.json` was captured by running the fixture against the unmodified 1bba9f3 `audit-read.ts` / `audit-log.tsx` |
| Review fix round 1 | #9–#12: write/read masking parity over all reviewer probes (bank/card groups, full-width phone/ID, spaced ID, landline, tokens) with reason codes kept; production write of M1 formats stored masked; fixed reason codes shown identically ON and OFF; forced capture failure and audit id conflict keep the business write. Unit #6–#9 |
| Reason semantics | #6: optional; blank/whitespace → none (rendered 未填寫原因); capped at 500; never fabricated |
| Scope | #7: inserts, deletes, NULL-org rows, non-covered tables and `recordAudit` events produce no detail. #8: append-only (UPDATE/DELETE rejected); exact BigInt amount display |

## Local runs (loopback PostgreSQL `condola_b031a`, fresh stub + all migrations + seed)

| Command | Result |
|---|---|
| `b031-audit-detail.integration.test.ts` | 12/12 |
| `audit-read.integration.test.ts` | 3/4 — #4 "keyset plans seek an index" fails identically with every slice-2 object dropped from the DB (pre-existing planner choice on this cluster, not caused by this slice) |
| `b005-invite-audit.integration.test.ts` | 3/3 |
| `tenant-signed-pdf-download-audit.integration.test.ts` | 1/1 |
| `b031-session-hardening`, `auth`, `lease-create`, `property-owner`, `record-archive`, `team-invite-allowlist`, `tenant-payment-history` | 94/94, 18/18, 4/4, 1/1, 6/6, 7/7, 9/9 |
| `test:unit` | 990/990 |
| `copy:check` | 6/6 |
| `test:fn-priv` | PASS (full gate; anon execute zero) |
| typecheck / lint | PASS / 0 errors (15 existing warnings) |

Not run: full `test:rls` (serialized by the architect), browser, staging, any remote DB or network. No git mutations.

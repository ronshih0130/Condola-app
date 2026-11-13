# ADR-112 — Post-INC-RLS-1112 default for new tables

| | |
|---|---|
| Status | **PROPOSED (Phase 0 draft, needs Ron/CEO review)** |
| Date | 2026-11-13 PT |
| App SHA | `1e0a8ab` (GitHub `main`) |
| Requirement | hub `20-build/MAC-CLAUDE-HANDOFF-1112.md` §2.1, §2.4, §5; hub `11-decisions/DECISIONS.md` (CEO rulings on INC-RLS-1112, 2026-11-12 08:25 PST) |
| Related | `docs/phase0/architecture-map.md` §4, §5, G1–G5; hub `20-build/BLOCKED.md` row FU-RLS-ADVISOR-CI |

Docs only. No migration, grant, policy or CI file is changed by this ADR. Schema statements are from migrations, not a live dump.

## Context

- **Incident.** Seven `public` tables created after the initial schema's "enable RLS on every table" loop had no RLS and carried Supabase's default grants to `anon` and `authenticated`. Stop-bleed migration: `supabase/migrations/20261112100000_advisor_rls_stop_bleed.sql` — `ENABLE RLS` (no policies, **not forced**) + `REVOKE ALL … FROM anon, authenticated`; two views set to `security_invoker = true`; unused signup tokens expired by `UPDATE` with one count-only audit row.
- **Root cause is structural.** The initial loop (`20261018120000_schema.sql:2030-2035`) only covers tables that existed then. Every later `CREATE TABLE` depends on the author remembering.
- **Three data-access paths with different RLS behaviour** (`src/server/db.ts`). The helper fixes only the **caller role** of its own statements; nested work can run with other authority:

  | Path | Caller role | RLS for the caller's own statements | Nested authority |
  |---|---|---|---|
  | `query()` / `withClient()` (`db.ts:146`, `:89`) | `DATABASE_URL` login role = table owner | not applied unless `FORCE` | `SECURITY DEFINER` functions run as their owner |
  | `tx()` (`db.ts:189`) | `authenticated` (initial) + jwt claims + pinned org/env | applied | usage recording switches to `service_role` inside a savepoint and restores it (`src/server/usage-events.ts:56-75`); definer functions run as their owner |
  | `svc()` / `svcOn()` (`db.ts:250-272`) | `service_role` | bypassed if the role has BYPASSRLS (hosted attribute unverified) | definer functions run as their owner |

  `SECURITY DEFINER` does **not** by itself bypass `FORCE ROW LEVEL SECURITY`: the result depends on the function owner's attributes (superuser / BYPASSRLS), whether it owns the table, and the policies that apply to it. Function owner = the role that applied the migration unless changed with `ALTER FUNCTION … OWNER TO`. Existing example: `public.pricing_apply_requests` is `FORCE`d with no policies and written through `SECURITY DEFINER` `app.submit_pricing_apply` (`20261112010000_b045_pricing_interim.sql:43-64`); that it works on hosted implies an owner attribute that was **not read** here. Details: `architecture-map.md` §4.

  Call sites (non-test): `query(` 110, `withClient(` 42, `tx(` 163, `svc(` 159.
- **Footprint.** 229 tables created (111 public + 118 app); 136 with explicit `ENABLE`; 27 `app` tables rely on `REVOKE` only (regex check — needs live verification); 22 + 5 tables `FORCE`d.
- **Local/CI role is a superuser** (`scripts/db-setup.sh:15`, CI `POSTGRES_USER`), which ignores RLS even when forced and owns every table and function. Owner-path behaviour against forced tables and the execution role of `SECURITY DEFINER` functions cannot be reproduced locally; a local `tx()` test is evidence only for statements issued directly as `authenticated`.
- **Hosted CI did not catch the incident.** Follow-up **FU-RLS-ADVISOR-CI** is OPEN and **owned by box PE** (PR) with CEO GO (hub `BLOCKED.md`): add Supabase Security Advisor to CI or a merge gate that RLS is on for every `public` table and views are `security_invoker`.
- **Standing rules (non-negotiable, handoff §5):** never restore exposed grants; never disable RLS; fix forward; tokens expired by `UPDATE` not `DELETE`; aggregates only, never row values.

## Decision drivers

1. A new table must be safe even if its author forgets — deny by default.
2. The intended access path must be written down, because `ENABLE` alone means different things on each path.
3. No duplicate CI work: FU-RLS-ADVISOR-CI already has an owner.
4. Must not break the owner-path code that works today (the seven tables are deliberately not forced).
5. Checkable from migration text in hosted CI without touching a hosted database.

## Options

**Option A — Written convention only.** Add the rule to docs and the PR checklist.
Consequence: free; identical in kind to what failed on 11/12. Not sufficient alone.

**Option B — Convention + migration header + static check in the repo (recommended).**
Every migration that creates a table must, in the same file:
1. `ALTER TABLE … ENABLE ROW LEVEL SECURITY`;
2. `REVOKE ALL ON TABLE … FROM anon, authenticated` (also `PUBLIC`; `service_role` kept or revoked explicitly);
3. state `FORCE` or `NO FORCE` with one line of reason;
4. carry an **access-path declaration** comment per table: one of `tx` (policies required, listed in the file), `svc` (no policies; server authorizes first), `owner` (`query`/`withClient`; no policies, not forced; server enforces org scope), or `definer-only` (reachable only via `SECURITY DEFINER` functions on the RPC allowlist);
5. for any table reached through a `SECURITY DEFINER` function, carry an **execution-role declaration**: which caller role invokes the function (`authenticated`, `service_role`, or the login role), which role **owns** the function, and what lets that owner through RLS (an attribute, or a named policy).
A static check over `supabase/migrations/*.sql` fails when a `CREATE TABLE` lacks 1–4 (and 5 where a definer function is declared). Views must set `security_invoker = true` or declare why not.
Consequence: catches the incident class at PR time with no database. Regex-level, so it must grandfather the 160 existing files by an explicit baseline list rather than rewriting them.

**Option C — Database-level default.** `ALTER DEFAULT PRIVILEGES` so new tables get no `anon`/`authenticated` grants, and/or an event trigger that enables RLS on `CREATE TABLE`.
Consequence: strongest, removes the root cause. But it is a change to shared database configuration on Supabase-managed roles; behaviour on the hosted platform is **unverified**, it does not apply to the local stub the same way, and it is box-PE-owned. A candidate follow-up, not a Mac action.

## Recommended option

**Option B now; Option C as a box-PE-owned proposal.**

Division of labour so nothing is duplicated:

| Check | Looks at | Owner |
|---|---|---|
| Migration-text check (this ADR): every new `CREATE TABLE` has ENABLE + REVOKE + FORCE decision + access-path declaration | repo files, runs in hosted CI and `gate.sh` | **Mac proposes; lands only if box PE agrees it does not overlap FU-RLS-ADVISOR-CI** |
| Catalog / advisor check: RLS on for every `public` table, grants, `security_invoker` | a real database after migrations (disposable in CI; advisor on hosted) | **box PE (FU-RLS-ADVISOR-CI)** — not built here |

If box PE prefers one combined check, this ADR's rules become its input and the Mac builds nothing.

Default by path (proposed):

| Declared path | Caller role | Function-owner role | Policies | FORCE | Direct table grants |
|---|---|---|---|---|---|
| `tx` | `authenticated` | n/a for direct statements; any definer function called from the transaction is declared separately | required, org + env scoped | optional | `authenticated` gets **exactly** the privileges the policies need, listed in the file; none to `anon` / `PUBLIC` |
| `svc` | `service_role` | n/a | none | optional | none to `anon`/`authenticated` |
| `owner` | login role (table owner) | n/a | none | **no** (forcing breaks the owner path) | none to `anon`/`authenticated` |
| `definer-only` | whichever role holds `EXECUTE` on the function — declared, on `supabase/rpc-allowlist.txt` | declared in the migration; hosted attributes **unverified** | none for `anon`/`authenticated`. A policy for the function owner is needed **if** the table is forced and the owner has neither superuser nor BYPASSRLS | **OPEN (Q8)** — see below | none to `anon`/`authenticated`/`PUBLIC` |

**Execution-role contract for `definer-only` (required before this row can be a default).** `FORCE` + "no policies" is safe only when the function owner bypasses RLS by attribute. If the hosted owner does not, the same migration denies the function its own table; if it does, `FORCE` adds nothing against that owner and only protects against a different table owner. The earlier draft's "`FORCE` = yes, policies = none" is therefore **withdrawn as a blanket default**. Until box PE reads the hosted owner attributes (Q7) and Q8 is decided, each `definer-only` table states its own caller role, owner role and FORCE reasoning, and is proven on staging (Verification 4).

New feature tables should prefer `tx` or `definer-only`; `owner` needs a stated reason, because isolation there rests only on hand-written `WHERE org_id`.

## Consequences

- Each new-table PR gets ~5 more lines and an explicit security statement reviewers can check (already required as evidence: `docs/phase0/test-infra.md` §8).
- The 27 REVOKE-only `app` tables and the existing owner-path tables are **not** changed by this ADR; they go on a baseline list with a live-catalog confirmation requested from box PE.
- The superuser test gap remains — it covers the owner path **and** definer-function execution roles: a non-superuser test role is a separate proposal (Q4).
- B-056's new table (ADR-111) is the first user of this default.

## What this ADR does NOT decide

| # | Open question | Owner |
|---|---|---|
| Q1 | Does the migration-text check ship as its own script, or fold into FU-RLS-ADVISOR-CI? | box PE proposes, CEO decides |
| Q2 | Adopt Option C (`ALTER DEFAULT PRIVILEGES` / event trigger) on staging and prod? | CEO, with box PE; hosted behaviour unverified |
| Q3 | Should the seven INC-RLS tables and the 27 REVOKE-only `app` tables later move off the owner path / gain explicit ENABLE? | CEO (separate schema ADR per change) |
| Q4 | Add a non-superuser, table-owner-equivalent role to local/CI so owner-path-vs-FORCE is testable? | CEO / box PE (touches CI contents) |
| Q5 | `tx()` with no scope falls back to cookie-resolved org (`db.ts:209-224`): restrict to seed/cron? | CEO — proposed NEW ADR "Data-access role policy" (architecture-map G5) |
| Q6 | Whether anyone affected by INC-RLS-1112 is notified (handoff R9) | Ron |
| Q7 | Live confirmation of role attributes (login role, `service_role`, table owners, **function owners**), grants and RLS state on staging/prod (aggregates only) | box PE |
| Q8 | `definer-only` default: which role should own the functions, and `FORCE` yes/no with or without an owner policy — depends on Q7 | CEO (security review), with box PE |

## Implementation sketch

| PR | Content | Gate |
|---|---|---|
| PR-1 (docs) | This ADR; migration header template added to a docs page | CEO review |
| PR-2 (CI/script) | Static migration-text check + baseline list of existing files; wired into `gate.sh`. Adding a hosted `ci.yml` step changes required-check contents | coordinate with box PE first; hosted CI green + non-author QA; CEO GO for the `ci.yml` step |
| PR-3+ (schema/RLS) | Any change to an existing table's RLS, FORCE or grants — one PR per change | **non-author QA + CEO exact-SHA GO before any staging apply**; box PE orders migrations |

No PR under this ADR restores a grant, disables RLS, deletes token rows, or prints row values.

## Verification

Per GLOSSARY "Verify" — observe on the real system, not only a passing test.

1. **Negative proof of the check:** a throwaway branch adds a migration with a bare `CREATE TABLE`; the check fails and names the file and the missing statement. Remove it; the check passes.
2. **Disposable PG16, after all migrations — the check depends on the declared path** (counts only):

   | Declared path | Grant check | Behaviour check |
   |---|---|---|
   | `tx` | `authenticated` holds **exactly** the privileges listed in the migration (no more, no fewer); `anon` and `PUBLIC` hold none | policy / isolation tests through `tx()`: same-org authorized succeeds; same-org unauthorized role is refused; cross-org sees zero rows and cannot write; sandbox vs live separated; `authenticated` with no claims sees zero rows; `anon` → permission denied |
   | `svc`, `owner` | `anon`, `authenticated`, `PUBLIC` hold **no** privilege on the table | direct `SELECT` as `anon` and as `authenticated` → permission denied |
   | `definer-only` | as `svc`/`owner`; `EXECUTE` on the function matches `supabase/rpc-allowlist.txt` (`npm run test:fn-priv`) | direct table access as `anon`/`authenticated` → permission denied; the function works for its declared caller and is refused for others |

   Local limit: functions are superuser-owned locally, so the `definer-only` behaviour check and any definer call inside a `tx` path are **not** proof of hosted behaviour (step 4 is).
3. **Staging, after a schema PR is applied by box PE** (aggregate output only): `relrowsecurity = true` for the new table; `relforcerowsecurity` equals the declared FORCE decision; table privileges equal the declared set for the path — the exact minimal `authenticated` set for `tx`, none for `anon`/`authenticated` on the other paths; function owner equals the declared owner; the Supabase advisor shows no new finding (box PE reads it).
4. **Path proof:** the feature's own journey works through its declared path on staging (e.g. the B-056 start-trial action succeeds as Admin and is refused cross-org). For `definer-only` tables and definer functions called inside `tx`, this staging run is the only evidence of the real execution role.

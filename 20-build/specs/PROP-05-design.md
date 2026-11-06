# PROP-05 — JIT L2 設計稿：Mode B＋flag registry／rings／override 稽核（L1-FLAG）

> Author: Claude (Mac overnight, 2026-11-06 PT). L1 foundation per hub `10-product/step4-architecture/architecture-v0.md` §8 (L1-FLAG, Wave C, gate: override 稽核) and build-order-proposal-v0 (PROP-05 ↔ B-027). No new flag. Branch cut from #36 (`d374bb6`).

## Done means

Every change to a global flag/kill switch in `platform_settings` (insert, update, delete) leaves an append-only `audit_log` row with old/new value, changed columns, actor, DB role, `app.change_reason` and `app.request_id`; per-org overrides (`organizations.feature_flags`) were already audited by the generic `fn_audit` trigger on `organizations`. CI fails if any migration seeds a flag that is not registered in `ops/flags.yaml` with `default: false`, seeds it enabled or with a non-empty allowlist, or seeds without `ON CONFLICT DO NOTHING`.

## Design

- Migration `20261106070000_prop05_platform_settings_audit.sql`: `app.prop05_audit_platform_settings()` (SECURITY DEFINER, `search_path = pg_catalog, public, app`, REVOKE ALL from API roles) + `AFTER INSERT OR UPDATE OR DELETE` trigger on `public.platform_settings`. `row_id` = setting key (the generic `fn_audit` needs an `id` column, which this table lacks); `org_id` NULL (platform scope); no-op updates skipped. No value, grant or behaviour change.
- Registry guard `src/server/flag-registry.test.ts` (unit): parses all migrations' `platform_settings` seeds whose value has `"enabled"` and `ops/flags.yaml` `global_kill: platform_settings.<key>` entries.
- Registry fix surfaced by the guard: `deposit_settlement` (B-011 / PROP-09, merged) was seeded but missing from `ops/flags.yaml` — entry added (`default: false`, ring internal, activation Ron decides).

## Out of scope (B-027)

Rings promotion workflow, override expiry/auto-renewal (P2 pricing), partner consent gate, UI for flag changes.

## Verification

`prop05-flag-audit.integration.test.ts` (insert/update/delete audited with reason; no-op update not audited; trigger function privileges); `flag-registry.test.ts`.

## Cross-review changes (Codex QA r1 FAIL → fixed)

- The registry guard now uses a quote- and comment-aware SQL scanner (`src/server/flag-registry-sql.ts`): column lists are mapped to VALUES tuples (reordered columns), quoted identifiers are normalised, comments are ignored (a commented-out `ON CONFLICT` no longer counts), the real conflict action must be `DO NOTHING`, and non-literal flag values (e.g. `jsonb_build_object`) are rejected as unsupported. Regression cases cover each evasion and semicolons/newlines inside descriptions.
- `actor_role` records the invoking role (`current_setting('role')`, falling back to `session_user`) instead of the SECURITY DEFINER owner; tested under `SET ROLE service_role`.
- Post-r2 hardening (not re-reviewed; round 3 is a CEO decision, hub BLK-MAC-06): structural delimiters must be punctuation tokens and tuple/column counts must match; nested block comments are tracked; dollar-quoted bodies are kept; every seed value is decoded (\u escapes included) and a non-decodable value is treated as an unsupported flag seed instead of being skipped. Regression cases added for each r2 bypass.

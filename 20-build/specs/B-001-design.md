# B-001 — JIT L2 設計稿：電子簽約收尾（slice：證件雙層開關 CAP-P-28）

> Author: Claude (Mac overnight, 2026-11-06 PT). Layer-2 design for hub `20-build/specs/B-001.md` incl. **PROP-US-v03-01** (Ron 2026-11-05 19:04 PT: new org `collect_id` master default **true**, sub-switch `require_id_before_sign` default **false**; only master ∧ sub ON blocks signing; master OFF ∧ sub ON invalid). **Activation: Ron decides** (BLK-001). Branch cut from #36 (`d374bb6`); independent of B-025/B-026 code.

## What is (and is not) in this slice

| B-001 scope | This slice | Where it stays |
|---|---|---|
| CAP-P-28 two-level ID switches; split the ID hard gate into an ON-blocking condition | **built** behind `id_sign_gate_v2` (OFF) | — |
| G0–G5 / §11.1 matrix, 24 cold starts, React #418, real receipt, browser signing | not from the Mac | PE staging + QA (BLK-001 gates) |
| Auth/consent order, RPC privileges, evidence, versions, disposal, paper fallback | unchanged; existing e-sign tests rerun | existing lane |

## Done means

With `id_sign_gate_v2` ON for a local test org and default settings, a tenant (or the e-sign completion path, or a staff paper-lease upload) can complete signing while the ID upload is still outstanding (collection runs in parallel); with `collect_id=true` ∧ `require_id_before_sign=true` signing is blocked with the existing `errors.idDocRequired` reason; `collect_id=false` never blocks. Flag OFF (default): all three existing hard gates behave exactly as today.

## Design

- Pure rules `src/server/id-sign-gate-rules.ts`: `resolveIdSignGate(settings)` → `{collectId, requireIdBeforeSign, mode: off|collect|block|invalid}` (strict booleans only; else defaults true/false); `signingRequiresIdentity(flagOn, gate)` → flag OFF ⇒ `true` (legacy), ON ⇒ `mode==='block'`.
- `src/server/id-sign-gate.ts` `identityRequiredForSigning(client, orgId)` reads `platform_settings.id_sign_gate_v2`, `organizations.feature_flags.id_sign_gate_v2` (explicit `=== true`) and `organizations.settings`.
- The three existing gates call it before `leaseIdentityReady`: tenant/manager signing (`domain.ts`), staff signed-PDF upload (`domain.ts`), e-sign completion (`esign/repo.ts`).
- Migration `20261106060000_b001_id_sign_gate_flag.sql`: flag seed `{"enabled":false,"allowed_org_ids":[]}` ON CONFLICT DO NOTHING. Switches live in `organizations.settings` (no migration). No settings UI in this slice (org settings are B-016).

## Invariants

Only master ∧ sub ON blocks; anonymous/cross-org/replay denial unchanged; PRINCIPLES 11 verification duty and PRINCIPLES 9 notice unchanged (non-blocking changes only *whether signing waits*); ID retention (PRINCIPLES 17) unchanged; no ID-notice or legal copy edited.

## Verification

Unit `id-sign-gate-rules.test.ts` (defaults, matrix, strict booleans, flag parsing); integration `b001-id-sign-gate.integration.test.ts` (seeded OFF ⇒ hard gate; ON matrix); existing `esign.integration.test.ts` still asserts `errors.idDocRequired` with the flag OFF.

## Cross-review changes (Codex QA r1 FAIL → fixed → r2 PASS)

1. Defaults apply only to absent keys; a present non-boolean `collect_id` / `require_id_before_sign` fails closed (`block`).
2. The tenant ID banner on `/t` and `/t/lease` (text unchanged) renders only when the same policy requires ID before signing; flag OFF or an error keeps today's banner.

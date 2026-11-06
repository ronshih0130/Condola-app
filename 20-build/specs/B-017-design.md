# B-017: disconnected policy slice

Scope: packages 1–2 of `/tmp/codex-evidence-B-017.md`, authorized local delegation on 2026-11-06. Claude@ron-mac owns ops-lock and is the sole committer. This slice adds a native compatibility harness and a pure policy evaluator; it does not complete [B-017](B-017.md).

## Slice proved

- `src/server/b017-legacy-compat.test.ts` pins the literal `d374bb695d0e97fad72d00449d6a57450a61a9b1` native matrix: four roles plus null, each against all 18 recognized keys. It also pins navigation destinations, home/denial routes and native-Admin audit access. Non-Admin audit readers return empty results without a DB query. Accountant rendering of public/internal photo DTOs exposes no photo name, ID, image URL or action; an Admin positive control renders the same photos.
- `src/server/b017-custom-role-policy.ts` accepts exactly 17 supported custom grants, excluding `data.export`. Validation rejects the entire malformed, duplicate or unsupported array. Assigned grants replace native rights, allowing supported cross-base composition such as Manager + `bank.reconcile`, subject to the native Admin actor's effective grant ceiling.
- Ticket text and photo decisions are separate. Native Accountant never gains photos through `tickets.update`. Company audit requires native Admin. Custom-role governance requires native Admin, effective `team.manage` and the management gate. `team.manage` and `settings.edit` remain ordinary supported keys for non-Admins but do not confer those reserved capabilities.
- Management requires `platformSettings.custom_roles.enabled === true`, an exact organization entry in `allowed_org_ids`, and `organizationFlags.custom_roles === true`. Missing/malformed values are OFF. No environment, DB or registry reader is introduced.
- Permission resolution does not accept a management flag. Existing enforced assignments therefore keep both their grants and restrictions when management is OFF. Missing assignment authority differs from an explicit `{ roleId: null }` tombstone. Missing/retired/draft/foreign/mismatched roles, invalid grants and unsupported capability versions produce `unavailable`, with no native fallback.
- The native state preserves all 18 legacy decisions. An explicit unassigned enforced state retains supported native rights; `data.export` remains unsupported in enforced v1. Authority inputs are typed snapshots, not authenticated credentials; the future trusted resolver must derive state from durable authority, never a request-supplied native-mode selector.
- An AST import check scans production `src` (including app/server and possible component/lib barrels), resolving static imports, exports, literal dynamic imports, require and type imports. The new modules have no production importers. Tests are registered in `package.json` under `test:unit`.

This proves isolated policy decisions and the current native presentation baseline. It does not prove that photo DTO serialization, direct APIs, raw storage/SQL or an installed new schema enforce the policy. There are no runtime callers, migrations, user-facing copy changes or flag activations. `ops/flags.yaml` is unchanged.

## Remaining blocker 3: durable governance and assignment — requires migrations

Implement org-scoped role/assignment/revision persistence and transactional governance. Required evidence includes same-org references, actor/resulting-state ceilings, last usable native Admin under concurrent changes, direct/indirect self-lockout, billing-owner protections, retained assignment tombstones through suspend/reinvite/reactivate, and idempotent receipts with conflict rejection. A grant-ceiling decision alone cannot authorize these mutations. Preserve the sealed historical inactive foundation; it is not applied authority.

## Remaining blocker 4: authoritative API and privacy enforcement — requires migrations

Add the trusted session/member/assignment resolver, exact operation bridges and restrictive raw-access policies. Prove same-cookie revocation at direct API and UI boundaries; stale revisions and queued writes must fail closed. Prove Accountant text-only access without photo IDs/names/counts/URLs/upload/sign/download across HTML/RSC, files/attachments, both vendor modes and copied bearers. Preserve genuine portal scopes and native-Admin audit. Verify management OFF with assignments, missing/poisoned authority, old credentials/clients, and old-code/new-schema compatibility with no assignments on an authorized non-Mac target. Local pure tests cannot close these gaps.

Validation and limits: [slice evidence](../../e2e-evidence/B-017/b017-policy-slice-evidence.md). Independent Claude QA, runtime/browser acceptance, migration review/application and whole-feature acceptance remain pending.

### Orchestrator review (Claude, 2026-11-06)

Reviewed the evaluator: no native fallback for retired/missing/foreign/version-mismatched roles; Accountant photo floor and native-Admin-only company audit hold; governance requires native Admin plus the strictly `=== true` `custom_roles` gate with allowlist; grant ceiling denies keys the actor lacks. Re-ran typecheck/lint/copy/`test:unit` 1109/1109/cf:build. Codex QA r1 **PASS** (no findings).

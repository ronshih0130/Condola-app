# B-005 — JIT L2 設計稿：開通、邀請與可續接試用（slice 1：durable invitation resend results）

> Author: Claude (Mac overnight, 2026-11-06 PT). Layer-2 design for hub `20-build/specs/B-005.md` incl. **PROP-US-v03-02** (M-34 unit-QR signup reserve). Branch cut from #36 (`d374bb6`), independent.

## Evidence reconciliation (existing, not rebuilt)

| Acceptance | Existing |
|---|---|
| Resumable onboarding progress | `onboarding-progress*.ts` + `onboarding-progress.integration.test.ts` (flag `onboarding_progress` OFF) |
| Accepted/expired/team invitations, no duplicate membership | `team-invite-link*.test.ts`, `team-invite-allowlist*.test.ts`, `portal-invite*.test.ts` |
| Invitation audit privacy | `20261104120200_b005_invitations_audit_mask.sql` + `b005-invite-audit.integration.test.ts` |
| Resend outcome contract | pure rules `src/lib/portal-resend-state.ts`, renderer `src/components/portal-resend-result.tsx`, in-memory reference `test-portal-resend-memory.ts` + `portal-resend-contract.test.ts` — **no durable store, route or sender** (BLOCKED register 11/02: "durable invitation resend (DB) needs new schema") |

## Slice 1 (this PR): durable resend results behind `INVITE_RESEND_RESULTS` (OFF)

Done means: with the flag ON for a local test org, a staff admin resending an incomplete portal invitation through the **mock provider (local capture, no network)** sees the contract result (captured / accepted / rejected / unknown / conflict / already_connected / disabled / unavailable), replays with the same request id return the same result, a second concurrent resend of the same invitation is a conflict, `unknown` is terminal even if the transport later resolves, a rejection releases the reservation, and an already-connected invitation never calls the transport — all durable across requests. Completed links are never reset. Flag OFF: zero writes; existing invite UI unchanged.

- Migration `20261106090000_b005_resend_results.sql`: seed `platform_settings('INVITE_RESEND_RESULTS', {"enabled":false,"allowed_org_ids":[]})` ON CONFLICT DO NOTHING; private `app.b005_resend_requests` (org, actor, request id, source invite id, generation, payload digest, status, deadline, timestamps; PK (org, actor, request); partial unique active reservation per (org, source) for non-rejected states); RLS on, REVOKE ALL; SECURITY DEFINER claim/settle RPCs with pinned search_path, flag + `app.has_role(org,'{admin,manager}')` checks; terminal states immutable.
- `src/server/portal-resend.ts`: DB-backed implementation with the same semantics as `createResendMemory` (eligibility from a trusted server snapshot of the invite: flag, invite available, already connected), mock transport `src/server/portal-resend-mock-transport.ts` (local capture only).
- Server action + rendering of the existing `PortalResendResult` where the staff resend control lives (reuse; no new copy).

## Not in this slice (logged)

Real e-mail/LINE sending; M-34 unit-QR signup binding (PROP-US-v03-02 — needs a controlled org/unit context token; if it requires a new token-binding table/verification page it goes to a post-52 PROP per the hub note); staging verification.

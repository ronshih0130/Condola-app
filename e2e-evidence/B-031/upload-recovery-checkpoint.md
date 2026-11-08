# B-031 slice 3 UPLOAD_RECOVERY — local checkpoint

**LOCAL ONLY / committed `1de6596` + fix round 1 `1334825` / flag `upload_recovery` default OFF.** Branch `feat/b-031-upload-recovery`, base
`1bba9f3`. Design: [B-031-design.md § Slice 3](../../20-build/specs/B-031-design.md). Claude independent review (not Codex QA): r1 FAIL (1 MAJOR, 5 MINOR) → fix round 1 → r2 PASS (7 MINOR, recorded in the hub). Not Codex-QA-signed,
no staging/production activation.

Acceptance: "Given partial upload failure, when retrying, then successful files remain and are not duplicated."

## Disconnect / retry evidence (`src/server/b031-upload-recovery.integration.test.ts`, 13/13 after fix round 1)

| Case | Result |
|---|---|
| 3 files, #2 PUT fails; confirm(#2) = missing; page reload restores draft; replay #1 = no sign/PUT/row; retry #2 alone reuses its reserved path; submit | exactly 3 attachments / 3 files / 3 items; second submit returns the same ids; late new key refused |
| Lost response after PUT | retry prepare = `stored` (no second sign/PUT); confirm twice = uploaded; 1 attachment |
| Disconnect between storage write and DB row (mark_uploaded connection dropped) | object in storage, item `signed`, 0 files rows (orphan recorded, not attached); submit refused; same-key retry adopts the object (1 object, 1 attachment); wrong-signature object removed |
| Concurrent duplicates on two connections (row lock held, 2 waiters observed) | 1 item row for the duplicate key; DB unique `(org_id, batch_id, client_key)` rejects a direct second row; two concurrent submits return identical ids, 2 attachments |
| Other user / org (as `authenticated`, JWT sub + pinned org) | other tenant, same-org staff, other-org admin, accountant: every gateway (items_for, reserve, mark_uploaded, lock, close, mark_attached) denied; direct table SELECT denied; tenant cannot stage internal; executable grants = 8 gateways for authenticated + flag reader for service_role only; all definers pin `search_path=pg_catalog, pg_temp`; internal photos stay hidden from tenant (existing RLS) |
| Failed final submit (2nd attachment insert dropped) | full rollback, 0 attachments; draft keeps `internal=true` and both uploaded files; resubmit attaches 2 once; 8-photo limit counts attachments + open items |
| Flag OFF | view/prepare/confirm/submit each issue exactly the one flag read, return null / 404, zero rows anywhere, no storage calls; SQL gateways refuse; 9 malformed flag shapes stay OFF; existing single-photo confirm + ticket detail SQL traces identical OFF vs ON and equal to `src/server/fixtures/b031-upload-off-sql.json` |

OFF render: `src/components/repair-thread-upload-off.test.ts` (3/3) — the uploader element rendered when
`uploadRecovery` is null equals the base `1bba9f3` JSX verbatim; pages pass only `ticketPhotoRecovery()` output.

Trace fixture provenance: recorded on this tree with `B031_UPLOAD_RECORD_TRACE=1`. The traced functions
(`confirmTicketPhoto`, `attachRepairPhoto`, `findRepairPhoto`, `repairPhotoTarget`, `ticketDetail`, `db.tx`) are
unchanged from base; `ticket-photos.ts` only gained two additive exports.

## Fix round 1 regressions (same file, now 13/13)

| Review item | Regression |
|---|---|
| M1 repro A | 6 attached, 2 lost PUTs, reload restores [signed, signed] (no "kept" copy); re-chosen file uploads (signed holds no slot); submit attaches 1 → 7, removes 2 stale reserved paths; no draft restored afterwards; confirm-time limit; owner discard closes without attaching and removes objects; discard idempotent |
| M1 repro B | two drafts × 5 uploaded; first submit 5; second rejected by the 8-photo trigger (full rollback) and still restored; owner trims 2 → submit 3 → exactly 8 attachments / 8 files / 8 objects |
| Probes C/D | batch bound to its ticket (prepare/confirm/submit/discard on another ticket refused); demoted staff submit refused |
| MINOR 1 | held batch lock → submit and prepare fail with `errors.busy` within the 3 s lock timeout; no partial writes; later submit succeeds |
| MINOR 2 | route body OFF: 6 ops each exactly one flag read → 404, zero rows; ON unknown key → 403 owner-scoped |
| MINOR 4/5 | reload after lost PUT adopts the stored object (1 object); storage outage on restore leaves `signed`; after a lost submit response the old key answers `closed`, a new key uploads, the old submit replays safely |

## Commands (local PostgreSQL 127.0.0.1:55432, DB `condola_b031u`, fresh stub + all migrations + seed)

```
CONDOLA_RLS_DISPOSABLE=YES npx tsx --test --test-concurrency=1 src/server/b031-upload-recovery.integration.test.ts   # 13/13 (round 1)
npm run test:unit            # 989/989 (round 1)
npm run typecheck            # PASS
npm run lint                 # 0 errors, 15 existing warnings
npm run copy:check           # 6/6
CONDOLA_RLS_DISPOSABLE=YES bash scripts/check-function-privileges.sh   # full gate PASS
# Existing suites, each separately with --test-concurrency=1:
#   repair 1/1, vendor-repair 4/4, tenant-payment-history 9/9, reminder-seed 2/2,
#   b031-session-hardening 94/94, rls 8/8, helper-execute 2/2, function-org-guard 4/4
```

Storage is an in-memory mock in tests (same probe/sign/header/remove surface as `ticket-photos.ts`); no bucket,
network, remote DB, deployment or browser run. Full `test:rls` not run here (architect runs it serialized).

## Open items

- Drafts never submitted or discarded keep rows/objects; no time-based cleanup (needs Ron decision on retention window and background storage deletion).
- Route OFF order: 401 (no session) and the consent gate precede the single flag read, as the repo-wide consent-entrypoint invariant requires.
- Vendor-link photos, handover, PDF/import/CSV single-file forms not covered; ID photos untouched.
- Browser walkthrough with the flag ON not performed (local dev has no storage; existing path behaves the same).

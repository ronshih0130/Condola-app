# B-031 slice 3 UPLOAD_RECOVERY — local checkpoint

**LOCAL ONLY / UNCOMMITTED / flag `upload_recovery` default OFF.** Branch `feat/b-031-upload-recovery`, base
`1bba9f3`. Design: [B-031-design.md § Slice 3](../../20-build/specs/B-031-design.md). Not reviewed, not QA-signed,
no staging/production activation.

Acceptance: "Given partial upload failure, when retrying, then successful files remain and are not duplicated."

## Disconnect / retry evidence (`src/server/b031-upload-recovery.integration.test.ts`, 7/7)

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

## Commands (local PostgreSQL 127.0.0.1:55432, DB `condola_b031u`, fresh stub + all migrations + seed)

```
CONDOLA_RLS_DISPOSABLE=YES npx tsx --test --test-concurrency=1 src/server/b031-upload-recovery.integration.test.ts   # 7/7
npm run test:unit            # 988/988
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

- No cleanup for abandoned drafts/orphan objects (needs Ron decision on retention window and storage deletion).
- Vendor-link photos, handover, PDF/import/CSV single-file forms not covered; ID photos untouched.
- Browser walkthrough with the flag ON not performed (local dev has no storage; existing path behaves the same).

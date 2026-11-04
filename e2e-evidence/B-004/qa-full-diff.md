# B-004 functional diff for CAP-M-02 and CAP-T-02

For an independent QA review. Notes only. This file does not change product code.

## Compare range

The range includes `ecdb26c`.

Left (parent of `ecdb26c`): `5cb1845f6739734398f5f7e37f75c1333f0c338a`

Right: `a396d033684e93329dfcc823b139a542982e28fc`

`ecdb26cd66b23eb5d96b6d4938c86e630d308c1b` is CAP-M-02: current-version marking, replacement reason/history, migration `20261030151500`, and the staff signed-PDF route. Later commits in the range add the tenant route, download audit, and `20261031100204`.

```
git diff 5cb1845f6739734398f5f7e37f75c1333f0c338a a396d033684e93329dfcc823b139a542982e28fc -- <files below>
git log --oneline 5cb1845f6739734398f5f7e37f75c1333f0c338a..a396d033684e93329dfcc823b139a542982e28fc
```

## File list

| Status | Path |
|---|---|
| A | `supabase/migrations/20261030151400_tenant_signed_pdf_read.sql` |
| A | `supabase/migrations/20261030151500_paper_lease_versions.sql` |
| A | `supabase/migrations/20261031100204_b004_paper_delivery_boundary.sql` |
| A | `src/app/m/leases/[id]/signed/[pdfId]/route.ts` |
| A | `src/app/t/lease/signed/[pdfId]/route.ts` |
| M | `src/app/t/lease/page.tsx` |
| M | `src/server/queries.ts` |
| M | `src/server/audit.ts` |
| A | `src/server/tenant-signed-pdf-download.ts` |
| A | `src/server/tenant-signed-pdf-rules.ts` |
| A | `src/server/paper-lease-versions.ts` |
| A | `src/server/paper-lease-versions-panel.tsx` |
| A | `src/server/paper-lease-versions-rules.ts` |
| A | `src/i18n/tenant-signed-pdf.ts` |
| A | `src/i18n/paper-lease-versions.ts` |
| A | `src/server/tenant-signed-pdf.integration.test.ts` |
| A | `src/server/tenant-signed-pdf-download.test.ts` |
| A | `src/server/tenant-signed-pdf-download-audit.integration.test.ts` |
| A | `src/server/tenant-signed-pdf-rules.test.ts` |
| A | `src/server/b004-paper-delivery.integration.test.ts` |
| A | `src/server/paper-lease-versions.integration.test.ts` |
| A | `src/server/paper-lease-versions-rules.test.ts` |

`src/app/m/leases/[id]/signed/[pdfId]/route.ts` is added by `ecdb26c` and is inside this compare. At `73a7d398` that route still had no role allowlist and no download audit. The QA fix adds both.

## Migrations

`20261030151400_tenant_signed_pdf_read.sql` adds `app.tenant_signed_pdf_readable(org, lease)`. Tenant SELECT on `lease_signed_pdfs` requires `platform_settings.tenant_signed_pdf = true`, the organization flag `tenant_signed_pdf = true`, and `app.is_lease_tenant`. An absent settings row is off. Execution is revoked from PUBLIC and anon and granted to `authenticated` and `service_role`.

`20261030151500_paper_lease_versions.sql` is the CAP-M-02 version migration from the base, edited in this range. The edit adds `app.audit_paper_lease_replaced()` and trigger `audit_paper_lease_replaced` so a replacement writes an audit row. Execute on that function is revoked from the public roles.

`20261031100204_b004_paper_delivery_boundary.sql` replaces `app.tenant_signed_pdf_readable` so the same two flags also require the active organization and environment pins (an unpinned session may read only its live lease). It adds `app.guard_paper_lease_version_delete` and a BEFORE UPDATE OR DELETE trigger on `lease_signed_pdfs`. Direct version changes raise `42501`. A delete whose parent organization, lease, or file is already gone is allowed so a real parent cascade can finish. Database owners can still bypass triggers. This is not a retention-forever claim.

Staging: all three filenames were applied on 2026-10-30. They are not pending apply.

## Routes

`src/app/t/lease/signed/[pdfId]/route.ts` is the tenant GET. It requires a tenant session, current consent, `TENANT_SIGNED_PDF_ENABLED`, a UUID `pdfId`, and the selected lease, then calls `tenantSignedPdfDownload`. Missing cases return 404 with `Cache-Control: private, no-store` and `X-Content-Type-Options: nosniff`.

`src/app/t/lease/page.tsx` lists the tenant's signed PDFs when the readable query returns them.

`src/server/queries.ts` adds the signed-PDF list and single-file read used by that route. The read is the RLS-backed fetch the download helper requires.

`src/app/m/leases/[id]/signed/[pdfId]/route.ts` is added in `ecdb26c`, which this compare includes. In that range it checks `session.kind === "staff"` and does not write a download audit. The QA fix adds the admin/manager allowlist and a `signed_pdf_downloaded` audit row.

## Audit

`src/server/tenant-signed-pdf-download.ts` builds the response only after the read returns a file. Headers are `private, no-store` and `nosniff`. The audit write runs before the 200 body. A failed audit returns 503 with those headers and no attachment. Constructing the 200 is not proof the client received the bytes.

`src/server/audit.ts` adds `writeSignedPdfDownload`. It inserts `audit_log` as `service_role` because `authenticated` cannot insert there. The row is `event_type = signed_pdf_downloaded`, `table_name = lease_signed_pdfs`, `actor_role = tenant`, with `lease_id` in `new_row` and the request id.

In this range `src/server/tenant-signed-pdf-rules.ts` hard-codes `TENANT_SIGNED_PDF_ENABLED = true` and still requires `tenant_signed_pdf === true`. The QA fix makes that switch the exact string `true` and otherwise OFF. The deployment switch for paper versions stays `PAPER_LEASE_VERSIONS_ENABLED` exactly `true` plus `paper_lease_versions === true`. Both organization flags and the platform setting stay off unless a test turns them on. `ops/flags.yaml` keeps `PAPER_LEASE_VERSIONS_ENABLED` default false.

## 100204 and version behavior

`src/server/paper-lease-versions.ts` and `paper-lease-versions-rules.ts` keep replacement reason checks and the current/history pointer behind the paper-version switch. The panel and `src/i18n/paper-lease-versions.ts` show that current pointer, history, and reason. `src/i18n/tenant-signed-pdf.ts` is the tenant download copy added in the range.

The integration tests in the file list cover the readable helper, download audit failure, ordinary-role version denial, and parent cascade. They are in the compare so a reviewer can see the assertions. They are not a gate-coverage claim for a later SHA.

## Worker

Staging Worker at notes commit `3fd94e0` is `efe4a399`. This diff does not deploy.

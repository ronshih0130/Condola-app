# B-004 functional diff for CAP-M-02 and CAP-T-02

For an independent QA review. Notes only. This file does not change product code.

## Compare range

Base (exclusive, and the tree diff's left side): `ecdb26cd66b23eb5d96b6d4938c86e630d308c1b`

Tip: `a396d033684e93329dfcc823b139a542982e28fc`

`ecdb26c` is an ancestor of `a396d03`. The base commit is CAP-M-02 paper current-version marking and replacement reason/history (`20261030151500`, staff signed-PDF route). The range is what landed after that baseline through the delivery-scope and committed-audit fix.

```
git diff ecdb26cd66b23eb5d96b6d4938c86e630d308c1b a396d033684e93329dfcc823b139a542982e28fc -- <files below>
git log --oneline ecdb26cd66b23eb5d96b6d4938c86e630d308c1b..a396d033684e93329dfcc823b139a542982e28fc
```

## File list

| Status | Path |
|---|---|
| A | `supabase/migrations/20261030151400_tenant_signed_pdf_read.sql` |
| M | `supabase/migrations/20261030151500_paper_lease_versions.sql` |
| A | `supabase/migrations/20261031100204_b004_paper_delivery_boundary.sql` |
| A | `src/app/t/lease/signed/[pdfId]/route.ts` |
| M | `src/app/t/lease/page.tsx` |
| M | `src/server/queries.ts` |
| M | `src/server/audit.ts` |
| A | `src/server/tenant-signed-pdf-download.ts` |
| A | `src/server/tenant-signed-pdf-rules.ts` |
| M | `src/server/paper-lease-versions.ts` |
| M | `src/server/paper-lease-versions-panel.tsx` |
| M | `src/server/paper-lease-versions-rules.ts` |
| A | `src/i18n/tenant-signed-pdf.ts` |
| M | `src/i18n/paper-lease-versions.ts` |
| A | `src/server/tenant-signed-pdf.integration.test.ts` |
| A | `src/server/tenant-signed-pdf-download.test.ts` |
| A | `src/server/tenant-signed-pdf-download-audit.integration.test.ts` |
| A | `src/server/tenant-signed-pdf-rules.test.ts` |
| A | `src/server/b004-paper-delivery.integration.test.ts` |
| M | `src/server/paper-lease-versions.integration.test.ts` |
| M | `src/server/paper-lease-versions-rules.test.ts` |

Unchanged in this range, same blob `46dd19a023dece9f4b5a20c5a5ccc335966fe4b7` at both ends: `src/app/m/leases/[id]/signed/[pdfId]/route.ts`. It is the CAP-M-02 staff route from `ecdb26c`, not a new file inside the range.

## Migrations

`20261030151400_tenant_signed_pdf_read.sql` adds `app.tenant_signed_pdf_readable(org, lease)`. Tenant SELECT on `lease_signed_pdfs` requires `platform_settings.tenant_signed_pdf = true`, the organization flag `tenant_signed_pdf = true`, and `app.is_lease_tenant`. An absent settings row is off. Execution is revoked from PUBLIC and anon and granted to `authenticated` and `service_role`.

`20261030151500_paper_lease_versions.sql` is the CAP-M-02 version migration from the base, edited in this range. The edit adds `app.audit_paper_lease_replaced()` and trigger `audit_paper_lease_replaced` so a replacement writes an audit row. Execute on that function is revoked from the public roles.

`20261031100204_b004_paper_delivery_boundary.sql` replaces `app.tenant_signed_pdf_readable` so the same two flags also require the active organization and environment pins (an unpinned session may read only its live lease). It adds `app.guard_paper_lease_version_delete` and a BEFORE UPDATE OR DELETE trigger on `lease_signed_pdfs`. Direct version changes raise `42501`. A delete whose parent organization, lease, or file is already gone is allowed so a real parent cascade can finish. Database owners can still bypass triggers. This is not a retention-forever claim.

Staging: all three filenames were applied on 2026-10-30. They are not pending apply.

## Routes

`src/app/t/lease/signed/[pdfId]/route.ts` is the tenant GET. It requires a tenant session, current consent, `TENANT_SIGNED_PDF_ENABLED`, a UUID `pdfId`, and the selected lease, then calls `tenantSignedPdfDownload`. Missing cases return 404 with `Cache-Control: private, no-store` and `X-Content-Type-Options: nosniff`.

`src/app/t/lease/page.tsx` lists the tenant's signed PDFs when the readable query returns them.

`src/server/queries.ts` adds the signed-PDF list and single-file read used by that route. The read is the RLS-backed fetch the download helper requires.

The staff route above is outside the diff. It remains the manager download path from `ecdb26c`.

## Audit

`src/server/tenant-signed-pdf-download.ts` builds the response only after the read returns a file. Headers are `private, no-store` and `nosniff`. The audit write runs before the 200 body. A failed audit returns 503 with those headers and no attachment. Constructing the 200 is not proof the client received the bytes.

`src/server/audit.ts` adds `writeSignedPdfDownload`. It inserts `audit_log` as `service_role` because `authenticated` cannot insert there. The row is `event_type = signed_pdf_downloaded`, `table_name = lease_signed_pdfs`, `actor_role = tenant`, with `lease_id` in `new_row` and the request id.

`src/server/tenant-signed-pdf-rules.ts` keeps the app constant `TENANT_SIGNED_PDF_ENABLED = true` and still requires the organization flag `tenant_signed_pdf === true`. The deployment switch for paper versions stays `PAPER_LEASE_VERSIONS_ENABLED` exactly `true` plus `paper_lease_versions === true`. Both organization flags and the platform setting stay off unless a test turns them on. `ops/flags.yaml` keeps `PAPER_LEASE_VERSIONS_ENABLED` default false.

## 100204 and version behavior

`src/server/paper-lease-versions.ts` and `paper-lease-versions-rules.ts` keep replacement reason checks and the current/history pointer behind the paper-version switch. The panel and `src/i18n/paper-lease-versions.ts` show that current pointer, history, and reason. `src/i18n/tenant-signed-pdf.ts` is the tenant download copy added in the range.

The integration tests in the file list cover the readable helper, download audit failure, ordinary-role version denial, and parent cascade. They are in the compare so a reviewer can see the assertions. They are not a gate-coverage claim for a later SHA.

## Worker

Staging Worker at notes commit `3fd94e0` is `efe4a399`. This diff does not deploy.

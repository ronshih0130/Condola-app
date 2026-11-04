# Old staff signed-PDF download returns 404

Checked commit `1c8fd07bc1fd78e7a86a00daff994f68e734be4f`, the commit this repo equates with staging Worker `e6788e38`. Staging was not called. This is a source reading of that commit.

## What the old staff route reads

`src/app/m/leases/[id]/signed/[pdfId]/route.ts` at that commit calls `paperLeaseVersionPdf`. A null result is HTTP 404.

`paperLeaseVersionPdf` returns null before any PDF query unless both of these are true:

- `PAPER_LEASE_VERSIONS_ENABLED` is the exact string `true`. That constant is computed once, when the module loads, from `process.env.PAPER_LEASE_VERSIONS_ENABLED`.
- `organizations.feature_flags.paper_lease_versions` is the boolean `true`.

The staff query then selects `lease_signed_pdfs` joined to `files` for the session org. It does not call `app.tenant_signed_pdf_readable`.

## `TENANT_SIGNED_PDF_ENABLED` and `platform_settings`

At that commit, `src/server/tenant-signed-pdf-rules.ts` is:

```ts
export const TENANT_SIGNED_PDF_ENABLED = true;
```

It does not read `process.env.TENANT_SIGNED_PDF_ENABLED`. The staff route does not import it.

`platform_settings` key `tenant_signed_pdf` is read only inside `app.tenant_signed_pdf_readable`. The tenant download and the tenant RLS policy use that function. The old staff download does not.

Turning on the tenant platform row and the org flag `tenant_signed_pdf` therefore leaves the staff handler on the 404 path. The paper env var and the org flag `paper_lease_versions` are the gates that open it.

## Can the new code make rollback compatible?

No. The deployed worker is the old program. A change in the new source does not change that worker's module constant, and it does not make the old staff handler start reading `platform_settings`.

The new staff route still requires `PAPER_LEASE_VERSIONS_ENABLED` to be exactly `true` and the org paper flag to be boolean true. It still does not treat the tenant platform row as a staff download switch. Flags stay OFF here, so this note does not turn either switch on.

The new reason-code check does not run on that SELECT. It is not the cause of this 404. Rollback of the worker to `e6788e38` still 404s a staff download when only the tenant signed-PDF flags are on.

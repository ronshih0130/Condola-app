# Old staff signed-PDF download returns 404

The standing cause is in [Correction: `wrangler rollback` restores the old secret set](#correction-wrangler-rollback-restores-the-old-secret-set). The sections below are the earlier source reading. They describe what the old program reads. They are not the cause of the 404 from `wrangler rollback e6788e38`.

Checked commit `1c8fd07bc1fd78e7a86a00daff994f68e734be4f`, the commit this repo equates with staging Worker `e6788e38`. The source reading below did not call staging.

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

The earlier conclusion in this section is withdrawn. See the correction below. New source still cannot change a worker that is already deployed, and the new staff route still does not treat the tenant platform row as its switch. That is not why `wrangler rollback e6788e38` returned 404.

## Correction: `wrangler rollback` restores the old secret set

The real cause is that `wrangler rollback e6788e38` restores that version's own secret set. That set predates `PAPER_LEASE_VERSIONS_ENABLED`, so the rolled-back worker does not have the flag secret the old program reads at module load.

Redeploying `1c8fd07bc1fd78e7a86a00daff994f68e734be4f` with the secrets set, staging Worker `16b745e5`, returned 200. Staff and tenant downloads returned the same bytes. The tenant download wrote an audit row. The old code writes no staff audit. That absence is accepted.

The source reading above still describes the old program: it needs `PAPER_LEASE_VERSIONS_ENABLED` in the environment, and it does not read `TENANT_SIGNED_PDF_ENABLED` or `platform_settings` for the staff download. With that flag secret present, the old program serves the file. The 404 was the missing secret restored by version rollback, not an incompatibility that new code has to patch.

Flags stay OFF in this note. No secret value is recorded here. The rollback procedure is in [docs/policy/deploy-checklist.md](../../docs/policy/deploy-checklist.md).

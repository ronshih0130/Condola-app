# `/t/history/<leaseId>/signed/<pdfId>`

This route is the ended-lease paper download. It is not the current-lease download at `/t/lease/signed/<pdfId>`.

The handler is `GET` in `src/app/t/history/[leaseId]/signed/[pdfId]/route.ts`. It loads the session, then current consent, then reads only through `tenantEndedLeaseSignedPdf`. That read requires lease status `ended`.

| Request | Result | Audit |
|---|---|---|
| Logged out | Redirect to `/login` | none |
| Session without current consent | 403 `errors.consentRequired` | none |
| Another organization's lease, including an ended one | 404 | none |
| Own lease in `pending_signature` | 404 | none |
| Own lease in `active` | 404 | none |
| Own `ended` lease, `TENANT_SIGNED_PDF_ENABLED` exactly `true`, platform setting `tenant_signed_pdf` true, and the org flag `tenant_signed_pdf` true | 200 private PDF | one `signed_pdf_downloaded` row, reason that same code |

A pending or active lease stays on the current lease route. This history route does not serve it.

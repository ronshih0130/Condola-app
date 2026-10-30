# Synthetic local verification

Source under test: `ced9ebe87c8d801c049ebb72b3351f231dc7b40d`. The test used the shared explicit disposable PostgreSQL guard and local demo mode. Node 20.20.2 was used with a private runner that cloned the idle local synthetic core83 schema into an owned database, seeded only that clone using fixture keys generated in child-process memory, and ran loopback-only Next and photo-mock servers. The clone was dropped afterward.

- `playwright test --config ../b006-real-playwright.config.ts e2e/import-real-resubmit.spec.ts`: final 3/3 passed (CSV 390, CSV 1280, sparse XLSX plus organization-OFF). No request to the import API was mocked. The private runner and config are local intermediates; the portable test itself checks the common disposable DB guard.
- `npx tsc --noEmit` and `npx eslint e2e/import-real-resubmit.spec.ts`: passed on the test branch.

The initial 1280 fixture collision is documented in the separately identified reconstructed note; its original browser trace was not retained as an evidence artifact. These checks are not a final combined-candidate gate or staging verification.

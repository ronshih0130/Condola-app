# B017 notification-center busy handling — PARTIAL

Parent `65280e0` carries the private resolution/reset admission follow-up. This local checkpoint contains only the authorized center gateway, actions, component/entry, M/T/O/V notification pages, dedicated i18n and tests. No SQL, global session/database/error handler, external provider or real producer changes. It is not a feature, integration, staging or release verdict.

Exact Git blob IDs:
- `src/server/notification-center.ts`: `698ab84d041a40a27d951c8e00b56b2f7afba791`
- `src/server/notification-center-actions.ts`: `325b7adf73903635c09f60b6511a80309e2fc591`
- `src/components/notification-center.tsx`: `813e6d7e1ec92d5abcc23a1bc81d3e3c5cb93eff`
- `src/components/notification-center-entry.tsx`: `426acc21543f82fa3452d3a6518d53282d8a30d1`
- `src/components/notification-mark-form.tsx`: `71f27dada6027b374722898f97ebfd197ab34095`
- `src/i18n/lanes/notification-center.ts`: `90874d5ad630f51ff4dc9c99e80b964f6f62c6ad`
- M/T/O/V notification pages: `845660a2805a78843ea548d5ef9ed72de571fded`, `96e738b43cce12cbd2ad9d907a1e8b912a649b45`, `fe5bb9ec7c49e311096dd53e4605a3959df4efb8`, `8bf5c9718ce3857a1529a7acde8138e49e3d10bb`
- `src/server/notification-center-busy.integration.test.ts`: `370753098a6748de854eb63d5f58d646c4d56e53`
- `src/server/notification-center-busy.test.ts`: `70f8ae44baebff63c85176859c6fe7ceb06c5de4`
- `e2e/b017-center-busy.spec.ts`: `c63ebe802b65a004f12d2ea588ec97b80888d3df`

Independent native static review supports this limited local freeze and browser execution. Coder-run Node 20: 9/9 unit assertions, 1/1 real-DB busy integration, 1/1 existing synthetic four-persona center integration, typecheck/lint/copy-check PASS; sanitized logs `work/B017-draft-evidence/busy-final-*.log`. The 250ms existing connection-close race is explicitly tested: awaited rollback releases the failed transaction, but this does not prove physical socket closure. Both earlier `0ffab6b` browser failures remain preserved: unseeded login and seeded run with two 55P03 diagnostic errors. The failed run's specific competing request is UNKNOWN; an actual held session-touch UPDATE reproduces the gateway conflict. Browser on this checkpoint is NOT_RUN at freeze.

Pending separately: actual four-portal/2-width browser and forced busy/mark retry tests, root-owned combined reset/retention, final 100216 migration compatibility, independent zh copy review, real producers/financial guards and practical late replay, full B010/B028 coverage and all release gates. No log filtering or NOWAIT weakening.

# Tenant ID privilege-upgrade fixture

`20261022180000_tenant_id_check.pr9e-variant.sql` is the exact user-supplied PR9e variant, SHA-256 `9b2295f0140e3b06e3f585ccf564816d98f7e00efbf0bea7f02d3147b69363b9`. It differs from the supplied current migration in helper execute grants and a comment. It is not the historical `b888ccd` migration and does not establish the older nullable-retention or oversized-photo state. Use it only to test the privilege upgrade and ordinary data retention.

`20261022180000_tenant_id_check.b888ccd.sql` is the genuine historical migration from Origin `ron-shih/condola-app` commit `b888ccd58c4f`, verified live on 2026-11-04. Its Git blob is `c9da3e9eecff356fd3d1bf107dcc8a3994e4f4f3` and SHA-256 is `381cc1492984dedcf7845d0f3f980496519f65b542368869474de2f7b7c919eb`.

The historical upgrade test applies the stub and sorted migrations with timestamps before `20261022200000`, substituting this fixture for `20261022180000_tenant_id_check.sql`. It asserts nullable `delete_after`, fixed `keep_days = 365`, and the historical 5,000,000-byte photo limit (no 819,200-byte cap), without synthetic schema changes. After seeding, it verifies the upgrade and replay, then applies the remaining migrations. No historical test is skipped.

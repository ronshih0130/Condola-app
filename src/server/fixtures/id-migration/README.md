# Tenant ID privilege-upgrade fixture

`20261022180000_tenant_id_check.pr9e-variant.sql` is the exact user-supplied PR9e variant, SHA-256 `9b2295f0140e3b06e3f585ccf564816d98f7e00efbf0bea7f02d3147b69363b9`. It differs from the supplied current migration in helper execute grants and a comment. It is not the unavailable `b888ccd` migration and does not establish the older nullable-retention or oversized-photo state. Use it only to test the privilege upgrade and ordinary data retention.

CEO disposition via Ron (2026-10-29T18:23:41.724477-07:00): because the genuine b888ccd state cannot be recovered and neither variant matches it, that single historical test is explicitly SKIPPED. PR9e coverage is still limited to its actual permissions/schema; no claim to reproduce b888ccd.

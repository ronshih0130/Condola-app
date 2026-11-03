# B018 pending issued fixture v10

SOURCE ONLY; review and database runtime pending. Same-invoice -4000+4000 asserts zero_charge; separate open negative and positive invoice headers assert offset; later +1000 due and actual recordPayment/history/original assertions retained.

- `src/server/tenant-payment-history-rules.ts` blob `eb312006537573d62d937ee3919c93fd5396567e` SHA-256 `5cf7322540741dd3ef8641894926b59bbc654f9149d69dd8ea4234eeae37d038`.
- `src/server/tenant-payment-history-rules.test.ts` blob `da24a52ad67d67c937b874f9cc6db1cbf428aded` SHA-256 `6dcf31d81f20670702f18932110740e25e3af1d61a308303f23ab97cf143716d`.
- `src/server/tenant-payment-history.ts` blob `8d2cd2d6de3e3c2a715c6ae26c93e402f059e0c3` SHA-256 `5f006ac243c3c18ebee21cbbe445a9737167aad37edb629acf23421dd930ef64`.
- `src/server/tenant-payment-history.integration.test.ts` blob `51fb4831e88405975e587e99c6a8a2cea6386716` SHA-256 `72c6920fd3ca632cc987fe06757b353e49469fe3fbae53dcc4efcdda14f1c101`.

No DB, test, typecheck, lint, browser or gate run for this correction. Prior v9 source and logs preserved.

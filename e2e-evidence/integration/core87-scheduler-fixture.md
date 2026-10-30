# Scheduler fixture correction — scoped PASS, full gate pending

2026-10-30T01:53:17.318400-07:00. Failed exact candidate `628a2fd928742952f10d8fdc651d0dabd577755c` remains FAIL: 570/570 unit tests passed, but RLS stopped at the tenant preference race. The claim selector excluded unregistered recipients only and could choose another registered co-tenant while the opt-out targeted the primary tenant. Its independent preference need not block on that other recipient's capture.

Test-only source blob `09aa3bb980e3fb3caa73a4050728bd6e1b43d74e` excludes every different principal and asserts the actual claimed principal before the real two-connection lock observation. The observed-blocking assertion and opt-out outcome checks remain intact. No product or published migration changed. Astra native scoped static PASS; this is not Claude Class B QA or a full-candidate verdict.

Root actual fresh87-clone seed + 11-file cross-lane suite passed40/40, typecheck passed and focused lint passed. Original gate failure remains in the private git common-dir logs. A new exact candidate gate/build/browser remains required; no baseline failure waived.

| Private workspace artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `core87-fixture-targeted.log` | 8948 | `368c3442310601e197474b56c57159ee114a572e035685a11c89a9c008f07cf9` |
| `core87-fixture-lint.log` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `core87-fixture-typecheck.log` | 43 | `31811f73c689302da9dec45337d7bc263c8275836ec3a4b12582a14f9632977e` |

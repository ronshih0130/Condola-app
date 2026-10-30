# B017 mark contention and response loss — PARTIAL

Parent `7eea5d2`. Scoped same-origin mark routes replace the prior UI action submission so a busy response cannot trigger a server-component rerender that discards the unread list. No migration, global database/session/error behavior, legal copy or provider changes. No integration, producer, staging or release verdict.

Exact Git blob IDs:
- Request helper/test: `652ad37badcbe797a390826393cc3208b3a3f581`, `8d0422a058c8255c1bf259deaaf799c508a2c660`
- Human/vendor routes: `4acf11ddd990471c4af6421cbcb013c85871b169`, `67139288bc3d897049be2fc1953d1b48c5309f22`
- Client form/rules/test: `7857bd8b99fd0fe9d389185ee1a668e7a99ba72f`, `724e58b70836fdf1664e59f290b3bfb18e76d7f3`, `4f7f9523acbaab42ac5c34fb2114f0a87a331dd1`
- Center component/i18n: `d6fe6dd4c7106fd6b8955b432a669c98769a2414`, `86f39ccbabbea673bd8bcc54208c8f1c8f8d7da2`
- M/T/O/V pages: `38f056624117734c58f2dfc5765d79fe39414ed6`, `cfb4db5751e77a64d79e67999da73180bd437ead`, `59d1218af5a7c40511ee77447ee949da7f8bb5e7`, `86a66ead05ed8765648a5831309a75aeabca0ec1`
- Real DB/vendor route test: `37f09a5fa488f04f394821d7b54ecf645036eaf2`; consent classification: `6c6439908a5c856573c874134fa7bf550f8124a5`
- Forced-busy browser: `a057fe191dffc73e595ea5d7ac38dfe95822a239`; response-loss browser: `62e3d2ddc2efd8f22411d16ede9439d3e2f9f36f`

Scoped independent native source review supports freeze/local browser execution, not release. Coder Node20 checks: combined request/client/busy unit 13/13, consent-entrypoint 4/4, real DB/vendor route 1/1, typecheck/lint/copy-check PASS (`work/B017-draft-evidence/route-*-candidate.log`). The human browser API, forced-busy mark path and real committed-response-loss fixture are NOT_RUN at freeze. Earlier `0ffab6b` unseeded-login failure and seeded 55P03 diagnostics, and `7eea5d2` forced-busy mark RSC rerender failure, are preserved. The `7eea5d2` normal synthetic four-portal run passed but is not evidence for this later client/route source.

Each route checks strict exact origin and bounded exact JSON. Human consent is first and scope derives from the actual session; vendor uses an exact job token in the request body and never a caller-provided org or user. Busy does not refresh or mark; unknown outcome remains unknown even after a busy retry. Only committed marked response triggers refresh. Deployment/proxy origin normalization, actual browser proofs, integrated reset/retention, final 100216 compatibility, independent zh review, real producer/financial scope, all delivery and release gates remain open. Trace remains OFF for vendor and response-loss tests.

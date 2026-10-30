# B017 notification marking — local PARTIAL

Frozen candidate `6d0ee9ea63ffde8cd3f35bf5a15953e0e53871dc`, on test topology companion `a637908c423ed20031f178525663a3af1f4b36b6` and route candidate `6ef43f9`. Exact Git blobs below bind the scoped runtime and tests; this manifest is not a producer, deployment or release verdict.

| File | Git blob |
|---|---|
| src/server/notification-center.ts | 698ab84d041a40a27d951c8e00b56b2f7afba791 |
| src/server/notification-center-actions.ts | 325b7adf73903635c09f60b6511a80309e2fc591 |
| src/server/notification-center-request.ts | 652ad37badcbe797a390826393cc3208b3a3f581 |
| src/server/notification-center-request.test.ts | 8d0422a058c8255c1bf259deaaf799c508a2c660 |
| src/server/notification-center-busy.test.ts | 70f8ae44baebff63c85176859c6fe7ceb06c5de4 |
| src/server/notification-center-busy.integration.test.ts | 37f09a5fa488f04f394821d7b54ecf645036eaf2 |
| src/server/consent-entrypoints.test.ts | 6c6439908a5c856573c874134fa7bf550f8124a5 |
| src/app/api/notification-center/mark/route.ts | 4acf11ddd990471c4af6421cbcb013c85871b169 |
| src/app/api/notification-center/vendor-mark/route.ts | 67139288bc3d897049be2fc1953d1b48c5309f22 |
| src/components/notification-center-entry.tsx | 426acc21543f82fa3452d3a6518d53282d8a30d1 |
| src/components/notification-center.tsx | d6fe6dd4c7106fd6b8955b432a669c98769a2414 |
| src/components/notification-mark-form.tsx | 1a574ab263c0743629287baa9c68aecc0b6d7236 |
| src/components/notification-mark-rules.ts | 724e58b70836fdf1664e59f290b3bfb18e76d7f3 |
| src/components/notification-mark-rules.test.ts | 4f7f9523acbaab42ac5c34fb2114f0a87a331dd1 |
| src/i18n/lanes/notification-center.ts | 86f39ccbabbea673bd8bcc54208c8f1c8f8d7da2 |
| src/app/m/notifications/page.tsx | 38f056624117734c58f2dfc5765d79fe39414ed6 |
| src/app/t/notifications/page.tsx | cfb4db5751e77a64d79e67999da73180bd437ead |
| src/app/o/notifications/page.tsx | 59d1218af5a7c40511ee77447ee949da7f8bb5e7 |
| src/app/v/[token]/notifications/page.tsx | 86a66ead05ed8765648a5831309a75aeabca0ec1 |
| playwright.b017-localhost.config.ts | a6bc4deff8e5f6d48ce4d5a1ffbebaacfdfa9347 |
| e2e/b017-mark-hydration.spec.ts | 7acbecbc1006ad60df2459bd0d615d006cbf0da0 |
| e2e/b028-center-local.spec.ts | 43ac4dad38ac10b633643cd0e1d31b66f442ce5c |
| e2e/b017-center-busy.spec.ts | 610bfba1b894eae0742385c727500d63335234f3 |
| e2e/b017-mark-response-loss.spec.ts | 29927325336467040c261f931d02df13ed014f52 |

The author ran four individually named Chromium specs, each on a separate freshly seeded owned clone with migration 17. All four passed 1/1. Local evidence paths are relative to the project base under `work/B017-draft-evidence/`; hashes below are SHA-256:

| Log | SHA-256 | Scoped observation |
|---|---|---|
| hydration-browser-6d0ee9e.log | 517e7678ab6aecf79d1db3e750eabe691eb3697a4a4004466933c5080fb1f93b | Scripts held: disabled SSR control, pointer and keyboard after focus attempt cause no navigation/POST; release produces marked response and one read. Disabled native button cannot itself receive focus. |
| hyd-portals-6d0ee9e.log | 4edded9aeb7ba176932e02698bf9ffaeae94c070335a19063e8b1907414861eb | Synthetic M/T/O/V independent read/reload; vendor uses no staff/owner session cookie. |
| hyd-busy-6d0ee9e.log | 6ec69aa8277dab773438e8909766548689a0f85194091683cb347b0676eb260b | Forced admission and mark contention, retry and persisted read at 390/1280; 127-origin request denied 403. |
| hyd-loss-6d0ee9e.log | 9c841844d4ee52b5efbbf6cad23a5ed8218510219897d71cdcfc6a60e7cdf54f | Real marked response and DB count one before exact response abort; unknown remains through busy retry, reload discovers read. |

Author Node 20 typecheck and lint passed (`hydration-type.log`, `hydration-lint.log`). Independent highest reviewer scoped static PASS on component/test and reviewed the four author-executed logs; execution attribution remains the author's. Earlier 6ef origin failures, a637 forced-busy failure, and the separate click-method diagnostic are retained under `work/B017-draft-evidence/`; none is overwritten or retrospectively relabeled.

The browser origin is the observed local Next origin `http://localhost:43123`; the runtime strict comparison is unchanged. Deployment/proxy effective-origin mapping is NOT_RUN and remains a release gate. Vendor and all portal events are synthetic, not real-producer coverage. Final 100216 compatibility, real rent/payment and other producers, retention, channel/provider delivery, integration and release remain open. No real sends or provider keys were used.

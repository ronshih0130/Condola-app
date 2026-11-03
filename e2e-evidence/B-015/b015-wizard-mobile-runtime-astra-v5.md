# B-015 independent mobile wizard runtime review v5

**SCOPED_LOCAL_GO for the normal existing-tenant wizard journey on the unchanged application. V4 passed both desktop cases and exited 1 with both mobile submissions untested. V5 passed both mobile cases and exited 0. No product change was made.**

## What the two mobile cases established

Both rendered at 390×900 in the intended language. I inspected all 26 original PNGs, including the initial, panned and final-button captures. Each case selected a unique displayed room and the existing Jamie Lin contact, then used ordinary pointer input on all seven Next controls.

Across all three review views the full English room text exactly matched “Maple Court · Unit 2A Garden room overlooking the courtyard”. Chinese-language views matched “Cedar Court · Unit 2A Garden room overlooking the courtyard”. The genuine card pans exposed connected intervals of each label. English covered [0, 207.70] and [47.70, 377.38] px of 377.38 px after moving 196 px. Chinese covered [0, 245] and [47, 377.06] px of 377.06 px after moving 158 px. Tenant, rent and deposit were fully visible in the initial view.

Submit was initially disabled in both screenshots. After it became enabled, actual hit tests recorded an unobstructed button point at (259.55, 533.59) in English and (287, 512.59) in Chinese. The ordinary clicks created two distinct leases. Each had one primary party referencing the original contact, rent NT$10,000, two months’ deposit, rent due on day 5, and a 2094-01-01 through 2094-12-31 term. Total organization contacts stayed at 10 in each case.

## Integrity and scope

The browser recorded no console, page, HTTP 5xx or external-request errors. Both known seed firms ended with line_alerts and branded_line_oa false, matching the OFF fixture baseline. No baseline rows changed, disappeared or were added. The two named global activation checks and all-org enabled/opt-in counts were zero. The original seed had line_alerts true in each firm.

Clone, seed, browser, effective and server exits were zero. The owned process group drained and the supervisor recorded no port or cleanup error. Verified 39 receipt bindings, 1,006 source pins at both boundaries and against Git/working bytes, the reviewed lock and both helper hashes. All 26 images were 390×900.

The English final button extends about 26 CSS px past the right edge. Its visible area provided a natural pointer target and the lease was created. The Chinese button fits. The evidence covers Chromium viewport emulation, not physical devices, staging or release. Whole B-015 retains its separate pending scopes. No important UX or security blocker was found in this diagnostic.

- `receipt.json` · 182198 bytes · `b5dc019693fea6cbf3f9fb9eb6199e40e7a6ab729ed76fc0b68367567a4b1f77`
- `browser-result.json` · 372 bytes · `136ce226314c7b02df4e89608d1e9d7292e4d359ae2f9a6a63b4d7eeb073783c`
- `en-390.json` · 143366 bytes · `a869d509fd09edf70a17f3ea303fc94eee15ad8d18dba84c7fb85727acee71a9`
- `zh-TW-390.json` · 143166 bytes · `0f7f1d76c75e03faf4b70e143dd47456073fb93f7bd977871f7a7e8ea5adbd96`
- `flags-seed.json` · 542 bytes · `555855bf1ab77509e27beb8cef48ba60d16030b3eb1c5b0b8fe59a892403095f`
- `flags-off.json` · 544 bytes · `35130523593e75e553aa8ac5859f5df3528432427a35397433f242b9ac39d7af`
- `flags-final.json` · 661 bytes · `48f9ef926d6c9a11cf94fdcc67e0fd9b6b791a1013be2136e64e8952262e6563`
- `source-lock-v5.json` · 88262 bytes · `aaddf7137b733986868ae8dd8ff730401914f3042f84a9b93aa1a94f5c7b03b9`
- `prior/v4-runtime-review.json` · 4396 bytes · `7596cf372eb10d751751516d1e659a539ab084d7cfd1d3c37955a3ae4eb2ac2a`

# B-035 local implementation validation

Status: local implementation and requested checks PASS; uncommitted working tree for Claude's independent review.
Date: 2026-11-06 PT. Implementer: Codex, continuation of the interrupted run. Claude remains the sole git committer.
This is local evidence, not an independent verdict, release approval or real-device acceptance.

## Scope and routes

- Reuse B-033 provider verification, browser proof, one-time flows, account links and recovery services.
- Extend POST `/api/line/flows` with a body-only job credential; derive job/org on the server and reject conflicting scope hints.
- Extend POST `/api/line/session` and GET `/api/line/login/callback` to mint only a short-lived, browser-bound job cookie for job flows.
- Strict-gate GET `/v/liff`; add GET `/v/liff/job` and GET/POST `/api/line/vendor-job`.
- Recheck assignment, sharing, token hash, expiration, revocation and ticket state with the existing job guards and locked report writer.
- Preserve B-026 account/history authority and B-033 unlink/recovery/queued Email fallback. No account or staff authority comes from a job claim.
- Reuse local brand-v2 vendor-job assets when the existing brand flag is ON; reuse existing zh-TW/en text. No product dictionary changes.
- Add one private RLS-enabled, service-only migration: `20261107085000_b035_line_vendor_claim.sql`.

## Acceptance evidence

All five hub Given/When/Then cases are covered through exported handlers in `src/server/b035-vendor-liff.integration.test.ts`:

| Acceptance | Evidence |
| --- | --- |
| Valid assigned job + verified LINE opens only that job | Scoped safe read/page, no account/session provisioning, OAuth callback, one-winner concurrent consume, replay denial |
| Missing capability gives safe guidance | Generic entry's Email link; unknown identity receives account-required; lost WebView cookies redirect to clean `/login` |
| Invalidated token denies reads/writes despite LINE authentication | Expiry, revocation, reassignment, sharing removal, hash rotation, vendor archival and closed-job write denial |
| Org/global unlink preserves Email for pending dispatch | Real bind/unlink/revoke handlers; captured transport has zero LINE calls; Email delivery queued; verified Email session survives; global LINE sessions revoked |
| Token-only users gain no history authority | Account/history, account-invitation and staff endpoints reject job cookies/tokens; real B-026 mapping and removal determine authorized history |

Additional coverage: cross-org and foreign-scope 404s, browser isolation, claim/flow expiry, wrong audience,
Origin/CSRF denial, malformed/missing/OFF platform and org settings with zero-write snapshots, private grants/RLS,
immutable job scope, anonymous claims invalidated by later account binding, concurrent binding/report locking,
localized escaped HTML and local-only brand assets. The design has the exact acceptance-to-test mapping.

## Fresh local database and final checks

The continuation recreated only `condola_b035impl` at `127.0.0.1:55432`, applied `supabase/stub/supabase_stub.sql`
and every migration in order, sourced the supplied local environment without printing it, and ran `db:reset`.
Integration tests use `cloneTestDatabase()` and `resetAndSeed()`. Node 20.20.2; npm 10.8.2.
Every Node validation process loaded `/private/tmp/b035-local-only.cjs`, which blocks non-loopback HTTP/sockets.
B-035 additionally replaces fetch with a throwing guard; LINE JWTs are synthetic local HS256 and push transport is captured.

| Check | Final result | Log under `/private/tmp/` |
| --- | --- | --- |
| Fresh stub + all migrations + reset | PASS | `b035-resume-db.log` |
| `npm run typecheck` | PASS | `b035-resume-typecheck-final.log` |
| `npm run lint` | PASS; 0 errors, 16 existing warnings | `b035-resume-lint-final.log` |
| `npm run copy:check` | 6/6 | `b035-resume-copy.log` |
| `npm run test:unit` | 1034/1034 | `b035-resume-unit.log` |
| B-035 vendor LIFF | 48/48 | `b035-resume-b035-vendor-liff.log` |
| B-033 login/link | 79/79 | `b035-resume-b033-line-login-link.log` |
| B-033 foundation | 94/94 | `b035-resume-b033-line-foundation.log` |
| B-027 denial inventory | 28/28 | `b035-resume-b027-denial-inventory.log` |
| `git diff --check` | PASS | Checked after final documentation changes |

Each integration file ran as its own `tsx --test --test-concurrency=1` process, sequentially. All final test
runs have zero failures, cancellations, skips and TODOs. Full `test:rls` was not run.
The prior B-027 run failed only its generated-inventory comparison (27/28); the authorized regeneration
added exactly the two new routes. Prior failure logs remain at `/private/tmp/b035-{integration-initial,integration-r2,b027}.log`;
the regenerated inventory and final reruns are retained. No baseline failures were waived.

## Independent-review fixes (2026-11-06)

- MAJOR: `/v/[token]` gained a strictly gated "continue in LINE" entry (`src/app/v/[token]/vendor-line-entry.tsx`,
  `continue-in-line.ts`, `src/server/line/vendor-entry.ts`, POST on `src/app/(line)/v/liff/route.ts`). The job token travels only
  in same-origin POST bodies (`referrerPolicy: no-referrer`); navigation uses a `rel=noreferrer` link to `/v/liff?flow=…`.
  Driven end-to-end (rendered page → proof → flows → bootstrap script → exchange → page/read/report of only that job).
  OFF HTML equals the pre-B-035 page byte-for-byte (classic/enhanced, zh-TW/en, env/platform/org/malformed OFF).
- MINOR: migration renamed to the 14-digit `20261107085000_b035_line_vendor_claim.sql`; references updated.
- MINOR: real `dispatchVendor` re-dispatch to a different vendor; old claim read/report and new old-token flows return 404 with zero writes.

## Remaining boundary

- Independent Claude review and the sole git commit are pending with the architect.
- Real LINE SDK/transport activation and physical-device/WebView acceptance remain Ron/QA's responsibility.
  The existing host-provided `window.liff` requirement and unavailable default OAuth exchange are unchanged.
- No live LINE HTTP, external network calls, remote databases, deployment, flag activation, git mutation or PR creation.
- Tenant/owner expansion, new account/history authority, and release gates are outside B-035's local implementation scope.

## Changed-file manifest

The following SHA-256 values identify the local review inputs; this evidence document is excluded from its own manifest.

| File | SHA-256 |
| --- | --- |
| `20-build/specs/B-035-design.md` | `3bbf7f96fd771f12778f0d6a4b3ea3d86064f7f2d40002bf9638462b67c0700d` |
| `e2e-evidence/B-027/denial-inventory.md` | `d1cc5f096e9e3e01123844977552d0508caaa8d114852fae7950ac03c8ba8013` |
| `package.json` | `6a82dd9c3dd1f8d115805a95d22857419b25932af12844d7ada12fa80c11dd04` |
| `public/line-bootstrap.js` | `ce18be61a849f83800c77b05a073c7569c3fa49e882d4bc308914a5910e0b304` |
| `public/line-vendor-job.js` | `bcd8da42af0c2febe6f32e8660cb87fb735ba692a20577c0dbac1e5c5546384a` |
| `scripts/write-pr-migrations.mjs` | `a4ff0a8cda4047fac956a4332caf3b775b6da15adc7a81a318d34ca867623660` |
| `src/app/(line)/v/liff/job/route.ts` | `2499da278f48ab1daed87a69435c45d9331c8994eab52d9344798b815afaf395` |
| `src/app/(line)/v/liff/route.ts` | `c4c39b9244c706b943512d94b25ad4ce5634b5daebed725fa7c86b88e03539e1` |
| `src/app/api/line/vendor-job/route.ts` | `ee5e2deecd1e7b03467a07b4384710b73f2e99ff2470ed5bfd53a6d59de0f21c` |
| `src/app/v/[token]/continue-in-line.ts` | `26d2c8253804a5caec0636d5b9c3ab4ac3dc6d5702070971f59a201833933437` |
| `src/app/v/[token]/page.tsx` | `47f846f5f7874f02e31664c3c3b89f80b94615874cc6013f5022dd833c700fce` |
| `src/app/v/[token]/vendor-line-entry.tsx` | `f4f243d8d3d2088ec2c0ae05a7193b58381468811f70fa3d50b5b92c711d50df` |
| `src/i18n/en.json` | `d79cb381e27aa519a2d97e96ea895689a5b017e60d87b05128adcad45afc4a65` |
| `src/i18n/zh-TW.json` | `ceb9fd584c285914f31c4bcca99889d65fe4521bb18752f4e6c833933628fbdc` |
| `src/server/b033-line-login-link.integration.test.ts` | `5b1bca397080f6b478a4f27ae50bd417dce73c17a5e3f15150205b38853a2358` |
| `src/server/b035-vendor-liff.integration.test.ts` | `9dd06f0c5b03deb05b6e64f96d8e2cadeb2fb4ec3f6fe53669fac8426db0527a` |
| `src/server/consent-entrypoints.test.ts` | `d12261f2da7ea2c2bcb4813be1443e47b4b05eca5f0a86c9a00542f66144e353` |
| `src/server/lease-rules.test.ts` | `8c605e7bea591dfa4cb678675dc7c2d3d454b7db0005398c1686d196b952e211` |
| `src/server/line/bootstrap.ts` | `cccfe23bbdea1ea86e3a61fcb2d757ca66cdad84ffb128224df9229a6e834896` |
| `src/server/line/login-link.ts` | `d422e379958e2e99e4670c37a7cea3a96cef6461bc2531ee5cb29998fdeeb17f` |
| `src/server/line/login-routes.ts` | `b0c29c09d7e802c0cf8608eccd6fa7f67acdf5996c821ff51d11b40d326e8d51` |
| `src/server/line/vendor-entry.ts` | `19c3c001ed57b823a59fe78e5a890f4dc4d319f3a21c1fd925565d3b2da13c77` |
| `src/server/line/vendor-job-routes.ts` | `4771ada9f3dc3f2e0366271f9d8baad6502d5e0fa3ad4888ec5e45266819226d` |
| `src/server/line/vendor-scope.ts` | `7e3c4f3db81875943be2490237415cf5dc63ae096bbf401e0783e6f05ecf34f6` |
| `src/server/seed.ts` | `62b682283e383ea8f9ab9a83b5b9431529b893741d6c54f198c09cd128caef58` |
| `src/server/vendor-repair.ts` | `2d117fd1b938231641f55c0d9b7c55d9a17b0143771baf31adf34951bd827079` |
| `supabase/migrations/20261107085000_b035_line_vendor_claim.sql` | `d06909ac0c4d39d10c1d97b283571842d710c532ada61ac708b175e0a9c302a8` |

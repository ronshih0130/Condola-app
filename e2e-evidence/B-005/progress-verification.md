# B-005: trial progress reconciliation

Status: partial; local change awaits independent review. No release or activation is implied.

The existing manager guide reads organization `settings.tryout`; each completed trial action writes a flag there. The guide appears in sandbox, whose new organization starts with `sandboxPrompt` and no `tryout` object. Self-serve live organizations also lack that object. The previous nested `jsonb_set` update therefore did not create a flag; the seeded demo already has the object and can mask the issue. No new table or migration is needed for this existing organization-level progress.

The update now initializes a missing or non-object `tryout`, merges the completed flag with an existing object, and retains other settings. The update remains a single database statement so concurrent updates to the same organization serialize at the row. A focused synthetic integration test checks missing and malformed values, preservation, repeated and concurrent writes, and separation between organizations.

Checks: `npm run typecheck` and `npx eslint src/server/domain.ts src/server/tryout.integration.test.ts e2e/tryout-resume.spec.ts` passed. With `DATABASE_URL` set to the provisioned disposable local PostgreSQL 16 instance on port 55435, `CONDOLA_RLS_DISPOSABLE=YES npx tsx --test src/server/tryout.integration.test.ts` passed (1 test, 0 failures). Its negative control executes the original update and confirms the missing intermediate path leaves settings unchanged. It also checks an untouched organization and verifies all unrelated fields against the values returned by the database on insertion. The initial test run failed because an organization trigger adds `country`; the corrected fixture uses actual initial settings rather than assuming the inserted JSON remains unchanged. The test requires an explicit disposable assertion and a loopback PostgreSQL URL with a named database and no query parameters.

A synthetic browser test for sign-out/sign-in at 390 and 1280 pixels is prepared but not yet run. Registration/resend/trial checks, sandbox report isolation, and the unpublished team-invitation lane remain unverified. This evidence does not complete B-005.

## Node 20 verification and review update

Required runtime is Node 20.20.2 / npm 10.8.2. A later shell selected Node 25; those preliminary results are not used as the pinned-runtime acceptance evidence. Re-ran the focused integration and typecheck with explicit Node 20 PATH: PASS. Full lint and 221 unit tests also passed under Node 20 before the final B-006 parser corrections.

`DATABASE_URL=<disposable-loopback> CONDOLA_RLS_DISPOSABLE=YES DEMO_MODE=true npx playwright test e2e/tryout-resume.spec.ts --reporter=line` under Node 20: 2 passed (390px and 1280px), no observed browser console/page errors or 5xx. Trial progress survives a real sign-out/sign-in and selecting the sandbox again; one flag stays completed and another stays incomplete. The completed state was set through the existing markTryout writer, not a full end-to-end property creation, so that broader journey is not proven here. Screenshots were visually inspected; hashes/paths are in screenshots.json.

The initial desktop browser attempt failed because the test clicked the hidden mobile drawer logout. Test now uses the desktop logout on desktop and the drawer on mobile. No app logout change was needed.

Highest-tier native reviewer found no blocking SQL defect; noted service-role writer tests are not caller-auth/RLS proof, and required maintaining the integration command. The test is now included in test:rls with a loopback + explicit disposable guard. This native partial review is not Claude desktop Class B sign-off.

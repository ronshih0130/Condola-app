# B-037 local evidence (2026-11-06 PT)

Local only: fresh `condola_b037impl` on `127.0.0.1:55432` (stub, every migration, `db:reset`), Node 20.20.2 /
npm 10.8.2. Captured `LineTransport` only; `globalThis.fetch` throws and is asserted unused. No live LINE HTTP,
remote DB, deployment, full `test:rls`, git mutation or flag activation. JSON files are written by
`B037_WRITE_EVIDENCE=1 npx tsx --test --test-concurrency=1 src/server/b037-line-rent-pushes.integration.test.ts`
and contain no LINE user ids.

| File | Content |
| --- | --- |
| `captured-payloads.json` | zh-TW and en text for rent_due, rent_overdue, payment_confirmed, payment_rejected (reminder + LIFF link only). |
| `quota-179-180-181.json` | 179 ⇒ sent (counter 180); 180/181 ⇒ `line_quota` fallback, no push; one Email per recipient. |
| `concurrency.json` | Timeout then two concurrent retries ⇒ `busy` + `sent`, 2 transport calls total, same retry key, one settled reservation (attempt 2); open-claim rotation (3 stuck org-A claims, limit 2 ⇒ org B sent on run 2). |
| `off-matrix.json` | 9 OFF layers: zero writes (15-table snapshot incl. B-010 claims/email_log), zero transport calls. |
| `single-email.json` | All Emails per recipient per event across the B-010 claim and LINE fallback = 1 for every fallback reason and unknown-result expiry. |

Results: typecheck PASS; lint 0 errors (16 existing warnings); copy:check 6/6; test:unit 1035/1035; separate
`--test-concurrency=1` runs: B-037 50/50, B-033 foundation 94/94, B-034 41/41, reminder-foundation 11/11,
B-028 delivery claims 21/21, B-027 denial inventory 28/28; zero failures/skips; `git diff --check` PASS.

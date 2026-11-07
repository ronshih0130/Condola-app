# B-031 slice 2 — AUDIT_DETAIL local evidence

**LOCAL PASS · flag `audit_detail` default OFF · `ff674a5` + fix round 1 `a14a463` on `feat/b-031-audit-detail` (base `1bba9f3`); fix round 2 (independent re-review) uncommitted on top.**
Design: [`20-build/specs/B-031-design.md`](../../20-build/specs/B-031-design.md) § Slice 2.

## Acceptance

> Given important mutation, when audited, then permitted actor/time/reason/before/after fields are available.

| Check | Evidence |
|---|---|
| Permitted actor/time/reason/before/after | `b031-audit-detail.integration.test.ts` #1: production `updateLease` (rent NT$30,000 → NT$33,000, deposit NT$60,000 → NT$66,000), reason-bearing end-date change, `updateOwner` (partial phone/email), `setMemberRole` (會計 → 經理); actor 林雅婷 and Taipei time on the same row; zh-TW and EN render |
| Privilege filtering (DB, API role) | #3: `app.b031_audit_detail_rows` through `tx()` as `authenticated` returns rows only to an active admin of the pinned org. Zero rows for manager, accountant, maintenance, tenant, owner, another org's admin, pin mismatch, cross-org ids and a suspended admin. `anon`/`service_role` EXECUTE and direct table SELECT/INSERT as `authenticated` fail with 42501 |
| Masking | #2: stored JSON, view model, rendered HTML contain no raw national ID, resident certificate number, token-like string, 16-digit account number, phone, email, legal name or LINE id; secret-shaped columns are withheld (count only). Unit `b031-audit-detail.test.ts` re-mask checks |
| Log scan | #2: console log/info/warn/error/debug captured during read + render; no secret present. The migration and reader emit no log lines |
| URL scan | #2: every rendered href is an existing record link (`/m/owners/<uuid>` etc.); no query parameters, audit ids or secrets |
| OFF zero-write / zero-read | #4: 10 flag shapes (default, global off, string booleans, org not allowlisted, allowlist missing/string, org flag absent/string/false, row absent) write no detail rows and read none, even with detail captured earlier while ON |
| OFF equality | #5: complete SQL trace of `loadAuditScreen` and two `loadAuditHistory` flows equals the 1bba9f3 baseline apart from exactly one reader statement; presented result (cursors excluded) and `AuditRows` markup are identical. Baseline `src/server/fixtures/b031-audit-detail-off.json` was captured by running the fixture against the unmodified 1bba9f3 `audit-read.ts` / `audit-log.tsx` |
| Review fix round 1 | #9–#12: write/read masking parity over all reviewer probes (bank/card groups, full-width phone/ID, spaced ID, landline, tokens) with reason codes kept; production write of M1 formats stored masked; fixed reason codes shown identically ON and OFF; forced capture failure and audit id conflict keep the business write. Unit #6–#9 |
| Review fix round 2 | #9 now covers 106 fixture probes (incl. every rv2 leaking input) for write/read and normalise parity; #12 asserts a stale detail under a reused id is not attached to the new event (N2); #13 rv2 e2e (8 reviewer values + every sensitive probe) stored and rendered masked with labels readable; #14 OFF returns before the guarded block (N4). Unit #6/#7 sensitive and readable probes, normalisation and cap |
| Reason semantics | #6: optional; blank/whitespace → none (rendered 未填寫原因); capped at 500; never fabricated |
| Scope | #7: inserts, deletes, NULL-org rows, non-covered tables and `recordAudit` events produce no detail. #8: append-only (UPDATE/DELETE rejected); exact BigInt amount display |

## Local runs (loopback PostgreSQL `condola_b031a`, fresh stub + all migrations + seed)

| Command | Result |
|---|---|
| `b031-audit-detail.integration.test.ts` | 14/14 |
| `audit-read.integration.test.ts` | 3/4 — #4 "keyset plans seek an index" fails identically with every slice-2 object dropped from the DB (pre-existing planner choice on this cluster, confirmed on base 1bba9f3 by the reviewer) |
| `b005-invite-audit.integration.test.ts` | 3/3 |
| `tenant-signed-pdf-download-audit.integration.test.ts` | 1/1 |
| `b031-session-hardening`, `auth`, `lease-create`, `property-owner`, `record-archive`, `team-invite-allowlist`, `tenant-payment-history` | 94/94, 18/18, 4/4, 1/1, 6/6, 7/7, 9/9 |
| `test:unit` | 994/994 |
| `copy:check` | 6/6 |
| `test:fn-priv` | PASS (full gate; anon execute zero) |
| typecheck / lint | PASS / 0 errors (15 existing warnings) |

Not run: full `test:rls` (serialized by the architect), browser, staging, any remote DB or network. No git mutations.

## Probe results (fix round 2)

Reviewer `rv2_b031a/probe.ts`, run unchanged against `condola_b031a` after this fix. **Write** = `app.b031_mask_text` (authoritative), **read** = `maskDetailText`; **OFF** = the unchanged `maskAuditText` the OFF page uses (shown for comparison only; it is not used for detail). The probe file contains 72 inputs. Invisible characters are shown as `U+XXXX`.

| # | Probe | Input | Write = read | Same | OFF page (unchanged) |
|---|---|---|---|---|---|
| 1 | slash phone | 0912/345/678 | •••••••••• | yes | 0912/345/678 |
| 2 | underscore phone | 0912_345_678 | •••••••••• | yes | 0912_345_678 |
| 3 | middot phone | 0912·345·678 | •••••••••• | yes | 0912·345·678 |
| 4 | U+2010 hyphen | 0912‐345‐678 | •••••••••• | yes | 0912‐345‐678 |
| 5 | U+2011 nb hyphen | 0912‑345‑678 | •••••••••• | yes | 0912‑345‑678 |
| 6 | en dash | 0912–345–678 | •••••••••• | yes | 0912–345–678 |
| 7 | em dash | 0912—345—678 | •••••••••• | yes | 0912—345—678 |
| 8 | fw hyphen | 0912－345－678 | •••••••••• | yes | 0912－345－678 |
| 9 | minus sign U+2212 | 0912−345−678 | •••••••••• | yes | 0912−345−678 |
| 10 | ideographic space | 0912`U+3000`345`U+3000`678 | •••••••••• | yes | 0912`U+3000`345`U+3000`678 |
| 11 | NBSP | 0912`U+00A0`345`U+00A0`678 | •••••••••• | yes | 0912`U+00A0`345`U+00A0`678 |
| 12 | ZWSP | 09`U+200B`12`U+200B`34`U+200B`56`U+200B`78 | •••••••••• | yes | 09`U+200B`12`U+200B`34`U+200B`56`U+200B`78 |
| 13 | ZWJ | 09`U+200D`1234`U+200D`5678 | •••••••••• | yes | 09`U+200D`1234`U+200D`5678 |
| 14 | soft hyphen | 0912`U+00AD`345`U+00AD`678 | •••••••••• | yes | 0912`U+00AD`345`U+00AD`678 |
| 15 | tab | 0912`U+0009`345`U+0009`678 | •••••••••• | yes | •••••••••• |
| 16 | comma | 0912,345,678 | •••••••••• | yes | 0912,345,678 |
| 17 | colon | 0912:345:678 | •••••••••• | yes | 0912:345:678 |
| 18 | mixed fw/hw | ０9１2３4５6７8 | •••••••••• | yes | ０9１2３4５6７8 |
| 19 | bank slash | 822/12/345678/9 | •••••••••• | yes | 822/12/345678/9 |
| 20 | bank en dash | 822–12–345678–9 | •••••••••• | yes | 822–12–345678–9 |
| 21 | card nbsp | 4111`U+00A0`1111`U+00A0`1111`U+00A0`1111 | •••••••••• | yes | 4111`U+00A0`1111`U+00A0`1111`U+00A0`1111 |
| 22 | card 3 spaces | 4111   1111   1111   1111 | •••••••••• | yes | 4111 1111 1111 1111 |
| 23 | card ideographic+hyphen | 4111`U+3000`-1111-1111-1111 | •••••••••• | yes | 4111`U+3000`-1111-1111-1111 |
| 24 | id slash | A/123456789 | A/•••••••••• | yes | A/123456789 |
| 25 | id double space | A  123456789 | A •••••••••• | yes | A 123456789 |
| 26 | id en dash | A–123–456–789 | A-•••••••••• | yes | A–123–456–789 |
| 27 | id lowercase | a123456789 | •••••••••• | yes | •••••••••• |
| 28 | id preceded by letters | IDA123456789 | •••••••••• | yes | ID•••••••••• |
| 29 | id NoA | NoA123456789 | •••••••••• | yes | No•••••••••• |
| 30 | id ZWSP | A1234`U+200B`56789 | •••••••••• | yes | A1234`U+200B`56789 |
| 31 | ARC new | A800000014 | •••••••••• | yes | •••••••••• |
| 32 | ARC old fw | ＡＢ１２３４５６７８ | •••••••••• | yes | ＡＢ１２３４５６７８ |
| 33 | ARC new spaced | A 8 0000 0014 | A •••••••••• | yes | A 8 0000 0014 |
| 34 | TW passport 9 | 護照 312345678 | 護照 •••••••••• | yes | 護照 312345678 |
| 35 | foreign passport | E12345678 | •••••••••• | yes | E12345678 |
| 36 | passport 2L7D | AB1234567 | •••••••••• | yes | AB1234567 |
| 37 | IBAN | GB82WEST12345698765432 | •••••••••• | yes | GB82WES••••••••••65432 |
| 38 | IBAN spaced | GB82 WEST 1234 5698 7654 32 | GB82 WEST •••••••••• | yes | GB82 WEST 1234 5698 7654 32 |
| 39 | LINE id | LINE: wang_1234 | LINE: •••••••••• | yes | LINE: wang_1234 |
| 40 | LINE id @ | @wang1234 | •••••••••• | yes | @wang1234 |
| 41 | JWT no digits | eyJhbGciOiJIUzIiJ.eyJzdWIiOiJhYmMifQ.abcdefghijklmnop | •••••••••• | yes | eyJhbGciOiJIUzIiJ.eyJzdWIiOiJhYmMifQ.abcdefghijklmnop |
| 42 | base64 letters only | QWxhZGRpbjpvcGVuIHNlc2FtZQ | •••••••••• | yes | QWxhZGRpbjpvcGVuIHNlc2FtZQ |
| 43 | email plus | wang+rent@gmail.com | •••••••••• | yes | •••••••••• |
| 44 | email unicode local | 王小明@gmail.com | •••••••••• | yes | 王小明@gmail.com |
| 45 | email unicode domain | wang@例子.台灣 | •••••••••• | yes | wang@例子.台灣 |
| 46 | email fw dot | ｗａｎｇ＠ｇｍａｉｌ．ｃｏｍ | •••••••••• | yes | ｗａｎｇ＠ｇｍａｉｌ．ｃｏｍ |
| 47 | email ideographic dot | wang@gmail。com | •••••••••• | yes | wang@gmail。com |
| 48 | email spaced at | wang @ gmail.com | •••••••••• | yes | wang @ gmail.com |
| 49 | email (at) | wang(at)gmail.com | •••••••••• | yes | wang(at)gmail.com |
| 50 | phone +886 spaces | +886 9 1234 5678 | •••••••••• | yes | •••••••••• |
| 51 | phone +886 (0) | +886 (0)912-345-678 | •••••••••• | yes | •••••••••• |
| 52 | phone 886 no plus | 886912345678 | •••••••••• | yes | 886912345678 |
| 53 | landline no area | 2345-6789 | •••••••••• | yes | 2345-6789 |
| 54 | landline ext | (02)2345-6789#123 | •••••••••• | yes | ••••••••••#123 |
| 55 | mobile 3 spaces | 0912   345   678 | •••••••••• | yes | 0912 345 678 |
| 56 | 9-digit bare | 帳號 123456789 | 帳號 •••••••••• | yes | 帳號 123456789 |
| 57 | post office acct | 0001234-0123456 | •••••••••• | yes | 0001234-0123456 |
| 58 | split field a | 0912 345 | 0912 345 | yes | 0912 345 |
| 59 | amount | 租金 25,000 元 | 租金 25,000 元 | yes | 租金 25,000 元 |
| 60 | amount NT$ | NT$1,250,000 | NT$1,250,000 | yes | NT$1,250,000 |
| 61 | two amounts | 租金 30000 33000 | 租金 30000 33000 | yes | 租金 30000 33000 |
| 62 | date | 2026-11-06 | 2026-11-06 | yes | 2026-11-06 |
| 63 | datetime | 租約於 2026-11-06 10:00 終止 | 租約於 2026-11-06 10:00 終止 | yes | 租約於 2026-11-06 10:00 終止 |
| 64 | two dates | 2026-11-06 2027-11-05 | 2026-11-06 2027-11-05 | yes | 2026-11-•••••••••• |
| 65 | date range | 2026-11-06 - 2027-11-05 | 2026-11-06 - 2027-11-05 | yes | 2026-11-06 - 2027-11-05 |
| 66 | unit label | 3F-2 | 3F-2 | yes | 3F-2 |
| 67 | address | 台北市信義區松仁路100號5樓之2 | 台北市信義區松仁路100號5樓之2 | yes | 台北市信義區松仁路100號5樓之2 |
| 68 | address zip | 110 台北市信義區信義路五段7號 89 樓 | 110 台北市信義區信義路五段7號 89 樓 | yes | 110 台北市信義區信義路五段7號 89 樓 |
| 69 | lease no | 合約編號 0012345678 | 合約編號 •••••••••• | yes | 合約編號 0012345678 |
| 70 | year month list | 2026 11 06 12 | •••••••••• | yes | 2026 11 06 12 |
| 71 | decimal | 0.5 個月 | 0.5 個月 | yes | 0.5 個月 |
| 72 | phone with combining | 0`U+0301`9`U+0301`1`U+0301`23456789 | •••••••••• | yes | 0`U+0301`9`U+0301`1`U+0301`23456789 |

Parity 72/72. Masked 60; readable 12 (`0912 345` is a 7-digit partial number and stays readable by design; dates, times, thousands-grouped amounts, two separate 5-digit amounts, unit labels, addresses and decimals stay readable). `2026 11 06 12` and `合約編號 0012345678` are masked (over-masking accepted: 8+ digits joined by single spaces between short groups).

### Fixture lists (`SENSITIVE_PROBES` S / `KEPT_PROBES` K, rounds 1 and 2)

| # | List | Input | Write = read | Same |
|---|---|---|---|---|
| 1 | S | 822-12-345678-9 | •••••••••• | yes |
| 2 | S | 8221 2345 6789 0123 | •••••••••• | yes |
| 3 | S | 4111-1111-1111-1111 | •••••••••• | yes |
| 4 | S | 4111 1111 1111 1111 | •••••••••• | yes |
| 5 | S | 012-345-678-901 | •••••••••• | yes |
| 6 | S | ０９１２３４５６７８ | •••••••••• | yes |
| 7 | S | Ａ１２３４５６７８９ | •••••••••• | yes |
| 8 | S | A 123 456 789 | A •••••••••• | yes |
| 9 | S | A1234-56789 | A•••••••••• | yes |
| 10 | S | A123456789 | •••••••••• | yes |
| 11 | S | A800000014 | •••••••••• | yes |
| 12 | S | AB12345678 | •••••••••• | yes |
| 13 | S | (02) 2345-6789 | •••••••••• | yes |
| 14 | S | 02-2345-6789 | •••••••••• | yes |
| 15 | S | (02)2345-6789 | •••••••••• | yes |
| 16 | S | 0912 345 678 | •••••••••• | yes |
| 17 | S | 0912-345-678 | •••••••••• | yes |
| 18 | S | 0912345678 | •••••••••• | yes |
| 19 | S | +886 912 345 678 | •••••••••• | yes |
| 20 | S | +886-2-2345-6789 | •••••••••• | yes |
| 21 | S | +886912345678 | •••••••••• | yes |
| 22 | S | ＋８８６９１２３４５６７８ | •••••••••• | yes |
| 23 | S | 9f8e7d6c5b4a3928170 | •••••••••• | yes |
| 24 | S | eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc | •••••••••• | yes |
| 25 | S | U4af4980629a1b2c3d4e5f60718293a4b | •••••••••• | yes |
| 26 | S | tok_9f8e7d6c5b4a39281706f5e4d3c2b1a0 | •••••••••• | yes |
| 27 | S | 0d6e1d3a-1111-4222-8333-444455556666 | •••••••••• | yes |
| 28 | S | wang＠gmail.com | •••••••••• | yes |
| 29 | S | wang@gmail.com | •••••••••• | yes |
| 30 | S | 0912/345/678 | •••••••••• | yes |
| 31 | S | 0912_345_678 | •••••••••• | yes |
| 32 | S | 0912·345·678 | •••••••••• | yes |
| 33 | S | 0912‐345‐678 | •••••••••• | yes |
| 34 | S | 0912‑345‑678 | •••••••••• | yes |
| 35 | S | 0912–345–678 | •••••••••• | yes |
| 36 | S | 0912—345—678 | •••••••••• | yes |
| 37 | S | 0912－345－678 | •••••••••• | yes |
| 38 | S | 0912−345−678 | •••••••••• | yes |
| 39 | S | 0912`U+3000`345`U+3000`678 | •••••••••• | yes |
| 40 | S | 0912`U+00A0`345`U+00A0`678 | •••••••••• | yes |
| 41 | S | 09`U+200B`12`U+200B`34`U+200B`56`U+200B`78 | •••••••••• | yes |
| 42 | S | 09`U+200D`1234`U+200D`5678 | •••••••••• | yes |
| 43 | S | 0912`U+00AD`345`U+00AD`678 | •••••••••• | yes |
| 44 | S | 0912`U+0009`345`U+0009`678 | •••••••••• | yes |
| 45 | S | 0912,345,678 | •••••••••• | yes |
| 46 | S | 0912:345:678 | •••••••••• | yes |
| 47 | S | ０9１2３4５6７8 | •••••••••• | yes |
| 48 | S | 822/12/345678/9 | •••••••••• | yes |
| 49 | S | 822–12–345678–9 | •••••••••• | yes |
| 50 | S | 4111`U+00A0`1111`U+00A0`1111`U+00A0`1111 | •••••••••• | yes |
| 51 | S | 4111   1111   1111   1111 | •••••••••• | yes |
| 52 | S | 4111`U+3000`-1111-1111-1111 | •••••••••• | yes |
| 53 | S | A/123456789 | A/•••••••••• | yes |
| 54 | S | A  123456789 | A •••••••••• | yes |
| 55 | S | A–123–456–789 | A-•••••••••• | yes |
| 56 | S | a123456789 | •••••••••• | yes |
| 57 | S | IDA123456789 | •••••••••• | yes |
| 58 | S | NoA123456789 | •••••••••• | yes |
| 59 | S | A1234`U+200B`56789 | •••••••••• | yes |
| 60 | S | ＡＢ１２３４５６７８ | •••••••••• | yes |
| 61 | S | A 8 0000 0014 | A •••••••••• | yes |
| 62 | S | 護照 312345678 | 護照 •••••••••• | yes |
| 63 | S | E12345678 | •••••••••• | yes |
| 64 | S | GB82WEST12345698765432 | •••••••••• | yes |
| 65 | S | GB82 WEST 1234 5698 7654 32 | GB82 WEST •••••••••• | yes |
| 66 | S | LINE: wang_1234 | LINE: •••••••••• | yes |
| 67 | S | @wang1234 | •••••••••• | yes |
| 68 | S | eyJhbGciOiJIUzIiJ.eyJzdWIiOiJhYmMifQ.abcdefghijklmnop | •••••••••• | yes |
| 69 | S | QWxhZGRpbjpvcGVuIHNlc2FtZQ | •••••••••• | yes |
| 70 | S | wang+rent@gmail.com | •••••••••• | yes |
| 71 | S | 王小明@gmail.com | •••••••••• | yes |
| 72 | S | wang@例子.台灣 | •••••••••• | yes |
| 73 | S | ｗａｎｇ＠ｇｍａｉｌ．ｃｏｍ | •••••••••• | yes |
| 74 | S | wang@gmail。com | •••••••••• | yes |
| 75 | S | wang @ gmail.com | •••••••••• | yes |
| 76 | S | wang(at)gmail.com | •••••••••• | yes |
| 77 | S | +886 9 1234 5678 | •••••••••• | yes |
| 78 | S | +886 (0)912-345-678 | •••••••••• | yes |
| 79 | S | (02)2345-6789#123 | •••••••••• | yes |
| 80 | S | 0912   345   678 | •••••••••• | yes |
| 81 | S | 帳號 123456789 | 帳號 •••••••••• | yes |
| 82 | S | 0001234-0123456 | •••••••••• | yes |
| 83 | S | 合約編號 0012345678 | 合約編號 •••••••••• | yes |
| 84 | S | 2026 11 06 12 | •••••••••• | yes |
| 85 | S | 0`U+0301`9`U+0301`1`U+0301`23456789 | •••••••••• | yes |
| 86 | K | tenant_directory_contact_edit | tenant_directory_contact_edit | yes |
| 87 | K | owner_repair_override_value | owner_repair_override_value | yes |
| 88 | K | 確認登記電費 | 確認登記電費 | yes |
| 89 | K | 同期分攤改由新草稿取代 | 同期分攤改由新草稿取代 | yes |
| 90 | K | Supercalifragilisticexpialidocious Ltd | Supercalifragilisticexpialidocious Ltd | yes |
| 91 | K | 陳先生（屋主）同意，門牌 100 號 3F-1 | 陳先生(屋主)同意,門牌 100 號 3F-1 | yes |
| 92 | K | 租金 30000 改 33000，2026-01-05 起 | 租金 30000 改 33000,2026-01-05 起 | yes |
| 93 | K | coast-only-marker | coast-only-marker | yes |
| 94 | K | Morgan Lee | Morgan Lee | yes |
| 95 | K | 物業經理 | 物業經理 | yes |
| 96 | K | 租金 25,000 元 | 租金 25,000 元 | yes |
| 97 | K | NT$1,250,000 | NT$1,250,000 | yes |
| 98 | K | 租金 30000 33000 | 租金 30000 33000 | yes |
| 99 | K | 2026-11-06 | 2026-11-06 | yes |
| 100 | K | 租約於 2026-11-06 10:00 終止 | 租約於 2026-11-06 10:00 終止 | yes |
| 101 | K | 2026-11-06 2027-11-05 | 2026-11-06 2027-11-05 | yes |
| 102 | K | 2026-11-06 - 2027-11-05 | 2026-11-06 - 2027-11-05 | yes |
| 103 | K | 3F-2 | 3F-2 | yes |
| 104 | K | 台北市信義區松仁路100號5樓之2 | 台北市信義區松仁路100號5樓之2 | yes |
| 105 | K | 110 台北市信義區信義路五段7號 89 樓 | 110 台北市信義區信義路五段7號 89 樓 | yes |
| 106 | K | 0.5 個月 | 0.5 個月 | yes |

Parity 106/106.

Reviewer `rv2_b031a/e2e.ts` (unchanged) stored reasons: `卡號 ••••••••••`, `帳戶 ••••••••••`, `手機 ••••••••••`,
`身分證 A-••••••••••`, `信箱 ••••••••••` (×2), `手機 ••••••••••`, `護照 ••••••••••`; the rendered 原因 lines match.
Reviewer `perf.sh` (100,000-character inputs): every pattern ≤ 11.2 ms; worst extra pattern tried (`1字` ×50,000) 21.4 ms.

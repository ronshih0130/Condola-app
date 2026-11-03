# B-015 workflow A10 independent source verdict

**GO for focused EN390 verification on a clean immutable candidate.** A10 corrects the full set of financial inputs for the fixture that expects no owner charge or credit. One test file changed. No product code or formula changed. Recorded 2026-11-03T01:59:11-08:00, QA log `f8f9d3ab-f67a-47af-8b5d-78ddcb5c4e5a`, coordinator ownership `3099AC86-6AF0-4681-9944-304E930BFDC2`. Independent Astra/high requested; actual runtime identity unobservable.

**Why the two previous tests failed.** R3 corrected the room reading without correcting the main reading. The resulting −5 kWh difference correctly produced an owner credit. On R4 `1c43f48`, the main reading was corrected. The saved read-only EN390 observation verifies total 25 kWh, public amount zero, bill 8,000 minor units, bill gap −2,000, and a room reading of 10→35 for 25 kWh. Here the owner credit came from the unchanged 80 TWD bill against a 100 TWD tenant charge. Only the single focused EN390 case failed on R4; the other three browser cases, gate, build and readback did not run. Neither failure has been waived.

| Form or source input | Restored original | Submitted correction |
|---|---:|---:|
| Source/subjects | Exact original run, unit, January 2090 period, room and ended tenant lease | Same stored identifiers and payer |
| Currency and rate | TWD, 4 per kWh | TWD, 4 per kWh (400 minor per kWh) |
| Previous → current room meter | 10 → 30 | 10 → 35 |
| Room consumption | 20 kWh | 25 kWh |
| Main consumption | 20 kWh | 25 kWh |
| Bill amount | 80 TWD | 100 TWD |

The form's hidden unit/period/run and space identities are preserved. In the server action, present previous/current endpoints take precedence over the fallback direct kWh field, giving 35−10 = 25. This is a single tenant-bearing submeter, not an even split. The main-minus-room component is zero. The 25 kWh × 4 TWD tenant share is exactly 100 TWD, with no rounding remainder. Bill gap is therefore 10,000−10,000−0 = zero minor units. The single tenant invoice and receivable each increase by 2,000. The calculation does not rely on an assumed bill derived from the meter reading: the normal form submits the corrected bill explicitly.

The revised fixture asserts the initially displayed rate and bill, updates the bill along with main/room values, and then checks the actual posted source row, joined bill and stored inputs. It verifies TWD, rate 400 minor, usage 25, bill 10,000 minor, stored rate 4, total kWh 25, and three zeros for public usage, public amount and bill gap. Earlier assertions still require the original tenant/payer and allocation ID, the replacement posting linked to that allocation, no net owner expense, the 2,000 delta, and replay leaving the entire captured financial state unchanged. The retry uses the same posted run and restored readings/bill; the tests have not passed merely because this input trace is coherent.

All 150 literals matched before review and at close. Compact sorted map `a9c4ef76d3affdad32be00749e8a3c3778bd75b2e586b7d0fbeb702b6c7bc16b`. Sole changed blob `e2e/b015-archive-workflow.spec.ts` `e26a9f4eee431eaa353f274d3463c465e50a38f5`. The three a6 full helpers match declared hashes and byte-normalize to the previously reviewed a5 helpers after only the helper/freeze name changes. Their strict disposable browser target and exact-source safeguards remain. Independently rehashed all 169 R4 snapshot bindings under manifest `53506b11bab8a403a3deb53c659a5b8d7379c63815e370d496b4b1f6593832fa`. The separate observation describes only the actual EN390 failed case.

Check the next immutable Git candidate against this map and run EN390 focus first. Only a passing focus permits full gate, builds/preflight/Worker, all four journeys and control readback. No tests, SQL, DB, builds or browsers were run by this reviewer. Full B-015, hosted safety, staging, pilot and release acceptance are outside this source verdict.

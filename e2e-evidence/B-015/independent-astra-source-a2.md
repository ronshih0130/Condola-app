# B-015 revised archive guard source verdict

**GO for freezing and testing the bounded fresh-lease ancestry guard.** All four findings from the initial source NO-GO are addressed in the reviewed source. Independent Astra/high requested, runtime model identity unobservable. Review 2026-11-02T19:42:13-08:00 under ownership 3099AC86-6AF0-4681-9944-304E930BFDC2, baseline `cf86d61cfe1ea91d2e032e68a535eeb325a74b9e`. No runtime check was run by this review.

| Source | Reviewed Git blob |
|---|---|
| `src/server/domain.ts` | `d3be211639308e7667fe21a50bd55f28dfd963f6` |
| `src/server/queries.ts` | `20a388b494153c65bad700755cf3456d33fa4a46` |
| `src/server/lease-target.ts` | `fd99d1e26fe134e58edbe17d4e3ad3b8a7a8a85d` |
| `src/server/lease-create-archive.integration.test.ts` | `9a974d83763b8bc02efd86d3538714d9a472437e` |
| `e2e/b015-archive-guard.spec.ts` | `3cbc831873d0a12042c5e6a5550b45f08485469d` |
| `e2e/b015-archive-guard-private-playwright.config.ts` | `1d08460673793fbac45dbe2ab081a7bd4da7df8e` |
| `scripts/run-e2e.ts` | `cd4a8702b377525ba20fbcb02e1b9b039ba55b59` |
| `package.json` | `e99acc33fd5c59a316cd21d259b6f80664862027` |

The 72-entry current source map has compact sorted JSON SHA-256 `c0b88e010b9fc25a9c940149b935777fa8465b03f82c511b90426baaaf790e5c`. The 64 remaining paths matched baseline Git blobs. Independently rehashed all 10 archived initial source/report bindings in manifest `878452e1c129772158486a1c15e8b7a9e339c8ecfedbdf79987d7a26ba93b049`.

1. **Fresh target eligibility.** Preliminary discovery ranks only active, correctly scoped room/unit/property combinations in their applicable rental mode. A deliberately colliding archived or wrong-mode room cannot shadow an eligible whole unit. The fixture supplies hyphenless and braced UUID forms. Actual rows are reread and held FOR SHARE in property → unit → room order, with exact org, relation, mode and archive checks before tenant linking. Historical keyed/recent-pending returns remain upstream. The normal new-lease picker mirrors eligible ancestry.
2. **Lock-order evidence.** The observer refreshes its activity snapshot and matches current DB, exact blocker PID and query fragment. Ambiguity fails. The holder→create→archive chain is joined by the observed create PID. A bounded unrelated-property operation must succeed while the first lock is held. Jobs attach rejection observers immediately. Cleanup rolls back the holder and waits for all jobs with a bound, retaining primary and cleanup errors. The after hook alone owns clone teardown. The tests cover archive commit and rollback, existing tenant reuse and parent movement. Actual timing and database privileges await the gate.
3. **Browser assertions.** The test selects and checks the visible target by value and property label before capturing it. The wizard handles FlowError through the existing action, `errors.notFound` maps to `i_not_found`, and the two expected strings match the EN/zh-TW dictionaries. The API route returns HTTP 400 and `{ok:false,error:"errors.notFound"}` for that FlowError. Both surfaces require unchanged lease/contact/user/signature/invoice counts. Reloaded picker visibility, enabled state and an attached option precede the absence check. Page console, page errors, 5xx and external-request guards remain active. A Playwright APIRequestContext call is separate from the page console.
4. **Browser ownership.** Config and spec admit only the archive focus/browser name carrying a seven-character SHA prefix and bounded attempt, exact `B015_OWNED_DATABASE` match, explicit disposable marker, demo mode and 127.0.0.1:55435. The outside driver sets the exact ownership name. Gate, baseline, other B-015 feature and mismatched targets cannot pass the destructive reset entry guard.

All three outside helper hashes match the prior helper source GO. Setup `9c80e053916f3b45a8dbdf4c0805b4f78ed3d40b84abea7f7f82545c22966a86`. Driver `ae1f5f0966515324427ef21221564c70ea661594757afc468809286883a5d352`. Readback `5871ca1ec10dd33e9d49b07f6ecd8b9c47ae4d4f22cc7bffc4b4086a5c9a14ad`. Readback compares the existing tenant_directory_edit optional row and selected-org flags only. The guard itself is unflagged.

Verify the frozen map against the immutable candidate before execution. Actual user journeys and role/concurrency tests still need runtime evidence. Historical archive/restore, portal and file access, raw/older lease writers, policy after a later archive, whole B-015, staging, pilot and acceptance remain open. No DB, SQL parser, build, flag operation or repository mutation was used by this source review.

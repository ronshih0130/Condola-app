# B-028 current status

CANDIDATE_SHA: the commit that adds this file on feat/b-028-off-matrix-evidence (a file cannot embed its own SHA; see the PR head). Base: 8a388de (package 2).

Updated 2026-11-06 PT, branch `feat/b-028-off-matrix-evidence` (package 5, stacked on package 2 `8a388de`). **PENDING / local evidence only / whole item INCOMPLETE.**

- Packages 1–3 (delivery claims, six event producers, legacy/new fence) and package 5 (browser OFF matrix, local parent-lock measurement, this manifest) have local PASS evidence: [acceptance.md](acceptance.md).
- Open: add or verify a caller timeout on B-013 repair mutators (T0/PE; the production `submitEstimate` path sets none and waits unbounded behind a held parent row locally); renewal producer (deferred, needs a durable renewal operation); package 4 inherited B-013 actor/environment/photo/appointment enforcement; T0 rehearsal parent-lock reserve (only a local measurement exists); hosted/staging runs; independent QA, Class B and CEO acceptance.
- All committed and operational flags remain OFF; no migration in package 5; nothing sent; no hosted DB touched.

STOP POINT: package 5 implemented locally, uncommitted; next: Claude reviews, fills CANDIDATE_SHA and commits; owner: Claude (parent session).

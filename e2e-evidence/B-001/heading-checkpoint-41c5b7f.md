# B-001 signed-heading local checkpoint

Recorded 2026-10-30T15:56:54.814861-07:00. Candidate `41c5b7ff3c3a730308d4e31f3b4508df7a650055`, branch `mode-b-repair-override-prep`. **LOCAL_VERIFIED for this bounded fix; whole B-001 pending.**

The manager signing section now selects the same existing signed/pending key from the same tenant-signature status as its timeline. This fixes the misleading pending heading above an already signed timeline. The imported branch and all signing, authorization, activation, billing and legal/i18n text remain unchanged. Application delta is one line, blob `1e39c4ff208bf72c549caf31a3c81a0b45ce3dee`.

One existing utility-browser case scopes its signed-text assertion to the timeline, avoiding ambiguity with the corrected heading. Its financial assertions, tenant/countersign flow and session restoration remain; the other three cases are unchanged. That case also gets a bounded loopback request fence, no redirects on its two API POSTs, and a static safe catch. Test blob `5d170ae37b12b8da01e2f88b1c2d4981dd1fb09b`. No new repository test/config/helper was introduced.

Final exact-candidate checks: pinned gate **599 unit PASS; 359 RLS total, 358 PASS, 0 FAIL, exactly 1 previously Ron-approved lost-history SKIP**. Next build 17.943s; Cloudflare build 27.169s; unchanged original preflight with command-local GNU awk 3.306s; Worker 1 PASS. Reused private paper-browser suite **4 PASS in 49.7s**, eight synthetic screenshots at 390/1280. Affected utility case **1 PASS in 27.8s**. Root inspected manager390 and live1280: signed heading matches timeline, candidate footer present, no clipping. Signed state has runtime visual evidence; pending/null fallback and imported branch are source-reviewed only, not transition coverage.

[Manifest](heading-boundary-41c5b7f.json) SHA-256 `67546281843b6aadb764f37cfc582354ae45e029e308147f23ffae11e49e4e83` binds 46 local artifacts (31 current artifacts, 8 screenshots, 1 pre-body selection failure, 6 earlier-candidate logs) and 14 exact candidate source blobs. Initial leading-anchor grep selected zero tests before any body ran; corrected selection was verified using DB-free listing. Earlier `64c53c3` green checks remain dated history, not final approval. The manifest builder's stale copied log-prefix assertion was corrected to the actual B001 log prefix before generating evidence; no test/build result was changed.

Independent paper-clone readback: two versions, one current, one replacement link, one attributable tenant-download event; zero paper/tenant organization opt-ins, global OFF, owned test fault objects absent. Original missing global setting restored to absence. Present-row restoration remains source-only; ordinary org timestamps/audits/uploads advance. Test fault DDL is confined to disposable fixtures. No operational migration, persistent activation, prod access, main merge or external message.

Original G0–G5/§11.1, exact staging app/version, 24 cold starts/React #418, real receipt where required and independent Claude/Class B acceptance remain pending. The native reviewer does not replace Claude. Existing B004 old-code/rollback/staging requirements remain separate. No whole item newly done or release GO.

STOP POINT: local heading fix verified; next: publish/mirror this checkpoint, then B-005 source/evidence reconciliation; owner: Ron/Codex.

# B017 limited source foundation — review and freeze manifest

Status: **PARTIAL / NO-GO for integration, production or feature completion**. Isolated `work/mode-b-notification-producer-prep`, base `4e43104f45c3acf0dae76e40c7b577bd7ffb8ea6`. No real producers, provider sends or financial writer changes. The eight-family B028 scope remains open.

Git blob IDs:
- `supabase/migrations/20261031100217_b010_b028_source_foundation.sql`: `b20227bdfad7e07b77223bd60f8439ff9c3dd5e6`
- `src/server/notification-producer-source.integration.test.ts`: `78db4cc31a6cb5313dee405a08f7f057e8780b24`
- `src/server/notification-producer-upgrade.integration.test.ts`: `109bcffd0405e72fdced118d239ccd56bda9c56b`
- `src/server/notification-center.integration.test.ts`: `f9a202d26b869fe77613fc1e92dbf91746291bca`
- `e2e/b028-center-local.spec.ts`: `43ac4dad38ac10b633643cd0e1d31b66f442ce5c`

Independent native static review: scoped PASS on the five exact blobs; old 100215 behavior and limited typed-source/collision/recipient/ACL/parent-lock contract inspected. This is a source-review verdict, not independent execution, integration, producer coverage, staging or release approval. Coder evidence: Node 20 source/upgrade/center synthetic tests each 1/1 PASS, typecheck and lint PASS; sanitized logs in `work/B017-draft-evidence/`. Pre-17 event and recipient are inserted before migration and their identity/read access survive. Browser fixture reviewed but actual browser NOT_RUN on 17.

100216 local unfinished commit `7892cb5f80140e73f6f4fd979ff99437665ce93c` applied before this draft on an owned core89 clone; 17 applied and scoped source test passed. This is exploratory only; final reviewed 100216→100217 compatibility NOT_RUN. No template, staging or production DB modified.

Mandatory before integration/wiring: root-owned explicit reset cleanup for `app.b017_center_resolutions` before center rows and sources, then `app.b017_occurrences` and `app.b017_old_source_transactions` before B010/public parents; actual repeated reset and admission tests; production retention decision; final 100216 migration compatibility; actual synthetic 17 browser; concrete real-gateway mixed-oldwriter late-retry strategy; actual financial command/transition guard, parent/FK matrix, all real producers and channel policies with independent review. Payment-result email preference remains separate. Do not infer a channel catch-up or recipient backfill from a flag flip. Do not claim global deadlock freedom or real delivery. Source and center INSERTs must be separate awaited statements within the same transaction so trigger-derived provenance exists.

Evidence correction: early scaffold run did not contain the intended no-backfill/SET CONSTRAINTS cases, despite an earlier report. That is marked NOT_RUN in the earlier run; the assertions were subsequently added, inspected and run, as recorded in `work/B017-draft-evidence.md`.

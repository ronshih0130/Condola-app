# Actual immutable local commands

From the active worktree with reviewed pinned Node20.20.2/PG16 helpers. Each phase was awaited; fresh owned local clones, stripped ambient credentials and synthetic keys only. See13 actual receipts in the manifest.

```sh
python3 ../run-b011-comparison-final-check.py bb02a75d9440a20a067b9e6481a65b3a5bb78a83 a9 focus
python3 ../run-b011-comparison-final-check.py bb02a75d9440a20a067b9e6481a65b3a5bb78a83 a9 gate
python3 ../run-b011-comparison-final-check.py bb02a75d9440a20a067b9e6481a65b3a5bb78a83 a9 build
python3 ../run-b011-comparison-final-check.py bb02a75d9440a20a067b9e6481a65b3a5bb78a83 a9 browser
python3 ../run-b011-comparison-final-check.py bb02a75d9440a20a067b9e6481a65b3a5bb78a83 a9 baseline
python3 ../b011-comparison-control-readback.py bb02a75d9440a20a067b9e6481a65b3a5bb78a83 a9
```

Focus selected1 and passed1; its3 other cases NOTRUN. Fullbrowser independently selected/passed4 with32captures. Standardgate only, not --release/all-repository browser/other-machine/Depot/staging. Originalpreflight unchanged. Earlier failures and separate a8 SELECT diagnostic remain preserved, not rerun as passes. No proposed SQL execution.

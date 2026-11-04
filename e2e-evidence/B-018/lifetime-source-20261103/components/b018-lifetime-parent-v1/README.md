# B018 parent source preparation

Work in progress. No parent run is authorized or implemented by this folder alone.

`owned.py` is the bounded filesystem/child-process component. It performs no work on import. It publishes exact immutable owner-only JSON, rejects ambiguous JSON and tracks separate child sessions with finite waits and explicit group-drain receipts. The original code-only gate candidate remains 1c8fd07; checkpoint b5c15b9 preserves byte-identical application source and inactive source artifacts.

The full controller still needs concrete archive/dependency materialization, actual clone/seed/CAS/deterministic-contact-fixture receipts, pre-baseline marker and independent readback, source-locked server launch, live map and browser/guard/producer orchestration, private IPC, natural observer exit, post-drain recovery and final independent replay. This component does not invent those facts or execute a migration. A forced child stop cannot count as a natural observer exit. Detached Chromium ownership must be tracked separately or explicitly remain unknown; the Node process group is insufficient.

All commands and log contents must come from separately reviewed source-pinned programs. Private keys/session envelopes use inherited private pipes, never arguments, environment logging or public receipts. No production or staging secrets enter this local-only diagnostic. The complete controller and this component require independent source review and a fresh execution lock before any use. No process, browser, socket, HTTP or database was launched here.

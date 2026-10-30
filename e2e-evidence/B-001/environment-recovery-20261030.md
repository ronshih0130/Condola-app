# Local verification recovery

Recorded 2026-10-30T13:34:59-07:00. Earlier raw failures are retained in [manifest](simulation-boundary-9fe0e4a.json); none were converted into passes.

An ENOSPC incident interrupted the browser batch and stopped the existing local PostgreSQL service. Original preflight printed PASS/exit0 while reporting an internal here-document failure, so that attempt is **INVALID**, and Worker did not start. Root cancelled the affected browser safely, preserved logs/traces, reclaimed only inactive goal-owned dependency/build caches and the stopped current Next cache, and restarted the existing PG16.15 cluster on loopback55435. No migration, reinitialization, staging write or unrelated service shutdown occurred. Final tests use new disposable clones of the existing prepared schema.

Inactive dependency/build caches were removed from bank, billing, browser-followups, e-sign-completion, e-sign-activation, import-region, import-QA, onboarding, payee and reminders prep worktrees; source and evidence remain. Reinstall pinned dependencies before reusing those worktrees. The current worktree retains its own nonsymlinked dependencies. Free space recovered to approximately11GiB at final browser completion.

Optional Homebrew GNU awk5.4.1 runs only the original preflight child through command-local PATH; no shell profile or repository script was changed. [Fourteen paired fixtures](preflight-awk-comparison.json) match the real system/GNU exit, stdout and stderr, including actual failure reasons inspected independently. Original script SHA256 `7c4a336fc33172efc8e0b736ac4930923801b776b3bd5d79240613b3b2f195cb`. Final real-bundle preflight completed exit0/PREFLIGHT PASS/no internal error in3.861s. This scoped compatibility experiment does not establish every possible parser input or authorize a deployment.

The later response.finished timeout was a separate observed browser-test wait failure despite successful redirect headers and a committed confirmed payment. The replacement verifies exact HTTP submit plus actual scoped payment before navigation, then original UI/bank/finance/task checks. No general transport diagnosis or application fix is claimed.

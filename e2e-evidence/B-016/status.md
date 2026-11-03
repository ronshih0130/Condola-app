# B016 canonical identity security code checkpoint

2026-11-03T08:50:34.524338-08:00; tested `f6593cedb0cd19aac879fe59d3bf911f1ca5bbc3`.

**CODE_GATE_GO / BROWSER_FAIL_PENDING / WHOLE_B016_INCOMPLETE / RELEASE_NO_GO.**

Both session identity projections now use only confirmed Auth email. A user-editable profile email cannot supply email-based platform authority. The configured-hosted allowlist/grants/exploitability were not tested. This is a conditional source-level security correction, not the verified-email-change feature.

The clean code gate passed: 630/630 unit tests and 467/468 RLS tests, zero failures; the sole skip is the previously approved lost b888ccd historical fixture. Eleven gate steps and three drained child processes passed. The exact 1014 source pins matched the earlier identity1 + consent/security36 target PASS. [Gate](identity-code-gate-f6593ce.md), [independent review](b016-identity-code-checkpoint-astra-f6593ce.md), [immutable evidence](identity-code-runtime-f6593ce.json).

Browser remains failed and pending: v2 eight request failures of unknown causes; v3 seed setup failed before any cases; v4 hung during first enhanced login and was safely interrupted with browser130/recovery0/server0/drained groups, zero completed cases. Its two fetch cancellations have no established cause. Playwright observer liveness defect is source-proven; it does not prove harmless cancellation or broken product login. Earlier behavioral checks do not waive these failures. Missing-consent fallback dispatch and full current browser matrix are UNVERIFIED. No build/release checks ran on this SHA.

Next browser approach: bounded enhanced-login-only observation and an independent normal native form control, retaining failed requests as failures. The incomplete v5 draft was stopped by a tool content flag, preserved, and has no execution GO. Do not run it.

Prior self-name checkpoint5a0c699 remains a separately bounded historical local GO. Regional company proposed SQL is source-reviewed but UNPARSED/UNAPPLIED/TARGET_UNVERIFIED/NOT_APPLY_READY pending PE evidence. Verified-email provider workflow/config/coherence and Ron policy decisions, versioned management fees, staging/Claude/ClassB/pilot/release remain incomplete. No whole B newly done; all39 retained, no B017 source.

STOP POINT: WORKING; next: authorized branch publication/renew/mirror/direct-ref readback, then independent B016 work with browser gap explicit; owner: Ron/Codex3099AC86. Publication readback will be recorded outside at work/b016-identity-code-publish-v1.json; absence is not publication evidence.

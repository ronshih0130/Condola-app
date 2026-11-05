# B010 flags-ON window

Target sandbox: `961b353f-7dac-43d9-9ff7-19eb1ceb5b84`; live twin: `161871b3-1041-44c9-aa10-e4812cc9a4c9`.

1. Drain payment and reminder writers before enabling flags. Inspect `pg_stat_activity` for other non-idle sessions touching `payments` or `email_log`; abort the window if any remain. Keep writers paused throughout acceptance.
2. Prohibit DDL throughout the window, including migrations and maintenance that acquires conflicting relation locks. The approximately six-second polling budget covers explicit B010 locks. Implicit statement locks can wait independently.
3. Have the harness enable both `payment_results_v2` and `rent_reminders_v2`: organization `feature_flags` bits must be true, and corresponding `platform_settings.value` objects must have `enabled: true` and include the sandbox UUID in `allowed_org_ids`. The acceptance script does not toggle flags.
4. Run `OUT=/secure/evidence/b010 bash scripts/b010-staging-accept.sh`. Require PASS for drain and S1–S4. S2 must report SQLSTATE `55P03` around six seconds; S3 must succeed after release; S4 must show no `40P01`. Retain sanitized JSON evidence and elapsed times.
5. C2 evidence is the integration test named `C2 runbook evidence: implicit payments relation lock waits until DDL-like holder releases`. With flags ON in its disposable database, an `ACCESS EXCLUSIVE` holder blocks the payment statement until release or a lock timeout. This demonstrates why explicit polling does not make concurrent DDL safe. Do not reproduce this DDL-like lock on staging.
6. Rollback means flags OFF: the harness disables both organization bits and both global switches, then performs S5 OFF verification. Wait for acceptance sessions to finish and roll back before changing flags. Confirm OFF before resuming legacy writers.

Every acceptance mutation runs inside `BEGIN … ROLLBACK`. Successful payment statements exercise triggers without committing incomplete financial transitions. Reminder claims are local and rolled back; no transport is invoked.

These files define acceptance evidence; they do not establish that the tests have been executed successfully.

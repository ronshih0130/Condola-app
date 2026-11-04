# Correction for the 9ce4a168 RLS log

`e2e-evidence/B-004/gate-9ce4a168d5482ae1afb3189624ddd1b2c50fbf38-rls.log` is a raw log. Its bytes stay as they were when the file was committed at `4da595094dcc53900e6d4e4cfb2b69f33d80cce4`. Commit `9ce4a168d5482ae1afb3189624ddd1b2c50fbf38` did not contain this file. A later edit of the file was reverted.

The skip line in that log says historical commit `b888ccd` was CEO approved. That sentence is false. The skip is UNAPPROVED. It is the lost identity-document upgrade of `20261022180000_tenant_id_check.sql`, not a paper-delivery waiver and not an approval.

The test skip text says UNAPPROVED. New gate runs are new files. This note is the correction. The raw log is not rewritten.

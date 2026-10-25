-- Version 20261020140000.
-- Auth events keep an action type. Only Admins can read the audit log.

ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS event_type text;

DROP POLICY IF EXISTS audit_read ON audit_log;
CREATE POLICY audit_read ON audit_log FOR SELECT TO authenticated
  USING (app.has_role(org_id, '{admin}'));

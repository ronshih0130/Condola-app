-- Version 20261026120000.
-- Transactional email log, password-reset rate limit, and org mail contact.
--
-- Additive only. Older Workers do not read these objects.
-- New columns have defaults or are nullable, so existing INSERT statements
-- keep working. Nothing is dropped, renamed, or retyped.
-- email_log and password_reset_attempts are server-only. anon and
-- authenticated have no privileges. The table owner (the migration role)
-- and service_role bypass that for the cron job and the reset action.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS contact_email citext,
  ADD COLUMN IF NOT EXISTS contact_phone text;

ALTER TABLE org_members
  ADD COLUMN IF NOT EXISTS email_prefs jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS email_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid REFERENCES organizations(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN (
                'lease_expiry_admin',
                'lease_expiry_tenant',
                'rent_overdue_admin',
                'rent_overdue_tenant',
                'password_reset'
              )),
  target_id   uuid NOT NULL,
  threshold   smallint NOT NULL,
  message_id  text,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (kind = 'password_reset' AND threshold = 0)
    OR (kind <> 'password_reset' AND org_id IS NOT NULL AND threshold > 0)
  )
);

-- One reminder per org, kind, target, and threshold. Password resets are
-- repeatable, so they stay out of this index. message_id is filled after
-- Cloudflare Email Sending (or Brevo or Resend) accepts the message.
CREATE UNIQUE INDEX IF NOT EXISTS email_log_once
  ON email_log (org_id, kind, target_id, threshold)
  WHERE kind <> 'password_reset';

CREATE INDEX IF NOT EXISTS email_log_sent_idx ON email_log (sent_at);

ALTER TABLE email_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE email_log FROM PUBLIC;
REVOKE ALL ON TABLE email_log FROM anon;
REVOKE ALL ON TABLE email_log FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE email_log TO service_role;

CREATE TABLE IF NOT EXISTS password_reset_attempts (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email_key  text NOT NULL,
  ip_key     text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS password_reset_attempts_email_idx
  ON password_reset_attempts (email_key, created_at);
CREATE INDEX IF NOT EXISTS password_reset_attempts_ip_idx
  ON password_reset_attempts (ip_key, created_at);

ALTER TABLE password_reset_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE password_reset_attempts FROM PUBLIC;
REVOKE ALL ON TABLE password_reset_attempts FROM anon;
REVOKE ALL ON TABLE password_reset_attempts FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE password_reset_attempts TO service_role;

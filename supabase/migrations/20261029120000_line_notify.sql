-- Version 20261029120000.
-- LINE notify: one-time link codes, per-tenant opt-out, and a delivery log.
--
-- Additive only. Older Workers do not read these objects.
-- New columns have defaults or are nullable, so existing INSERT statements
-- keep working. Nothing is dropped, renamed, or retyped.
-- Secrets stay in LINE_CHANNEL_SECRET and LINE_CHANNEL_ACCESS_TOKEN.
-- These tables do not store either value.
-- line_link_codes and line_delivery_log are server-only. anon and
-- authenticated have no privileges.

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS line_notify_opt_out boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS line_link_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id  uuid NOT NULL,
  code        text NOT NULL CHECK (code ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$'),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, contact_id) REFERENCES contacts(org_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS line_link_codes_active
  ON line_link_codes (code)
  WHERE used_at IS NULL;

CREATE INDEX IF NOT EXISTS line_link_codes_contact_idx
  ON line_link_codes (contact_id, created_at DESC);

CREATE TABLE IF NOT EXISTS line_delivery_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id          uuid NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('rent_reminder', 'payment_recorded')),
  target_id           uuid NOT NULL,
  line_user_id        text,
  body                text NOT NULL,
  status              text NOT NULL CHECK (status IN ('queued', 'sent', 'failed', 'skipped')),
  attempt             smallint NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  provider_message_id text,
  error               text,
  next_retry_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz,
  FOREIGN KEY (org_id, contact_id) REFERENCES contacts(org_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS line_delivery_log_once
  ON line_delivery_log (org_id, kind, target_id, contact_id);

CREATE INDEX IF NOT EXISTS line_delivery_log_retry
  ON line_delivery_log (next_retry_at)
  WHERE status = 'failed';

ALTER TABLE line_link_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE line_link_codes FROM PUBLIC;
REVOKE ALL ON TABLE line_link_codes FROM anon;
REVOKE ALL ON TABLE line_link_codes FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE line_link_codes TO service_role;

ALTER TABLE line_delivery_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE line_delivery_log FROM PUBLIC;
REVOKE ALL ON TABLE line_delivery_log FROM anon;
REVOKE ALL ON TABLE line_delivery_log FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE line_delivery_log TO service_role;

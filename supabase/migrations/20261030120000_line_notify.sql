-- Version 20261030120000.
-- LINE notify: staff link codes, per-user LINE preferences, and a delivery log.
--
-- Additive only. Older Workers do not read these objects.
-- New columns have defaults or are nullable, so existing INSERT statements
-- keep working. Nothing is dropped, renamed, or retyped.
-- Secrets stay in LINE_CHANNEL_SECRET and LINE_CHANNEL_ACCESS_TOKEN.
-- These tables do not store either value.
-- This file creates no function. anon and authenticated have no privileges.

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS line_notify_opt_out boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS line_link_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL,
  code        text NOT NULL CHECK (code ~ '^[0-9]{6}$'),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS line_link_codes_active
  ON line_link_codes (code)
  WHERE used_at IS NULL;

CREATE INDEX IF NOT EXISTS line_link_codes_user_idx
  ON line_link_codes (org_id, user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS line_user_links (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL,
  line_user_id  text CHECK (line_user_id IS NULL OR line_user_id ~ '^U[0-9a-f]{32}$'),
  status        text NOT NULL CHECK (status IN ('linked', 'unlinked', 'blocked')),
  linked_at     timestamptz,
  blocked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'linked' OR (line_user_id IS NOT NULL AND linked_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS line_user_links_active
  ON line_user_links (org_id, user_id)
  WHERE status = 'linked';

CREATE UNIQUE INDEX IF NOT EXISTS line_user_links_line_user
  ON line_user_links (org_id, line_user_id)
  WHERE status = 'linked';

CREATE TABLE IF NOT EXISTS line_notify_prefs (
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL,
  event_type  text NOT NULL CHECK (event_type IN ('rent_due', 'rent_overdue', 'lease_expiry', 'repair', 'statement')),
  channel     text NOT NULL CHECK (channel IN ('email', 'inapp', 'line')),
  enabled     boolean NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id, event_type, channel)
);

CREATE TABLE IF NOT EXISTS line_delivery_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id          uuid,
  user_id             uuid,
  kind                text NOT NULL CHECK (kind IN (
                        'rent_reminder', 'payment_recorded', 'rent_due', 'rent_overdue',
                        'lease_expiry', 'repair', 'statement'
                      )),
  target_id           uuid NOT NULL,
  threshold           smallint NOT NULL DEFAULT 0,
  line_user_id        text,
  body                text NOT NULL,
  status              text NOT NULL CHECK (status IN ('queued', 'sent', 'failed', 'skipped')),
  attempt             smallint NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  provider_message_id text,
  error               text,
  next_retry_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz,
  CHECK (contact_id IS NOT NULL OR user_id IS NOT NULL),
  FOREIGN KEY (org_id, contact_id) REFERENCES contacts(org_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS line_delivery_log_once
  ON line_delivery_log (org_id, kind, target_id, contact_id)
  WHERE contact_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS line_delivery_log_user_once
  ON line_delivery_log (org_id, kind, target_id, user_id, threshold)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS line_delivery_log_retry
  ON line_delivery_log (next_retry_at)
  WHERE status = 'failed';

ALTER TABLE line_link_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE line_link_codes FROM PUBLIC;
REVOKE ALL ON TABLE line_link_codes FROM anon;
REVOKE ALL ON TABLE line_link_codes FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE line_link_codes TO service_role;

ALTER TABLE line_user_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE line_user_links FROM PUBLIC;
REVOKE ALL ON TABLE line_user_links FROM anon;
REVOKE ALL ON TABLE line_user_links FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE line_user_links TO service_role;

ALTER TABLE line_notify_prefs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE line_notify_prefs FROM PUBLIC;
REVOKE ALL ON TABLE line_notify_prefs FROM anon;
REVOKE ALL ON TABLE line_notify_prefs FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE line_notify_prefs TO service_role;

ALTER TABLE line_delivery_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE line_delivery_log FROM PUBLIC;
REVOKE ALL ON TABLE line_delivery_log FROM anon;
REVOKE ALL ON TABLE line_delivery_log FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE line_delivery_log TO service_role;

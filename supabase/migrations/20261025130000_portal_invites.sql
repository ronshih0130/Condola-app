-- Version 20261025130000.
-- One-time 租客 and 屋主 invite links.
--
-- The invitations table already stores owner and tenant links. This shortens
-- the default lifetime to 7 days, keeps a single unused link per contact, and
-- adds a server-only counter for repeated bad tokens.
-- anon and authenticated have no privileges on the new table.

ALTER TABLE invitations
  ALTER COLUMN expires_at SET DEFAULT (now() + interval '7 days');

WITH ranked AS (
  SELECT id,
         row_number() OVER (PARTITION BY contact_id ORDER BY created_at DESC, id DESC) AS n
    FROM invitations
   WHERE status = 'pending'
     AND kind IN ('owner', 'tenant')
     AND contact_id IS NOT NULL
)
UPDATE invitations
   SET status = 'revoked'
 WHERE id IN (SELECT id FROM ranked WHERE n > 1);

CREATE UNIQUE INDEX IF NOT EXISTS invitations_one_pending_portal
  ON invitations (contact_id)
  WHERE status = 'pending' AND kind IN ('owner', 'tenant');

CREATE TABLE IF NOT EXISTS portal_invite_attempts (
  ip            text PRIMARY KEY,
  failed_count  integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  locked_until  timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE portal_invite_attempts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE portal_invite_attempts FROM PUBLIC;
REVOKE ALL ON TABLE portal_invite_attempts FROM anon;
REVOKE ALL ON TABLE portal_invite_attempts FROM authenticated;

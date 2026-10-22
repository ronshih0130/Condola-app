-- Version 20261026190000.
-- Store the raw portal invite token so 複製邀請連結 can copy a still-valid
-- link again. invitations.code_hash stays the lookup key.
--
-- The filename is 20261026190000 so it does not collide with
-- 20261025160000_utility_run_draft_reuse.sql.
--
-- RLS is on and forced, with no policies. anon and authenticated have no
-- table privileges and no execute grant on these functions. service_role
-- (BYPASSRLS) is the only granted role. A secret is removed when its
-- invitation is accepted, revoked, or no longer unexpired.

CREATE TABLE IF NOT EXISTS portal_invite_secrets (
  invitation_id uuid PRIMARY KEY REFERENCES invitations(id) ON DELETE CASCADE,
  token         text NOT NULL CHECK (char_length(token) >= 32)
);

ALTER TABLE portal_invite_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_invite_secrets FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE portal_invite_secrets FROM PUBLIC;
REVOKE ALL ON TABLE portal_invite_secrets FROM anon;
REVOKE ALL ON TABLE portal_invite_secrets FROM authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE portal_invite_secrets TO service_role;
-- Drop the creator's default ACL entry so service_role is the only grantee.
-- The migration role is not assumed to be a superuser.
REVOKE ALL ON TABLE portal_invite_secrets FROM CURRENT_USER;

CREATE OR REPLACE FUNCTION app.drop_portal_invite_secret()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM 'pending' OR NEW.expires_at <= now() THEN
    DELETE FROM portal_invite_secrets WHERE invitation_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app.purge_portal_invite_secrets()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  DELETE FROM portal_invite_secrets s
  USING invitations i
  WHERE s.invitation_id = i.id
    AND (i.status <> 'pending' OR i.expires_at <= now());
$$;

REVOKE ALL ON FUNCTION app.drop_portal_invite_secret() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.drop_portal_invite_secret() FROM anon;
REVOKE ALL ON FUNCTION app.drop_portal_invite_secret() FROM authenticated;
REVOKE ALL ON FUNCTION app.purge_portal_invite_secrets() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.purge_portal_invite_secrets() FROM anon;
REVOKE ALL ON FUNCTION app.purge_portal_invite_secrets() FROM authenticated;
GRANT EXECUTE ON FUNCTION app.drop_portal_invite_secret() TO service_role;
GRANT EXECUTE ON FUNCTION app.purge_portal_invite_secrets() TO service_role;
-- The login role that applies migrations is the app connection. It has to fire
-- the trigger when it accepts, revokes, or changes expiry. anon and
-- authenticated stay revoked above.
GRANT EXECUTE ON FUNCTION app.drop_portal_invite_secret() TO CURRENT_USER;

DROP TRIGGER IF EXISTS portal_invite_secrets_drop ON invitations;
CREATE TRIGGER portal_invite_secrets_drop
  AFTER UPDATE OF status, expires_at ON invitations
  FOR EACH ROW
  EXECUTE FUNCTION app.drop_portal_invite_secret();

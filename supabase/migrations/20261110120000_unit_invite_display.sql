-- MGT-51-AC2 / TEN-29-AC1: raw-token display table for reprinting the live /join path.
-- Stores the live raw 43-char token so currentInvite can reprint the same /join/<token>;
-- listInvites must never return the raw token. Additive and safe when unit_line_invite is off.

CREATE TABLE IF NOT EXISTS app.unit_invite_display (
  secret_id uuid PRIMARY KEY REFERENCES app.unit_invite_secrets(id) ON DELETE CASCADE,
  token     text NOT NULL CHECK (char_length(token) = 43)
);
ALTER TABLE app.unit_invite_display ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.unit_invite_display FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE app.unit_invite_display FROM PUBLIC;
REVOKE ALL ON TABLE app.unit_invite_display FROM anon;
REVOKE ALL ON TABLE app.unit_invite_display FROM authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE app.unit_invite_display TO service_role;
REVOKE ALL ON TABLE app.unit_invite_display FROM CURRENT_USER;

CREATE OR REPLACE FUNCTION app.drop_unit_invite_display()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  DELETE FROM app.unit_invite_display WHERE secret_id = NEW.id;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.drop_unit_invite_display() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.drop_unit_invite_display() FROM anon;
REVOKE ALL ON FUNCTION app.drop_unit_invite_display() FROM authenticated;
GRANT EXECUTE ON FUNCTION app.drop_unit_invite_display() TO service_role;
GRANT EXECUTE ON FUNCTION app.drop_unit_invite_display() TO CURRENT_USER;

DROP TRIGGER IF EXISTS drop_unit_invite_display ON app.unit_invite_secrets;
CREATE TRIGGER drop_unit_invite_display
  AFTER UPDATE OF revoked_at ON app.unit_invite_secrets
  FOR EACH ROW
  WHEN (NEW.revoked_at IS NOT NULL)
  EXECUTE FUNCTION app.drop_unit_invite_display();

CREATE OR REPLACE FUNCTION app.unit_line_store_display(p_secret_id uuid, p_token text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF char_length(p_token) <> 43 THEN
    RAISE EXCEPTION 'invalid unit invite display token length: %', char_length(p_token);
  END IF;
  DELETE FROM app.unit_invite_display WHERE secret_id = p_secret_id;
  INSERT INTO app.unit_invite_display (secret_id, token)
  VALUES (p_secret_id, p_token);
END;
$$;
REVOKE ALL ON FUNCTION app.unit_line_store_display(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.unit_line_store_display(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION app.unit_line_store_display(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION app.unit_line_store_display(uuid, text) TO service_role;

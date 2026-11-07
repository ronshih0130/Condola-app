-- Version 20261107160000.
-- S3: API roles may not point a contact at an existing login.
--
-- team_write lets staff UPDATE contacts as authenticated, including user_id.
-- Portal invite acceptance trusts contacts.user_id as "this contact's own
-- login", so a direct write could aim an invite at someone else's login.
--
-- createLease still runs as authenticated and attaches a portal login it has
-- just provisioned in the same transaction (app.provision_portal_user sets
-- created_at = now()). That one write stays allowed: NULL -> a login created
-- in this transaction, with no password and no other contact. Every other
-- change to user_id by anon or authenticated is refused. service_role and
-- table owners (invite acceptance, seed) are unaffected.
--
-- current_user is the function owner inside SECURITY DEFINER, so the caller
-- comes from the role setting, falling back to session_user (as b009 does).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION app.s3_contacts_user_id_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_role text := coalesce(nullif(current_setting('role', true), 'none'), session_user::text);
BEGIN
  IF v_role NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.user_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.user_id IS NULL)
     AND EXISTS (
       SELECT 1 FROM auth.users u
        WHERE u.id = NEW.user_id
          AND u.created_at = now()
          AND (u.encrypted_password IS NULL OR btrim(u.encrypted_password) = '')
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.contacts c
        WHERE c.user_id = NEW.user_id AND c.id IS DISTINCT FROM NEW.id
     )
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'contacts.user_id is assigned by the server'
    USING ERRCODE = '42501';
END $$;
REVOKE ALL ON FUNCTION app.s3_contacts_user_id_guard() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS s3_contacts_user_id_guard ON public.contacts;
CREATE TRIGGER s3_contacts_user_id_guard
  BEFORE INSERT OR UPDATE OF user_id ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION app.s3_contacts_user_id_guard();

COMMIT;

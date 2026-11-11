-- 20261110110000_unit_line_invite_seat_cap.sql
-- B2: R-a8 5th-seat race + DB seat cap.
-- One live invite secret per unit, unit-row serialization on issue/rotate/accept/include,
-- and a database-level BEFORE trigger enforcing the 4-seat cap even on direct writes.

-- 1) Data cleanup: revoke extra live secrets (keep the newest per unit), then enforce one live secret per unit.
UPDATE app.unit_invite_secrets s
   SET revoked_at = now()
 WHERE s.revoked_at IS NULL
   AND EXISTS (
     SELECT 1 FROM app.unit_invite_secrets s2
      WHERE s2.org_id = s.org_id
        AND s2.unit_id = s.unit_id
        AND s2.revoked_at IS NULL
        AND (s2.created_at, s2.id) > (s.created_at, s.id)
   );

CREATE UNIQUE INDEX IF NOT EXISTS unit_invite_secrets_one_live_per_unit
  ON app.unit_invite_secrets (org_id, unit_id) WHERE revoked_at IS NULL;

-- 2) Issue + rotate: lock the unit row, revoke live secrets, insert the new secret.
CREATE OR REPLACE FUNCTION app.unit_line_issue(p_org uuid, p_unit uuid, p_hash text, p_issuer uuid)
  RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM 1 FROM public.units WHERE id = p_unit AND org_id = p_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  UPDATE app.unit_invite_secrets
     SET revoked_at = now()
   WHERE org_id = p_org AND unit_id = p_unit AND revoked_at IS NULL;
  INSERT INTO app.unit_invite_secrets(org_id, unit_id, token_hash, expires_at, issued_by)
  VALUES (p_org, p_unit, p_hash, now() + interval '14 days', p_issuer)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION app.unit_line_issue(uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.unit_line_issue(uuid, uuid, text, uuid) TO service_role;

CREATE OR REPLACE FUNCTION app.unit_line_rotate(p_org uuid, p_unit uuid, p_new_hash text, p_issuer uuid)
  RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM 1 FROM public.units WHERE id = p_unit AND org_id = p_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  UPDATE app.unit_invite_secrets
     SET revoked_at = now()
   WHERE org_id = p_org AND unit_id = p_unit AND revoked_at IS NULL;
  INSERT INTO app.unit_invite_secrets(org_id, unit_id, token_hash, expires_at, issued_by)
  VALUES (p_org, p_unit, p_new_hash, now() + interval '14 days', p_issuer)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION app.unit_line_rotate(uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.unit_line_rotate(uuid, uuid, text, uuid) TO service_role;

-- 3) Accept: lock unit row, lock+recheck the secret (LPQ-1), recount seats under the lock, then identity checks + insert.
CREATE OR REPLACE FUNCTION app.unit_line_accept(
  p_org uuid,
  p_unit uuid,
  p_hash text,
  p_user uuid,
  p_line_identity_hash text,
  p_display_name text DEFAULT NULL,
  p_entered_name text DEFAULT NULL,
  p_contact_id uuid DEFAULT NULL,
  p_ip text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_secret app.unit_invite_secrets%ROWTYPE;
  v_count int;
  v_id uuid;
BEGIN
  IF NOT app.unit_line_invite_on(p_org) THEN
    RAISE EXCEPTION 'flag_off';
  END IF;

  PERFORM 1 FROM public.units WHERE id = p_unit AND org_id = p_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  SELECT * INTO v_secret
    FROM app.unit_invite_secrets
   WHERE org_id = p_org AND unit_id = p_unit AND token_hash = p_hash
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_secret.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'revoked';
  END IF;
  IF v_secret.expires_at <= now() THEN
    RAISE EXCEPTION 'expired';
  END IF;

  SELECT count(*) INTO v_count
    FROM app.unit_bindings
   WHERE org_id = p_org AND unit_id = p_unit
     AND status IN ('pending','lease_linked');
  IF v_count >= 4 THEN
    RAISE EXCEPTION 'seat_cap';
  END IF;

  IF EXISTS (SELECT 1 FROM public.org_members m
              WHERE m.org_id = p_org AND m.user_id = p_user) THEN
    RAISE EXCEPTION 'identity_conflict';
  END IF;

  IF EXISTS (SELECT 1 FROM app.unit_bindings b
              WHERE b.line_identity_hash = p_line_identity_hash
                AND b.user_id <> p_user
                AND b.status IN ('pending','lease_linked')) THEN
    RAISE EXCEPTION 'identity_conflict';
  END IF;

  INSERT INTO app.unit_bindings(
    org_id, unit_id, contact_id, user_id, line_identity_hash,
    display_name, entered_name, status, created_ip)
  VALUES (
    p_org, p_unit, p_contact_id, p_user, p_line_identity_hash,
    p_display_name, p_entered_name, 'pending', p_ip)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION app.unit_line_accept(uuid, uuid, text, uuid, text, text, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.unit_line_accept(uuid, uuid, text, uuid, text, text, text, uuid, text) TO service_role;

-- 4) Include-on-lease: lock unit row, validate lease belongs to (org, unit), guard the seat cap, keep loop behavior.
CREATE OR REPLACE FUNCTION app.unit_line_include_on_lease(p_org uuid, p_lease uuid, p_unit uuid, p_binding_ids uuid[])
  RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  r record;
  v_count int;
BEGIN
  PERFORM 1 FROM public.units WHERE id = p_unit AND org_id = p_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  PERFORM 1 FROM public.leases
   WHERE id = p_lease AND org_id = p_org AND unit_id = p_unit;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  SELECT count(*) INTO v_count
    FROM app.unit_bindings
   WHERE org_id = p_org AND unit_id = p_unit
     AND status IN ('pending','lease_linked');
  IF v_count > 4 THEN
    RAISE EXCEPTION 'seat_cap';
  END IF;

  FOR r IN
    SELECT id, contact_id FROM app.unit_bindings
     WHERE org_id = p_org AND unit_id = p_unit
       AND status = 'pending'
       AND id = ANY(p_binding_ids)
  LOOP
    INSERT INTO public.lease_parties(org_id, lease_id, contact_id, role)
    VALUES (p_org, p_lease, r.contact_id, 'occupant');
    UPDATE app.unit_bindings
       SET status = 'lease_linked', lease_id = p_lease
     WHERE id = r.id;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION app.unit_line_include_on_lease(uuid, uuid, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.unit_line_include_on_lease(uuid, uuid, uuid, uuid[]) TO service_role;

-- 5) Database-level seat cap: BEFORE INSERT/UPDATE trigger on app.unit_bindings.
CREATE OR REPLACE FUNCTION app.unit_bindings_seat_cap_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_count int;
BEGIN
  IF NEW.status IN ('pending','lease_linked') THEN
    PERFORM 1 FROM public.units
     WHERE org_id = NEW.org_id AND id = NEW.unit_id FOR UPDATE;
    SELECT count(*) INTO v_count
      FROM app.unit_bindings
     WHERE org_id = NEW.org_id AND unit_id = NEW.unit_id
       AND status IN ('pending','lease_linked')
       AND id <> NEW.id;
    IF v_count >= 4 THEN
      RAISE EXCEPTION 'seat_cap';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.unit_bindings_seat_cap_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS unit_bindings_seat_cap_guard ON app.unit_bindings;
CREATE TRIGGER unit_bindings_seat_cap_guard
  BEFORE INSERT OR UPDATE OF status, org_id, unit_id ON app.unit_bindings
  FOR EACH ROW EXECUTE FUNCTION app.unit_bindings_seat_cap_guard();

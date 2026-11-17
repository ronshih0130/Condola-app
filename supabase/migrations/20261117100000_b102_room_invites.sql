-- 20261117100000_b102_room_invites.sql
-- B-102 INV-ROOM (MGT-147, Ron 2026-11-15 14:38 PT 「A 每間一個邀請」; design OQ-094).
-- A room-by-room unit can have one live invite PER ROOM. A tenant who accepts a room invite is bound to that room,
-- and the 4-seat cap counts per room for room bindings (per unit for unit bindings, unchanged).
-- Additive for every existing row: room_id is NULL on all current secrets and bindings, so every legacy path
-- (unit issue/rotate/accept/include, the seat-cap trigger) behaves exactly as before while no room secret exists.
-- Service-only, like the B2 invite functions: SECURITY DEFINER, search_path pinned, EXECUTE for service_role only.

-- 1) room_id on secrets and bindings; both FKs keep the room inside the same org AND the same unit.
ALTER TABLE app.unit_invite_secrets ADD COLUMN room_id uuid;
ALTER TABLE app.unit_invite_secrets
  ADD CONSTRAINT unit_invite_secrets_room_fk FOREIGN KEY (unit_id, room_id) REFERENCES public.rooms(unit_id, id),
  ADD CONSTRAINT unit_invite_secrets_room_org_fk FOREIGN KEY (org_id, room_id) REFERENCES public.rooms(org_id, id);
ALTER TABLE app.unit_bindings ADD COLUMN room_id uuid;
ALTER TABLE app.unit_bindings
  ADD CONSTRAINT unit_bindings_room_fk FOREIGN KEY (unit_id, room_id) REFERENCES public.rooms(unit_id, id),
  ADD CONSTRAINT unit_bindings_room_org_fk FOREIGN KEY (org_id, room_id) REFERENCES public.rooms(org_id, id);

-- 2) One live secret per unit (unit invites) and one per room (room invites).
DROP INDEX app.unit_invite_secrets_one_live_per_unit;
CREATE UNIQUE INDEX unit_invite_secrets_one_live_per_unit
  ON app.unit_invite_secrets (org_id, unit_id) WHERE revoked_at IS NULL AND room_id IS NULL;
CREATE UNIQUE INDEX unit_invite_secrets_one_live_per_room
  ON app.unit_invite_secrets (org_id, room_id) WHERE revoked_at IS NULL AND room_id IS NOT NULL;

-- 3) Unit issue/rotate: same signature, body and ACL, except they now revoke only the UNIT invite (room_id IS NULL),
--    never a room's. With no room secret present this is the previous behaviour.
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
   WHERE org_id = p_org AND unit_id = p_unit AND room_id IS NULL AND revoked_at IS NULL;
  INSERT INTO app.unit_invite_secrets(org_id, unit_id, token_hash, expires_at, issued_by)
  VALUES (p_org, p_unit, p_hash, now() + interval '14 days', p_issuer)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
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
   WHERE org_id = p_org AND unit_id = p_unit AND room_id IS NULL AND revoked_at IS NULL;
  INSERT INTO app.unit_invite_secrets(org_id, unit_id, token_hash, expires_at, issued_by)
  VALUES (p_org, p_unit, p_new_hash, now() + interval '14 days', p_issuer)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- 4) Room issue (also used to rotate): lock the unit, then the room. Only a live room of a by_room unit, and only
--    while unit_line_invite is ON for the org. Revokes that room's live secret, then inserts the new one.
CREATE FUNCTION app.unit_line_issue_room(p_org uuid, p_unit uuid, p_room uuid, p_hash text, p_issuer uuid)
  RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT app.unit_line_invite_on(p_org) THEN
    RAISE EXCEPTION 'flag_off';
  END IF;
  PERFORM 1 FROM public.units u
   WHERE u.id = p_unit AND u.org_id = p_org AND u.rental_mode = 'by_room' AND u.archived_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  PERFORM 1 FROM public.rooms r
   WHERE r.id = p_room AND r.org_id = p_org AND r.unit_id = p_unit AND r.archived_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  UPDATE app.unit_invite_secrets
     SET revoked_at = now()
   WHERE org_id = p_org AND room_id = p_room AND revoked_at IS NULL;
  INSERT INTO app.unit_invite_secrets(org_id, unit_id, room_id, token_hash, expires_at, issued_by)
  VALUES (p_org, p_unit, p_room, p_hash, now() + interval '14 days', p_issuer)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION app.unit_line_issue_room(uuid, uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.unit_line_issue_room(uuid, uuid, uuid, text, uuid) TO service_role;

-- 5) Accept: same signature. The secret decides the target: a room secret binds that room (room still live, unit
--    still by_room) and counts the seat cap over that room's bindings; a unit secret is unchanged.
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

  IF v_secret.room_id IS NOT NULL THEN
    PERFORM 1 FROM public.units u WHERE u.id = p_unit AND u.org_id = p_org AND u.rental_mode = 'by_room' AND u.archived_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'not_found';
    END IF;
    PERFORM 1 FROM public.rooms r
     WHERE r.id = v_secret.room_id AND r.org_id = p_org AND r.unit_id = p_unit AND r.archived_at IS NULL FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'not_found';
    END IF;
  END IF;

  SELECT count(*) INTO v_count
    FROM app.unit_bindings
   WHERE org_id = p_org AND unit_id = p_unit
     AND room_id IS NOT DISTINCT FROM v_secret.room_id
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
    org_id, unit_id, room_id, contact_id, user_id, line_identity_hash,
    display_name, entered_name, status, created_ip)
  VALUES (
    p_org, p_unit, v_secret.room_id, p_contact_id, p_user, p_line_identity_hash,
    p_display_name, p_entered_name, 'pending', p_ip)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- 6) Include-on-lease: same signature. A room binding joins only a lease that targets its room; asking for one on
--    any other lease of the unit is refused ('room_mismatch') before anything is written. Seat cap per group.
CREATE OR REPLACE FUNCTION app.unit_line_include_on_lease(p_org uuid, p_lease uuid, p_unit uuid, p_binding_ids uuid[])
  RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  r record;
  v_target_room uuid;
BEGIN
  PERFORM 1 FROM public.units WHERE id = p_unit AND org_id = p_org FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  SELECT l.target_room_id INTO v_target_room FROM public.leases l
   WHERE l.id = p_lease AND l.org_id = p_org AND l.unit_id = p_unit;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF EXISTS (SELECT 1 FROM app.unit_bindings b
              WHERE b.org_id = p_org AND b.unit_id = p_unit
                AND b.status IN ('pending','lease_linked')
              GROUP BY b.room_id HAVING count(*) > 4) THEN
    RAISE EXCEPTION 'seat_cap';
  END IF;

  IF EXISTS (SELECT 1 FROM app.unit_bindings b
              WHERE b.org_id = p_org AND b.unit_id = p_unit AND b.status = 'pending'
                AND b.id = ANY(p_binding_ids)
                AND b.room_id IS NOT NULL AND b.room_id IS DISTINCT FROM v_target_room) THEN
    RAISE EXCEPTION 'room_mismatch';
  END IF;

  FOR r IN
    SELECT id, contact_id FROM app.unit_bindings
     WHERE org_id = p_org AND unit_id = p_unit
       AND status = 'pending'
       AND id = ANY(p_binding_ids)
     ORDER BY id
  LOOP
    INSERT INTO public.lease_parties(org_id, lease_id, contact_id, role)
    VALUES (p_org, p_lease, r.contact_id, 'occupant');
    UPDATE app.unit_bindings
       SET status = 'lease_linked', lease_id = p_lease
     WHERE id = r.id;
  END LOOP;
END;
$$;

-- 7) DB seat cap: per room for room bindings, per unit for unit bindings. The trigger also fires on room_id changes.
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
       AND room_id IS NOT DISTINCT FROM NEW.room_id
       AND status IN ('pending','lease_linked')
       AND id <> NEW.id;
    IF v_count >= 4 THEN
      RAISE EXCEPTION 'seat_cap';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER unit_bindings_seat_cap_guard ON app.unit_bindings;
CREATE TRIGGER unit_bindings_seat_cap_guard
  BEFORE INSERT OR UPDATE OF status, org_id, unit_id, room_id ON app.unit_bindings
  FOR EACH ROW EXECUTE FUNCTION app.unit_bindings_seat_cap_guard();

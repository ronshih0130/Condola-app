-- Migration 20261110100000_unit_line_invite
-- Flag unit_line_invite (PE): OFF by default everywhere; hosted activation only
-- for Ron's 4 allowlisted internal orgs per CEO 2026-11-10 09:02 PT.

INSERT INTO platform_settings(key,value)
VALUES ('unit_line_invite','{"enabled":false,"allowed_org_ids":[]}'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE FUNCTION app.unit_line_invite_on(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.platform_settings f JOIN public.organizations o ON o.id = p_org
     WHERE f.key = 'unit_line_invite'
       AND jsonb_typeof(f.value) = 'object'
       AND f.value->'enabled' = 'true'::jsonb
       AND jsonb_typeof(f.value->'allowed_org_ids') = 'array'
       AND f.value->'allowed_org_ids' @> jsonb_build_array(p_org::text)
       AND jsonb_typeof(o.feature_flags) = 'object'
       AND o.feature_flags->'unit_line_invite' = 'true'::jsonb)
$$;
REVOKE ALL ON FUNCTION app.unit_line_invite_on(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.unit_line_invite_on(uuid) TO service_role;

CREATE TABLE app.unit_invite_secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  issued_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app.unit_invite_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.unit_invite_secrets FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.unit_invite_secrets FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.unit_invite_secrets TO service_role;

CREATE TABLE app.unit_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  contact_id uuid,
  user_id uuid NOT NULL,
  line_identity_hash text NOT NULL,
  display_name text,
  entered_name text,
  status text NOT NULL CHECK (status IN ('pending','lease_linked','unlinked')),
  lease_id uuid,
  bound_at timestamptz NOT NULL DEFAULT now(),
  unbound_at timestamptz,
  created_ip text
);
ALTER TABLE app.unit_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.unit_bindings FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.unit_bindings FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.unit_bindings TO service_role;

CREATE UNIQUE INDEX unit_bindings_active_uq
  ON app.unit_bindings (org_id, unit_id, user_id)
  WHERE status IN ('pending','lease_linked');

CREATE TABLE app.unit_bind_impostor_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  binding_id uuid NOT NULL,
  table_name text NOT NULL,
  row_id uuid,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app.unit_bind_impostor_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.unit_bind_impostor_flags FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.unit_bind_impostor_flags FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.unit_bind_impostor_flags TO service_role;

-- C-12 (Ron 2026-11-10 12:03 PT): a LINE may be tenant on several units and also an owner (incl. same org). Same-org staff+tenant remains blocked in unit_line_accept and unit_line_staff_tenant_guard.

CREATE FUNCTION app.unit_line_issue(p_org uuid, p_unit uuid, p_hash text, p_issuer uuid)
  RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO app.unit_invite_secrets(org_id, unit_id, token_hash, expires_at, issued_by)
  VALUES (p_org, p_unit, p_hash, now() + interval '14 days', p_issuer)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION app.unit_line_issue(uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.unit_line_issue(uuid, uuid, text, uuid) TO service_role;

CREATE FUNCTION app.unit_line_rotate(p_org uuid, p_unit uuid, p_new_hash text, p_issuer uuid)
  RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
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

CREATE FUNCTION app.unit_line_accept(
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

  SELECT * INTO v_secret
    FROM app.unit_invite_secrets
   WHERE org_id = p_org AND unit_id = p_unit AND token_hash = p_hash;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;
  IF v_secret.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'revoked';
  END IF;
  IF v_secret.expires_at <= now() THEN
    RAISE EXCEPTION 'expired';
  END IF;

  -- Serialize seat counting for this unit by locking the invite secret row.
  PERFORM 1 FROM app.unit_invite_secrets
   WHERE id = v_secret.id
   FOR UPDATE;

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

CREATE FUNCTION app.unit_line_remove(p_org uuid, p_binding uuid, p_actor uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_user uuid;
BEGIN
  UPDATE app.unit_bindings
     SET status = 'unlinked', unbound_at = now()
   WHERE id = p_binding AND org_id = p_org
  RETURNING user_id INTO v_user;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found';
  END IF;

  IF v_user IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM app.unit_bindings b
                      WHERE b.user_id = v_user
                        AND b.status IN ('pending','lease_linked'))
     AND NOT EXISTS (SELECT 1 FROM public.contacts c
                      WHERE c.user_id = v_user
                        AND c.is_owner
                        AND c.archived_at IS NULL) THEN
    UPDATE public.auth_sessions
       SET revoked_at = now()
     WHERE user_id = v_user AND revoked_at IS NULL;
  END IF;

  -- LINE portal sessions share public.auth_sessions (app.b033_line_sessions has no revoked_at).
END;
$$;
REVOKE ALL ON FUNCTION app.unit_line_remove(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app.unit_line_remove(uuid, uuid, uuid) TO service_role;

CREATE FUNCTION app.unit_line_include_on_lease(p_org uuid, p_lease uuid, p_unit uuid, p_binding_ids uuid[])
  RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r record;
BEGIN
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

CREATE FUNCTION app.unit_line_staff_tenant_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'active' AND EXISTS (
    SELECT 1 FROM app.unit_bindings b
     WHERE b.org_id = NEW.org_id AND b.user_id = NEW.user_id
       AND b.status IN ('pending','lease_linked')
  ) THEN
    RAISE EXCEPTION 'identity_conflict';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER unit_line_staff_tenant_guard
  BEFORE INSERT OR UPDATE ON public.org_members
  FOR EACH ROW EXECUTE FUNCTION app.unit_line_staff_tenant_guard();

CREATE TABLE app.unit_invite_attempts (
  key text PRIMARY KEY,
  failed_count integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app.unit_invite_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.unit_invite_attempts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.unit_invite_attempts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.unit_invite_attempts TO service_role;

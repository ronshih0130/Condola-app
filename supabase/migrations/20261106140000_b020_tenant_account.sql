-- B-020 slice: tenant account sessions + trackable data requests (CAP-T-13).
-- Flag tenant_account_settings seeded OFF. Every RPC derives the user from auth.uid() and
-- the organization from the exact pin + the caller's own tenant contact, so forged user/org
-- identifiers are ignored. Data-request UI waits for approved copy (no privacy text here).
BEGIN;
SET LOCAL lock_timeout = '5s';
INSERT INTO public.platform_settings(key, value)
VALUES ('tenant_account_settings', '{"enabled":false,"allowed_org_ids":[]}'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE app.b020_data_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  contact_id uuid NOT NULL,
  request_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('export','correction','deletion')),
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','in_review','completed','declined')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id, request_id),
  FOREIGN KEY (org_id, contact_id) REFERENCES public.contacts(org_id, id)
);
CREATE UNIQUE INDEX b020_one_open_request_per_kind ON app.b020_data_requests(org_id, user_id, kind) WHERE status IN ('submitted','in_review');
ALTER TABLE app.b020_data_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b020_data_requests FROM PUBLIC, anon, authenticated, service_role;

-- Every accepted request id is bound to the data request it resolved to (new or reused open
-- request), so a later retry with that id always returns the same row and a different kind conflicts.
CREATE TABLE app.b020_request_ids (
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  request_id uuid NOT NULL,
  kind text NOT NULL,
  data_request_id uuid NOT NULL REFERENCES app.b020_data_requests(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id, request_id)
);
ALTER TABLE app.b020_request_ids ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b020_request_ids FROM PUBLIC, anon, authenticated, service_role;

-- Admission shared by all B-020 RPCs: flag ON (NULL = OFF), exact org/env pin, caller is an
-- active tenant contact of that organization. Returns the caller's contact id.
CREATE FUNCTION app.b020_admit(p_org uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE v_contact uuid; v_global jsonb; v_flags jsonb;
BEGIN
  SELECT value INTO v_global FROM public.platform_settings WHERE key = 'tenant_account_settings';
  SELECT feature_flags INTO v_flags FROM public.organizations WHERE id = p_org;
  IF (v_global->'enabled' = 'true'::jsonb AND jsonb_typeof(v_global->'allowed_org_ids') = 'array'
      AND v_global->'allowed_org_ids' @> jsonb_build_array(p_org::text) AND v_flags->'tenant_account_settings' = 'true'::jsonb) IS NOT TRUE
     OR auth.uid() IS NULL
     OR nullif(current_setting('app.active_org_id', true), '') IS DISTINCT FROM p_org::text
     OR nullif(current_setting('app.env', true), '') IS DISTINCT FROM (SELECT o.environment::text FROM public.organizations o WHERE o.id = p_org) THEN
    RAISE EXCEPTION 'Account settings unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT c.id INTO v_contact FROM public.contacts c
   WHERE c.org_id = p_org AND c.user_id = auth.uid() AND c.is_tenant AND c.archived_at IS NULL ORDER BY c.created_at, c.id LIMIT 1;
  IF v_contact IS NULL THEN RAISE EXCEPTION 'Account settings unavailable' USING ERRCODE = '42501'; END IF;
  RETURN v_contact;
END $$;
REVOKE ALL ON FUNCTION app.b020_admit(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION app.b020_my_sessions(p_org uuid)
RETURNS TABLE(id uuid, created_at timestamptz, last_active_at timestamptz, expires_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
BEGIN
  PERFORM app.b020_admit(p_org);
  RETURN QUERY SELECT s.id, s.created_at, s.last_active_at, s.expires_at FROM public.auth_sessions s
    WHERE s.user_id = auth.uid() AND s.revoked_at IS NULL AND s.expires_at > now() ORDER BY s.last_active_at DESC, s.id;
END $$;
REVOKE ALL ON FUNCTION app.b020_my_sessions(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b020_my_sessions(uuid) TO authenticated;

-- Revoke one of the caller's OTHER sessions (the current one signs out through the normal path).
CREATE FUNCTION app.b020_revoke_session(p_org uuid, p_session uuid, p_current uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE v_rows int;
BEGIN
  PERFORM app.b020_admit(p_org);
  IF p_session IS NULL OR p_session = p_current THEN RAISE EXCEPTION 'Session unavailable' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.auth_sessions s WHERE s.id = p_current AND s.user_id = auth.uid() AND s.revoked_at IS NULL AND s.expires_at > now()) THEN
    RAISE EXCEPTION 'Session unavailable' USING ERRCODE = '42501';
  END IF;
  UPDATE public.auth_sessions SET revoked_at = now() WHERE id = p_session AND user_id = auth.uid() AND revoked_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END $$;
REVOKE ALL ON FUNCTION app.b020_revoke_session(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b020_revoke_session(uuid, uuid, uuid) TO authenticated;

-- Idempotent: same request id returns the same row; an open request of the same kind is reused.
CREATE FUNCTION app.b020_submit_data_request(p_org uuid, p_request uuid, p_kind text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE v_contact uuid; v_id uuid; v_kind text;
BEGIN
  v_contact := app.b020_admit(p_org);
  IF p_request IS NULL OR p_kind IS NULL OR p_kind NOT IN ('export','correction','deletion') THEN
    RAISE EXCEPTION 'Invalid data request' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('b020:' || p_org::text || ':' || auth.uid()::text, 0));
  SELECT a.data_request_id, a.kind INTO v_id, v_kind FROM app.b020_request_ids a
   WHERE a.org_id = p_org AND a.user_id = auth.uid() AND a.request_id = p_request;
  IF v_id IS NOT NULL THEN
    IF v_kind <> p_kind THEN RAISE EXCEPTION 'Data request conflict' USING ERRCODE = '42501'; END IF;
    RETURN v_id;
  END IF;
  SELECT r.id INTO v_id FROM app.b020_data_requests r WHERE r.org_id = p_org AND r.user_id = auth.uid() AND r.kind = p_kind AND r.status IN ('submitted','in_review');
  IF v_id IS NULL THEN
    INSERT INTO app.b020_data_requests(org_id, user_id, contact_id, request_id, kind) VALUES (p_org, auth.uid(), v_contact, p_request, p_kind) RETURNING id INTO v_id;
  END IF;
  INSERT INTO app.b020_request_ids(org_id, user_id, request_id, kind, data_request_id) VALUES (p_org, auth.uid(), p_request, p_kind, v_id);
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION app.b020_submit_data_request(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b020_submit_data_request(uuid, uuid, text) TO authenticated;

CREATE FUNCTION app.b020_my_data_requests(p_org uuid)
RETURNS TABLE(id uuid, kind text, status text, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
BEGIN
  PERFORM app.b020_admit(p_org);
  RETURN QUERY SELECT r.id, r.kind, r.status, r.created_at FROM app.b020_data_requests r
    WHERE r.org_id = p_org AND r.user_id = auth.uid() ORDER BY r.created_at DESC, r.id;
END $$;
REVOKE ALL ON FUNCTION app.b020_my_data_requests(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b020_my_data_requests(uuid) TO authenticated;
COMMIT;

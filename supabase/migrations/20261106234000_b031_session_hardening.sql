-- Private credential fences. No authenticated/anon access, including function execution.
INSERT INTO public.platform_settings(key, value)
VALUES ('session_hardening', '{"enabled":false}'::jsonb) ON CONFLICT (key) DO NOTHING;

CREATE TABLE app.b031_credential_epochs (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  epoch bigint NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.b031_challenge_epochs (
  challenge_id uuid PRIMARY KEY REFERENCES public.auth_challenges(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  epoch bigint NOT NULL CHECK (epoch >= 0),
  provenance text
);
CREATE TABLE app.b031_challenge_exempt (
  challenge_id uuid PRIMARY KEY REFERENCES public.auth_challenges(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (reason = 'line_demo')
);
CREATE TABLE app.b031_credential_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('pending', 'done', 'failed', 'unknown')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz
);
CREATE UNIQUE INDEX b031_one_pending_credential_change ON app.b031_credential_changes(user_id)
  WHERE state = 'pending' OR (state = 'unknown' AND finished_at IS NULL);
REVOKE ALL ON app.b031_credential_changes FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE app.b031_credential_changes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON app.b031_credential_epochs, app.b031_challenge_epochs, app.b031_challenge_exempt FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE app.b031_credential_epochs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b031_challenge_epochs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b031_challenge_exempt ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION app.b031_session_hardening_enabled() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce((SELECT value->'enabled' = 'true'::jsonb
    FROM public.platform_settings WHERE key = 'session_hardening'), false)
$$;
CREATE FUNCTION app.b031_credential_epoch(p_user uuid) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce((SELECT epoch FROM app.b031_credential_epochs WHERE user_id = p_user), 0::bigint)
$$;
CREATE FUNCTION app.b031_bump_credential_epoch(p_user uuid) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE result bigint;
BEGIN
  INSERT INTO app.b031_credential_epochs AS e (user_id, epoch) VALUES (p_user, 1)
  ON CONFLICT (user_id) DO UPDATE SET epoch = e.epoch + 1, changed_at = now()
  RETURNING epoch INTO result;
  RETURN result;
END
$$;
CREATE FUNCTION app.b031_lock_credential_epoch(p_user uuid, p_expected bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE current_epoch bigint;
BEGIN
  INSERT INTO app.b031_credential_epochs (user_id) VALUES (p_user) ON CONFLICT (user_id) DO NOTHING;
  PERFORM app.b031_reconcile_credential_change(p_user);
  SELECT epoch INTO current_epoch FROM app.b031_credential_epochs WHERE user_id = p_user FOR SHARE;
  IF p_expected IS NULL OR current_epoch <> p_expected OR EXISTS (
    SELECT 1 FROM app.b031_credential_changes WHERE user_id = p_user AND (state = 'pending' OR (state = 'unknown' AND finished_at IS NULL))
  ) THEN
    RAISE EXCEPTION 'credentials changed' USING ERRCODE = 'P0B31';
  END IF;
END
$$;
REVOKE ALL ON FUNCTION app.b031_session_hardening_enabled(), app.b031_credential_epoch(uuid),
  app.b031_bump_credential_epoch(uuid), app.b031_lock_credential_epoch(uuid,bigint)
  FROM PUBLIC, anon, authenticated, service_role;
-- db.query/withClient use DATABASE_URL without SET ROLE (the server table-owner connection).
GRANT EXECUTE ON FUNCTION app.b031_session_hardening_enabled(), app.b031_credential_epoch(uuid),
  app.b031_bump_credential_epoch(uuid), app.b031_lock_credential_epoch(uuid,bigint) TO service_role;

-- Always acquire the epoch exclusively before touching changes/sessions/challenges.
CREATE FUNCTION app.b031_reconcile_credential_change(p_user uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.b031_credential_changes WHERE user_id = p_user
    AND (state = 'pending' OR (state = 'unknown' AND finished_at IS NULL))
    AND started_at <= clock_timestamp() - interval '2 minutes') THEN
    RETURN false;
  END IF;
  INSERT INTO app.b031_credential_epochs(user_id) VALUES (p_user) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM app.b031_credential_epochs WHERE user_id = p_user FOR UPDATE;
  UPDATE app.b031_credential_changes SET state = 'unknown', finished_at = clock_timestamp()
    WHERE user_id = p_user AND (state = 'pending' OR (state = 'unknown' AND finished_at IS NULL)) AND started_at <= clock_timestamp() - interval '2 minutes';
  IF FOUND THEN
    PERFORM app.b031_bump_credential_epoch(p_user);
    UPDATE public.auth_sessions SET revoked_at = now() WHERE user_id = p_user AND revoked_at IS NULL;
    DELETE FROM public.auth_challenges WHERE user_id = p_user;
    RETURN true;
  END IF;
  RETURN false;
END
$$;
CREATE FUNCTION app.b031_begin_credential_change(p_user uuid, p_expected bigint) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE change_id uuid;
BEGIN
  PERFORM app.b031_reconcile_credential_change(p_user);
  INSERT INTO app.b031_credential_epochs(user_id) VALUES (p_user) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM app.b031_credential_epochs WHERE user_id = p_user FOR UPDATE;
  IF EXISTS (SELECT 1 FROM app.b031_credential_changes WHERE user_id = p_user AND (state = 'pending' OR (state = 'unknown' AND finished_at IS NULL)))
    OR (p_expected IS NOT NULL AND app.b031_credential_epoch(p_user) <> p_expected) THEN
    RAISE EXCEPTION 'credentials changed' USING ERRCODE = 'P0B31';
  END IF;
  PERFORM app.b031_bump_credential_epoch(p_user);
  INSERT INTO app.b031_credential_changes(user_id, state) VALUES (p_user, 'pending') RETURNING id INTO change_id;
  RETURN change_id;
END
$$;
CREATE FUNCTION app.b031_finish_credential_change(p_user uuid, p_change uuid, p_state text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE change_started timestamptz;
BEGIN
  PERFORM 1 FROM app.b031_credential_epochs WHERE user_id = p_user FOR UPDATE;
  IF p_state NOT IN ('done', 'failed', 'unknown') OR p_state IS NULL THEN
    RAISE EXCEPTION 'invalid credential change state';
  END IF;
  SELECT started_at INTO change_started FROM app.b031_credential_changes
    WHERE id = p_change AND user_id = p_user FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid credential change';
  END IF;
  -- Unknown remains fenced until recovery after the provider budget + margin.
  -- A late finish after recovery must bump/revoke again, never raise P0B31.
  UPDATE app.b031_credential_changes
    SET state = p_state,
        finished_at = CASE WHEN p_state = 'unknown' THEN NULL ELSE clock_timestamp() END
    WHERE id = p_change AND user_id = p_user
      AND (state = 'pending' OR (state = 'unknown' AND (finished_at IS NULL OR p_state <> 'unknown')));
  UPDATE public.auth_sessions SET revoked_at = now()
    WHERE user_id = p_user AND created_at >= change_started AND revoked_at IS NULL;
  DELETE FROM public.auth_challenges WHERE user_id = p_user;
  RETURN app.b031_bump_credential_epoch(p_user);
END
$$;
REVOKE ALL ON FUNCTION app.b031_reconcile_credential_change(uuid),
  app.b031_begin_credential_change(uuid,bigint), app.b031_finish_credential_change(uuid,uuid,text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b031_reconcile_credential_change(uuid),
  app.b031_begin_credential_change(uuid,bigint), app.b031_finish_credential_change(uuid,uuid,text) TO service_role;

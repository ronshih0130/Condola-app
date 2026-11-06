-- B-023 slice 3: owner account — own login sessions, own profile, notification preferences.
-- Additive only: four private tables (RLS on, REVOKE ALL) and SECURITY DEFINER
-- gateways behind the existing default-OFF owner_portal_extensions setting
-- (slice 1). No existing table, column, policy or function changes; no backfill.
--
-- Reuses (does not change):
-- * public.auth_sessions (login sessions; user-level). An owner lists only their
--   own live sessions (auth.uid()) and signs out ONE other session. Another user's
--   session id is denied (42501) without being read or locked; the current session
--   is never revoked here ('current' state — normal sign-out ends it).
-- * Recent authentication. No re-authentication mechanism exists on this base, so
--   a revoke requires the CURRENT session to have been created (signed in) within
--   the last 15 minutes (auth_sessions.created_at; sessions are created only at
--   sign-in and are never re-issued on activity). Older sessions get
--   'reauth_required' with zero writes; the owner signs out and in again.
-- * The owner contact (public.contacts, slice-1 app.b023_owner_contact binding).
--   The owner edits display_name, locale and preferred_channel of their OWN contact
--   only. Email and phone are read-only (no verification flow exists for contact
--   channel changes). No new personal-data fields; no ID or tax numbers.
-- * The tenant reminder preference model (app.b010_tenant_due_preferences:
--   default-true row per principal, definer get/set). Owner notification
--   preferences are per owner contact and category; no row = ON, so all currently
--   sent owner notifications stay ON. Categories are the owner notifications that
--   exist on this base: repair_updates (B-028 center vendor_job_assigned, owner
--   persona) and statement_reports (B-014 statement report delivery). No existing
--   delivery code consults them yet; app.b023_owner_notification_enabled is the
--   private read helper for future producers (wiring pending, B-028 stack).
-- Owner password change / credential epoch is NOT here (B-031).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- One row per successful "sign out this other device" request (idempotency ledger).
CREATE TABLE app.b023_owner_session_revocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  owner_contact_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES auth.users(id),
  acting_session_id uuid NOT NULL,
  target_session_id uuid NOT NULL CHECK (target_session_id <> acting_session_id),
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (org_id, request_id),
  FOREIGN KEY (org_id, owner_contact_id) REFERENCES public.contacts(org_id, id)
);

-- One row per applied owner profile edit (idempotency ledger + history of values).
CREATE TABLE app.b023_owner_profile_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  owner_contact_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES auth.users(id),
  request_id uuid NOT NULL,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100 AND display_name = btrim(display_name)),
  locale text NOT NULL CHECK (locale IN ('zh-TW', 'en')),
  preferred_channel text CHECK (preferred_channel IN ('in_app', 'email', 'sms', 'line')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (org_id, request_id),
  FOREIGN KEY (org_id, owner_contact_id) REFERENCES public.contacts(org_id, id)
);

-- Current preference state. No row = enabled (default preserves current behaviour).
CREATE TABLE app.b023_owner_notification_preferences (
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  owner_contact_id uuid NOT NULL,
  category text NOT NULL CHECK (category IN ('repair_updates', 'statement_reports')),
  enabled boolean NOT NULL,
  updated_by uuid NOT NULL REFERENCES auth.users(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, owner_contact_id, category),
  FOREIGN KEY (org_id, owner_contact_id) REFERENCES public.contacts(org_id, id)
);

-- One row per applied preference change (idempotency ledger).
CREATE TABLE app.b023_owner_preference_requests (
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  request_id uuid NOT NULL,
  owner_contact_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES auth.users(id),
  category text NOT NULL CHECK (category IN ('repair_updates', 'statement_reports')),
  enabled boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, request_id),
  FOREIGN KEY (org_id, owner_contact_id) REFERENCES public.contacts(org_id, id)
);

ALTER TABLE app.b023_owner_session_revocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b023_owner_profile_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b023_owner_notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b023_owner_preference_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b023_owner_session_revocations, app.b023_owner_profile_revisions,
  app.b023_owner_notification_preferences, app.b023_owner_preference_requests
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION app.b023s3_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'Owner account history is immutable' USING ERRCODE = '55000';
END $$;
REVOKE ALL ON FUNCTION app.b023s3_immutable() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER b023_session_revocations_no_change BEFORE UPDATE OR DELETE ON app.b023_owner_session_revocations
FOR EACH ROW EXECUTE FUNCTION app.b023s3_immutable();
CREATE TRIGGER b023_session_revocations_no_truncate BEFORE TRUNCATE ON app.b023_owner_session_revocations
FOR EACH STATEMENT EXECUTE FUNCTION app.b023s3_immutable();
CREATE TRIGGER b023_profile_revisions_no_change BEFORE UPDATE OR DELETE ON app.b023_owner_profile_revisions
FOR EACH ROW EXECUTE FUNCTION app.b023s3_immutable();
CREATE TRIGGER b023_profile_revisions_no_truncate BEFORE TRUNCATE ON app.b023_owner_profile_revisions
FOR EACH STATEMENT EXECUTE FUNCTION app.b023s3_immutable();
CREATE TRIGGER b023_preference_requests_no_change BEFORE UPDATE OR DELETE ON app.b023_owner_preference_requests
FOR EACH ROW EXECUTE FUNCTION app.b023s3_immutable();
CREATE TRIGGER b023_preference_requests_no_truncate BEFORE TRUNCATE ON app.b023_owner_preference_requests
FOR EACH STATEMENT EXECUTE FUNCTION app.b023s3_immutable();

-- The caller's live session, else 42501. Read-only check (no lock).
CREATE FUNCTION app.b023s3_live_session(p_session uuid) RETURNS timestamptz
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE v_created timestamptz;
BEGIN
  SELECT s.created_at INTO v_created FROM public.auth_sessions s
   WHERE s.id = p_session AND s.user_id = auth.uid() AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp();
  IF v_created IS NULL THEN RAISE EXCEPTION 'Owner account unavailable' USING ERRCODE = '42501'; END IF;
  RETURN v_created;
END $$;
REVOKE ALL ON FUNCTION app.b023s3_live_session(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Recent-auth window: the session was created (signed in) within the last 15 minutes.
CREATE FUNCTION app.b023s3_recent(p_created timestamptz) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
  SELECT p_created IS NOT NULL AND p_created > clock_timestamp() - interval '15 minutes'
     AND p_created <= clock_timestamp() + interval '1 minute';
$$;
REVOKE ALL ON FUNCTION app.b023s3_recent(timestamptz) FROM PUBLIC, anon, authenticated, service_role;

-- Short device summary (browser · OS) from a stored user agent; NULL when unknown.
-- The raw user agent never leaves the database through the owner gateway.
CREATE FUNCTION app.b023s3_device(p_ua text) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
  SELECT nullif(concat_ws(' · ',
    CASE WHEN p_ua ~ 'Edg/' THEN 'Edge' WHEN p_ua ~ '(OPR/|Opera)' THEN 'Opera' WHEN p_ua ~* 'Line/' THEN 'LINE'
         WHEN p_ua ~ 'Firefox/' THEN 'Firefox' WHEN p_ua ~ '(Chrome/|CriOS/)' THEN 'Chrome'
         WHEN p_ua ~ 'Safari/' AND p_ua ~ 'Version/' THEN 'Safari' END,
    CASE WHEN p_ua ~ '(iPhone|iPad|iPod)' THEN 'iOS' WHEN p_ua ~ 'Android' THEN 'Android'
         WHEN p_ua ~ '(Mac OS X|Macintosh)' THEN 'macOS' WHEN p_ua ~ 'Windows' THEN 'Windows'
         WHEN p_ua ~ 'CrOS' THEN 'ChromeOS' WHEN p_ua ~ 'Linux' THEN 'Linux' END), '');
$$;
REVOKE ALL ON FUNCTION app.b023s3_device(text) FROM PUBLIC, anon, authenticated, service_role;

-- Own live sessions only. Device summary only (no raw user agent, no IP).
CREATE FUNCTION app.b023_owner_sessions(p_org uuid, p_session uuid)
RETURNS TABLE(session_id uuid, device text, created_at timestamptz, last_active_at timestamptz,
  is_current boolean, recent_auth boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
#variable_conflict use_column
DECLARE v_created timestamptz;
BEGIN
  IF p_session IS NULL THEN RAISE EXCEPTION 'Owner account unavailable' USING ERRCODE = '42501'; END IF;
  PERFORM app.b023_owner_contact(p_org);
  v_created := app.b023s3_live_session(p_session);
  RETURN QUERY
  SELECT s.id, app.b023s3_device(s.user_agent), s.created_at, s.last_active_at, s.id = p_session,
         s.id = p_session AND app.b023s3_recent(v_created)
    FROM public.auth_sessions s
   WHERE s.user_id = auth.uid() AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()
   ORDER BY s.id = p_session DESC, s.last_active_at DESC, s.id;
END $$;
REVOKE ALL ON FUNCTION app.b023_owner_sessions(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b023_owner_sessions(uuid, uuid) TO authenticated;

-- Sign out ONE other own session. States: revoked | replayed | conflict | current |
-- reauth_required | gone. Denials (flag OFF, not an owner, staff, current session
-- not live, target not the caller's own session) raise 42501 with zero writes.
-- Lock order: platform_settings row -> organization -> owner contact -> both own
-- session rows in id order (FOR UPDATE) -> request advisory lock. Order of outcomes:
-- denials (42501) -> request-id replay/conflict -> current -> reauth_required -> gone -> revoked.
CREATE FUNCTION app.b023_revoke_owner_session(p_org uuid, p_session uuid, p_target uuid, p_request uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE v_contact uuid; v_current public.auth_sessions%ROWTYPE; v_target public.auth_sessions%ROWTYPE; v_id uuid;
  prior app.b023_owner_session_revocations%ROWTYPE;
BEGIN
  IF p_org IS NULL OR p_session IS NULL OR p_target IS NULL OR p_request IS NULL OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Owner account unavailable' USING ERRCODE = '42501';
  END IF;
  IF NOT app.b023_flag_locked(p_org) THEN RAISE EXCEPTION 'Owner account unavailable' USING ERRCODE = '42501'; END IF;
  v_contact := app.b023_owner_contact(p_org);
  PERFORM 1 FROM public.contacts WHERE org_id = p_org AND id = v_contact FOR SHARE;
  -- Only the caller's own rows are ever selected or locked.
  PERFORM 1 FROM public.auth_sessions s WHERE s.id IN (p_session, p_target) AND s.user_id = auth.uid()
    ORDER BY s.id FOR UPDATE;
  SELECT * INTO v_current FROM public.auth_sessions s WHERE s.id = p_session AND s.user_id = auth.uid()
     AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'Owner account unavailable' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_target FROM public.auth_sessions s WHERE s.id = p_target AND s.user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Owner account unavailable' USING ERRCODE = '42501'; END IF;
  IF app.b023_owner_contact(p_org) IS DISTINCT FROM v_contact THEN
    RAISE EXCEPTION 'Owner account unavailable' USING ERRCODE = '42501';
  END IF;
  -- Request-id lookup first, so a retried completed revoke is 'replayed' even after
  -- the recent-auth window has passed (a replay writes nothing).
  PERFORM pg_advisory_xact_lock(hashtextextended('b023_session_request:' || p_org || ':' || p_request, 0));
  SELECT * INTO prior FROM app.b023_owner_session_revocations r WHERE r.org_id = p_org AND r.request_id = p_request;
  IF FOUND THEN
    IF prior.target_session_id = p_target AND prior.actor_user_id = auth.uid() AND prior.owner_contact_id = v_contact THEN
      RETURN jsonb_build_object('state', 'replayed', 'revocationId', prior.id);
    END IF;
    RETURN jsonb_build_object('state', 'conflict');
  END IF;
  IF p_target = p_session THEN RETURN jsonb_build_object('state', 'current'); END IF;
  IF NOT app.b023s3_recent(v_current.created_at) THEN RETURN jsonb_build_object('state', 'reauth_required'); END IF;
  IF v_target.revoked_at IS NOT NULL OR v_target.expires_at <= clock_timestamp() THEN
    RETURN jsonb_build_object('state', 'gone');
  END IF;
  UPDATE public.auth_sessions SET revoked_at = clock_timestamp()
   WHERE id = p_target AND user_id = auth.uid() AND revoked_at IS NULL;
  INSERT INTO app.b023_owner_session_revocations(org_id, owner_contact_id, actor_user_id, acting_session_id,
    target_session_id, request_id)
  VALUES (p_org, v_contact, auth.uid(), p_session, p_target, p_request) RETURNING id INTO v_id;
  INSERT INTO public.audit_log(org_id, actor_user_id, actor_role, table_name, row_id, action, event_type, old_row, new_row)
  VALUES (p_org, auth.uid(), 'owner', 'auth_sessions', p_target::text, 'update', 'owner_session_revoked',
    NULL, jsonb_build_object('scope', 'one_other_session'));
  RETURN jsonb_build_object('state', 'revoked', 'revocationId', v_id);
END $$;
REVOKE ALL ON FUNCTION app.b023_revoke_owner_session(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b023_revoke_owner_session(uuid, uuid, uuid, uuid) TO authenticated;

-- Optimistic-concurrency token over the editable fields.
CREATE FUNCTION app.b023s3_profile_version(p_name text, p_locale text, p_channel text, p_updated timestamptz) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
  SELECT md5(concat_ws(E'\x1f', p_name, p_locale, coalesce(p_channel, '-'),
    to_char(p_updated AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')));
$$;
REVOKE ALL ON FUNCTION app.b023s3_profile_version(text, text, text, timestamptz) FROM PUBLIC, anon, authenticated, service_role;

-- Channels the contact can be reached on (in_app always; others only with an address).
CREATE FUNCTION app.b023s3_channels(p_org uuid, p_contact uuid) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
  SELECT array_remove(ARRAY['in_app',
           CASE WHEN c.email IS NOT NULL THEN 'email' END,
           CASE WHEN c.phone_e164 IS NOT NULL THEN 'sms' END,
           CASE WHEN c.line_user_id IS NOT NULL THEN 'line' END], NULL)
    FROM public.contacts c WHERE c.org_id = p_org AND c.id = p_contact;
$$;
REVOKE ALL ON FUNCTION app.b023s3_channels(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- The caller's own owner contact profile. Email/phone are returned read-only.
CREATE FUNCTION app.b023_owner_profile(p_org uuid)
RETURNS TABLE(display_name text, email text, phone_e164 text, locale text, preferred_channel text,
  channels text[], version text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
#variable_conflict use_column
DECLARE v_contact uuid;
BEGIN
  v_contact := app.b023_owner_contact(p_org);
  RETURN QUERY
  SELECT c.display_name, c.email::text, c.phone_e164, c.locale, c.preferred_channel::text,
         app.b023s3_channels(p_org, v_contact),
         app.b023s3_profile_version(c.display_name, c.locale, c.preferred_channel::text, c.updated_at)
    FROM public.contacts c WHERE c.org_id = p_org AND c.id = v_contact;
END $$;
REVOKE ALL ON FUNCTION app.b023_owner_profile(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b023_owner_profile(uuid) TO authenticated;

-- Save own display name / locale / preferred channel. States: recorded | replayed |
-- unchanged | stale | invalid | conflict. Denials raise 42501 with zero writes.
-- Lock order: platform_settings row -> organization -> own contact (FOR UPDATE) ->
-- request advisory lock. Writes the contact row (audited by the existing contacts
-- audit trigger) and one revision row.
CREATE FUNCTION app.b023_save_owner_profile(p_org uuid, p_session uuid, p_request uuid, p_display_name text,
  p_locale text, p_channel text, p_version text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE v_contact uuid; v_row public.contacts%ROWTYPE; prior app.b023_owner_profile_revisions%ROWTYPE; v_id uuid;
BEGIN
  IF p_org IS NULL OR p_session IS NULL OR p_request IS NULL OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Owner account unavailable' USING ERRCODE = '42501';
  END IF;
  IF NOT app.b023_flag_locked(p_org) THEN RAISE EXCEPTION 'Owner account unavailable' USING ERRCODE = '42501'; END IF;
  v_contact := app.b023_owner_contact(p_org);
  PERFORM app.b023s3_live_session(p_session);
  SELECT * INTO v_row FROM public.contacts WHERE org_id = p_org AND id = v_contact FOR UPDATE;
  IF app.b023_owner_contact(p_org) IS DISTINCT FROM v_contact THEN
    RAISE EXCEPTION 'Owner account unavailable' USING ERRCODE = '42501';
  END IF;
  IF p_display_name IS NULL OR length(p_display_name) NOT BETWEEN 1 AND 100 OR p_display_name <> btrim(p_display_name)
    OR p_display_name ~ '[[:cntrl:]]' OR p_locale IS NULL OR p_locale NOT IN ('zh-TW', 'en')
    OR (p_channel IS NOT NULL AND NOT (p_channel = ANY (app.b023s3_channels(p_org, v_contact))))
    OR p_version IS NULL THEN
    RETURN jsonb_build_object('state', 'invalid');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('b023_profile_request:' || p_org || ':' || p_request, 0));
  SELECT * INTO prior FROM app.b023_owner_profile_revisions r WHERE r.org_id = p_org AND r.request_id = p_request;
  IF FOUND THEN
    IF prior.owner_contact_id = v_contact AND prior.actor_user_id = auth.uid() AND prior.display_name = p_display_name
      AND prior.locale = p_locale AND prior.preferred_channel IS NOT DISTINCT FROM p_channel THEN
      RETURN jsonb_build_object('state', 'replayed', 'revisionId', prior.id);
    END IF;
    RETURN jsonb_build_object('state', 'conflict');
  END IF;
  IF v_row.display_name = p_display_name AND v_row.locale = p_locale
    AND v_row.preferred_channel::text IS NOT DISTINCT FROM p_channel THEN
    RETURN jsonb_build_object('state', 'unchanged');
  END IF;
  IF app.b023s3_profile_version(v_row.display_name, v_row.locale, v_row.preferred_channel::text, v_row.updated_at) <> p_version THEN
    RETURN jsonb_build_object('state', 'stale');
  END IF;
  UPDATE public.contacts SET display_name = p_display_name, locale = p_locale,
         preferred_channel = p_channel::public.channel_type
   WHERE org_id = p_org AND id = v_contact;
  INSERT INTO app.b023_owner_profile_revisions(org_id, owner_contact_id, actor_user_id, request_id, display_name,
    locale, preferred_channel)
  VALUES (p_org, v_contact, auth.uid(), p_request, p_display_name, p_locale, p_channel) RETURNING id INTO v_id;
  RETURN jsonb_build_object('state', 'recorded', 'revisionId', v_id);
END $$;
REVOKE ALL ON FUNCTION app.b023_save_owner_profile(uuid, uuid, uuid, text, text, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b023_save_owner_profile(uuid, uuid, uuid, text, text, text, text) TO authenticated;

-- Own preferences; every category is returned, absent rows default to enabled.
CREATE FUNCTION app.b023_owner_notification_settings(p_org uuid)
RETURNS TABLE(category text, enabled boolean, updated_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
#variable_conflict use_column
DECLARE v_contact uuid;
BEGIN
  v_contact := app.b023_owner_contact(p_org);
  RETURN QUERY
  SELECT k.category, coalesce(p.enabled, true), p.updated_at
    FROM unnest(ARRAY['repair_updates', 'statement_reports']) WITH ORDINALITY k(category, ord)
    LEFT JOIN app.b023_owner_notification_preferences p
      ON p.org_id = p_org AND p.owner_contact_id = v_contact AND p.category = k.category
   ORDER BY k.ord;
END $$;
REVOKE ALL ON FUNCTION app.b023_owner_notification_settings(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b023_owner_notification_settings(uuid) TO authenticated;

-- Opt in/out of one category. States: recorded | replayed | unchanged | conflict |
-- invalid. Denials raise 42501 with zero writes. Lock order: platform_settings row
-- -> organization -> own contact (SHARE) -> request advisory lock -> per-category
-- advisory lock -> preference row.
CREATE FUNCTION app.b023_set_owner_notification_preference(p_org uuid, p_session uuid, p_request uuid,
  p_category text, p_enabled boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE v_contact uuid; v_old boolean; prior app.b023_owner_preference_requests%ROWTYPE;
BEGIN
  IF p_org IS NULL OR p_session IS NULL OR p_request IS NULL OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Owner account unavailable' USING ERRCODE = '42501';
  END IF;
  IF NOT app.b023_flag_locked(p_org) THEN RAISE EXCEPTION 'Owner account unavailable' USING ERRCODE = '42501'; END IF;
  v_contact := app.b023_owner_contact(p_org);
  PERFORM app.b023s3_live_session(p_session);
  PERFORM 1 FROM public.contacts WHERE org_id = p_org AND id = v_contact FOR SHARE;
  IF app.b023_owner_contact(p_org) IS DISTINCT FROM v_contact THEN
    RAISE EXCEPTION 'Owner account unavailable' USING ERRCODE = '42501';
  END IF;
  IF p_category IS NULL OR p_category NOT IN ('repair_updates', 'statement_reports') OR p_enabled IS NULL THEN
    RETURN jsonb_build_object('state', 'invalid');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('b023_preference_request:' || p_org || ':' || p_request, 0));
  SELECT * INTO prior FROM app.b023_owner_preference_requests r WHERE r.org_id = p_org AND r.request_id = p_request;
  IF FOUND THEN
    IF prior.owner_contact_id = v_contact AND prior.actor_user_id = auth.uid() AND prior.category = p_category
      AND prior.enabled = p_enabled THEN
      RETURN jsonb_build_object('state', 'replayed');
    END IF;
    RETURN jsonb_build_object('state', 'conflict');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('b023_preference:' || p_org || ':' || v_contact || ':' || p_category, 0));
  SELECT p.enabled INTO v_old FROM app.b023_owner_notification_preferences p
   WHERE p.org_id = p_org AND p.owner_contact_id = v_contact AND p.category = p_category FOR UPDATE;
  v_old := coalesce(v_old, true);
  IF v_old = p_enabled THEN RETURN jsonb_build_object('state', 'unchanged'); END IF;
  INSERT INTO app.b023_owner_notification_preferences(org_id, owner_contact_id, category, enabled, updated_by)
  VALUES (p_org, v_contact, p_category, p_enabled, auth.uid())
  ON CONFLICT (org_id, owner_contact_id, category)
  DO UPDATE SET enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = clock_timestamp();
  INSERT INTO app.b023_owner_preference_requests(org_id, request_id, owner_contact_id, actor_user_id, category, enabled)
  VALUES (p_org, p_request, v_contact, auth.uid(), p_category, p_enabled);
  INSERT INTO public.audit_log(org_id, actor_user_id, actor_role, table_name, row_id, action, event_type, old_row, new_row)
  VALUES (p_org, auth.uid(), 'owner', 'b023_owner_notification_preferences', v_contact::text, 'update',
    'owner_notification_preference_changed', jsonb_build_object('category', p_category, 'enabled', v_old),
    jsonb_build_object('category', p_category, 'enabled', p_enabled));
  RETURN jsonb_build_object('state', 'recorded');
END $$;
REVOKE ALL ON FUNCTION app.b023_set_owner_notification_preference(uuid, uuid, uuid, text, boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b023_set_owner_notification_preference(uuid, uuid, uuid, text, boolean) TO authenticated;

-- Private read helper for future owner notification producers (not granted; wiring
-- pending). Returns true (send) unless the flag is ON and the owner opted out, so
-- defaults and flag-OFF keep the current behaviour.
CREATE FUNCTION app.b023_owner_notification_enabled(p_org uuid, p_contact uuid, p_category text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
  SELECT NOT (app.b023_flag_on(p_org) AND EXISTS (SELECT 1 FROM app.b023_owner_notification_preferences p
    WHERE p.org_id = p_org AND p.owner_contact_id = p_contact AND p.category = p_category AND NOT p.enabled));
$$;
REVOKE ALL ON FUNCTION app.b023_owner_notification_enabled(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
COMMIT;

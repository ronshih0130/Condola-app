-- B-023 slice 2: owner lifecycle replies + owner <-> company messaging.
-- Additive only. Reuses (does not change):
-- * the B-012 lifecycle model (app.b012_notice_versions). An owner reply is its own
--   append-only record (app.b023_owner_lifecycle_replies) attached to a notice
--   version. It never writes, merges into or stands in for app.b012_response_versions
--   (tenant / management / owner agree-disagree-undecided responses); B-012's own
--   explicit owner response action is untouched and never invoked here. A reply
--   records text only: no consent, signature, confirmation, approval or stance.
-- * the existing thread model (public.message_threads / public.messages). One
--   private link row per (property, owner contact) marks a thread as an owner <->
--   company thread. Owners are NOT thread_participants, so the existing portal RLS
--   (app.in_thread) never admits them; they read and write only through the
--   definer gateways below. Staff read these rows through their existing team
--   policies; no staff policy or permission changes. Text only, no attachments.
--   Read-only staff gateways (owner threads list, owner lifecycle replies per lease)
--   reuse the existing staff roles: admin/manager (messages.send / B-012 management).
-- * owner authority from slice 1 (app.b023_owner_contact / app.b023_owner_authority):
--   both features require CURRENT authority (a started property_owners window that
--   contains the property-local today), re-checked under locks at submit.
-- Flag: owner_portal_extensions (strict, slice 1). Lifecycle replies additionally
-- require lease_renewal (B-012) to be ON: B-012 items are never surfaced while
-- B-012 is OFF.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- New enum value only; no statement executed in this file uses it (safe inside one
-- transaction; it appears only inside a plpgsql body that runs after commit). Existing lease/announcement threads and policies are unchanged.
ALTER TYPE public.thread_kind ADD VALUE IF NOT EXISTS 'owner_company';

CREATE TABLE app.b023_owner_lifecycle_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  lease_id uuid NOT NULL,
  record_id uuid NOT NULL,
  notice_version integer NOT NULL,
  owner_contact_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES auth.users(id),
  request_id uuid NOT NULL,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000 AND body = btrim(body)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (org_id, request_id),
  FOREIGN KEY (org_id, lease_id) REFERENCES public.leases(org_id, id),
  FOREIGN KEY (org_id, record_id, notice_version) REFERENCES app.b012_notice_versions(org_id, record_id, version),
  FOREIGN KEY (org_id, owner_contact_id) REFERENCES public.contacts(org_id, id)
);
CREATE INDEX b023_owner_lifecycle_replies_record_idx
  ON app.b023_owner_lifecycle_replies(org_id, record_id, owner_contact_id, created_at);

-- Marks a reused public.message_threads row as the owner <-> company thread of one
-- owner contact for one property. Deleting the thread (existing staff permission)
-- removes the link.
CREATE TABLE app.b023_owner_threads (
  thread_id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  property_id uuid NOT NULL,
  owner_contact_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (org_id, property_id, owner_contact_id),
  FOREIGN KEY (org_id, thread_id) REFERENCES public.message_threads(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, property_id) REFERENCES public.properties(org_id, id),
  FOREIGN KEY (org_id, owner_contact_id) REFERENCES public.contacts(org_id, id)
);

-- Idempotency ledger for owner posts: one message per request id. Stores a body
-- digest, not the body. No foreign key to messages, so existing staff message
-- moderation is unchanged.
CREATE TABLE app.b023_owner_message_requests (
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  request_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  message_id uuid NOT NULL,
  property_id uuid NOT NULL,
  owner_contact_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES auth.users(id),
  body_digest text NOT NULL CHECK (body_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, request_id),
  FOREIGN KEY (org_id, owner_contact_id) REFERENCES public.contacts(org_id, id)
);

ALTER TABLE app.b023_owner_lifecycle_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b023_owner_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b023_owner_message_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b023_owner_lifecycle_replies, app.b023_owner_threads, app.b023_owner_message_requests
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION app.b023s2_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'Owner reply/message history is immutable' USING ERRCODE = '55000';
END $$;
REVOKE ALL ON FUNCTION app.b023s2_immutable() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER b023_lifecycle_replies_no_change BEFORE UPDATE OR DELETE ON app.b023_owner_lifecycle_replies
FOR EACH ROW EXECUTE FUNCTION app.b023s2_immutable();
CREATE TRIGGER b023_lifecycle_replies_no_truncate BEFORE TRUNCATE ON app.b023_owner_lifecycle_replies
FOR EACH STATEMENT EXECUTE FUNCTION app.b023s2_immutable();
CREATE TRIGGER b023_owner_threads_no_update BEFORE UPDATE ON app.b023_owner_threads
FOR EACH ROW EXECUTE FUNCTION app.b023s2_immutable();
CREATE TRIGGER b023_message_requests_no_change BEFORE UPDATE OR DELETE ON app.b023_owner_message_requests
FOR EACH ROW EXECUTE FUNCTION app.b023s2_immutable();
CREATE TRIGGER b023_message_requests_no_truncate BEFORE TRUNCATE ON app.b023_owner_message_requests
FOR EACH STATEMENT EXECUTE FUNCTION app.b023s2_immutable();

-- Controls lock: both flag rows (ordered by key) then the organization, all SHARE.
CREATE FUNCTION app.b023s2_lock_controls(p_org uuid, p_lifecycle boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
  PERFORM 1 FROM public.platform_settings
    WHERE key IN ('lease_renewal', 'owner_portal_extensions') ORDER BY key FOR SHARE;
  PERFORM 1 FROM public.organizations WHERE id = p_org FOR SHARE;
  RETURN app.b023_flag_on(p_org) AND (NOT p_lifecycle OR app.b012_flag_on(p_org));
END $$;
REVOKE ALL ON FUNCTION app.b023s2_lock_controls(uuid, boolean) FROM PUBLIC, anon, authenticated, service_role;

-- Live login session of the caller, locked against concurrent revocation.
CREATE FUNCTION app.b023s2_lock_session(p_session uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
  PERFORM 1 FROM public.auth_sessions
    WHERE id = p_session AND user_id = auth.uid() AND revoked_at IS NULL AND expires_at > clock_timestamp()
    FOR SHARE;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION app.b023s2_lock_session(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Properties on which the contact holds CURRENT authority (window contains local today).
CREATE FUNCTION app.b023s2_current_properties(p_org uuid, p_contact uuid)
RETURNS TABLE(property_id uuid, current_window daterange)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
  SELECT a.property_id, a.current_window FROM app.b023_owner_authority(p_org, p_contact) a
   WHERE a.current_window IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION app.b023s2_current_properties(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Lifecycle items: the latest version of each B-012 notice on a non-draft lease whose
-- term overlaps the caller's current window on that property. Projection excludes
-- notice text, actors, other parties' responses, documents, money and contacts.
CREATE FUNCTION app.b023s2_lifecycle_scope(p_org uuid, p_contact uuid)
RETURNS TABLE(record_id uuid, lease_id uuid, property_id uuid, unit_id uuid, room_id uuid,
  notice_version integer, kind text, filed_by text, occurred_on date, effective_on date,
  notice_at timestamptz, lease_start date, lease_end date, lease_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
  WITH cp AS (SELECT * FROM app.b023s2_current_properties(p_org, p_contact)),
  l AS (
    SELECT x.id, x.property_id, x.unit_id, x.target_room_id, x.start_date, x.status::text AS status, e.end_on
      FROM public.leases x
      JOIN cp ON cp.property_id = x.property_id
      CROSS JOIN LATERAL (SELECT CASE WHEN least(x.end_date, x.terminated_on) IS NULL THEN NULL::date
             ELSE greatest(x.start_date, least(x.end_date, x.terminated_on)) END AS end_on) e
     WHERE x.org_id = p_org AND x.status::text <> 'draft'
       AND cp.current_window && daterange(x.start_date, e.end_on, '[]')
  ), latest AS (
    SELECT DISTINCT ON (n.record_id) n.*
      FROM app.b012_notice_versions n JOIN l ON l.id = n.lease_id
     WHERE n.org_id = p_org
     ORDER BY n.record_id, n.version DESC
  )
  SELECT n.record_id, n.lease_id, l.property_id, l.unit_id, l.target_room_id, n.version, n.kind,
         CASE n.party WHEN 'management' THEN 'company' ELSE n.party END,
         n.occurred_on, n.effective_on, n.created_at, l.start_date, l.end_on, l.status
    FROM latest n JOIN l ON l.id = n.lease_id;
$$;
REVOKE ALL ON FUNCTION app.b023s2_lifecycle_scope(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION app.b023_owner_lifecycle_items(p_org uuid)
RETURNS TABLE(record_id uuid, lease_id uuid, notice_version integer, kind text, filed_by text,
  occurred_on date, effective_on date, notice_at timestamptz, property_name text, unit_label text,
  room_label text, lease_start date, lease_end date, lease_status text, my_reply_count integer,
  my_last_reply_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
#variable_conflict use_column
DECLARE v_contact uuid;
BEGIN
  v_contact := app.b023_owner_contact(p_org);
  IF NOT app.b012_flag_on(p_org) THEN
    RAISE EXCEPTION 'Owner lifecycle unavailable' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT s.record_id, s.lease_id, s.notice_version, s.kind, s.filed_by, s.occurred_on, s.effective_on,
         s.notice_at, p.name, u.label, rm.label, s.lease_start, s.lease_end, s.lease_status,
         coalesce(r.n, 0)::integer, r.last_at
    FROM app.b023s2_lifecycle_scope(p_org, v_contact) s
    JOIN public.properties p ON p.org_id = p_org AND p.id = s.property_id
    LEFT JOIN public.units u ON u.org_id = p_org AND u.id = s.unit_id
    LEFT JOIN public.rooms rm ON rm.org_id = p_org AND rm.id = s.room_id
    LEFT JOIN LATERAL (SELECT count(*) AS n, max(x.created_at) AS last_at FROM app.b023_owner_lifecycle_replies x
      WHERE x.org_id = p_org AND x.record_id = s.record_id AND x.owner_contact_id = v_contact) r ON true
   ORDER BY s.notice_at DESC, s.record_id;
END $$;
REVOKE ALL ON FUNCTION app.b023_owner_lifecycle_items(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b023_owner_lifecycle_items(uuid) TO authenticated;

-- One item plus the caller's OWN replies only (never other owners', tenants' or the
-- company's responses).
CREATE FUNCTION app.b023_owner_lifecycle_detail(p_org uuid, p_record uuid)
RETURNS TABLE(record_id uuid, lease_id uuid, notice_version integer, kind text, filed_by text,
  occurred_on date, effective_on date, notice_at timestamptz, property_name text, unit_label text,
  room_label text, lease_start date, lease_end date, lease_status text, my_reply_count integer,
  my_last_reply_at timestamptz, my_replies jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
#variable_conflict use_column
DECLARE v_contact uuid;
BEGIN
  IF p_record IS NULL THEN RAISE EXCEPTION 'Owner lifecycle unavailable' USING ERRCODE = '42501'; END IF;
  v_contact := app.b023_owner_contact(p_org);
  RETURN QUERY
  SELECT i.*, coalesce((SELECT jsonb_agg(jsonb_build_object('id', x.id, 'notice_version', x.notice_version,
           'body', x.body, 'created_at', x.created_at) ORDER BY x.created_at, x.id)
           FROM app.b023_owner_lifecycle_replies x
          WHERE x.org_id = p_org AND x.record_id = p_record AND x.owner_contact_id = v_contact), '[]'::jsonb)
    FROM app.b023_owner_lifecycle_items(p_org) i WHERE i.record_id = p_record;
  IF NOT FOUND THEN RAISE EXCEPTION 'Owner lifecycle unavailable' USING ERRCODE = '42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION app.b023_owner_lifecycle_detail(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b023_owner_lifecycle_detail(uuid, uuid) TO authenticated;

-- Owner text reply to a lifecycle item. Idempotent by request id (exact replay ⇒
-- 'replayed', same id; reuse with another payload ⇒ 'conflict'). Denials (flag OFF,
-- revoked session, no or ended authority, foreign id, staff) raise 42501 and write
-- nothing. Writes exactly one row in app.b023_owner_lifecycle_replies and nothing
-- else. Lock order: platform_settings rows (by key) -> organization -> auth session
-- -> owner contact -> property_owners rows -> lease (SHARE; B-012 notice writers
-- take it FOR UPDATE) -> request advisory lock.
CREATE FUNCTION app.b023_reply_owner_lifecycle(p_org uuid, p_session uuid, p_record uuid,
  p_notice_version integer, p_request uuid, p_body text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE v_contact uuid; v_item record; v_lease uuid; v_property uuid;
  prior app.b023_owner_lifecycle_replies%ROWTYPE; v_id uuid;
BEGIN
  IF p_org IS NULL OR p_session IS NULL OR p_record IS NULL OR p_request IS NULL THEN
    RAISE EXCEPTION 'Owner lifecycle unavailable' USING ERRCODE = '42501';
  END IF;
  IF NOT app.b023s2_lock_controls(p_org, true) THEN
    RAISE EXCEPTION 'Owner lifecycle unavailable' USING ERRCODE = '42501';
  END IF;
  IF NOT app.b023s2_lock_session(p_session) THEN
    RAISE EXCEPTION 'Owner lifecycle unavailable' USING ERRCODE = '42501';
  END IF;
  v_contact := app.b023_owner_contact(p_org);
  PERFORM 1 FROM public.contacts WHERE org_id = p_org AND id = v_contact FOR SHARE;
  SELECT n.lease_id, l.property_id INTO v_lease, v_property
    FROM app.b012_notice_versions n JOIN public.leases l ON l.org_id = n.org_id AND l.id = n.lease_id
   WHERE n.org_id = p_org AND n.record_id = p_record LIMIT 1;
  IF v_lease IS NULL THEN RAISE EXCEPTION 'Owner lifecycle unavailable' USING ERRCODE = '42501'; END IF;
  -- Recent authority recheck: lock this owner's windows on the property, then the
  -- lease, then re-admit through the same scope the reader uses.
  PERFORM 1 FROM public.property_owners
    WHERE org_id = p_org AND property_id = v_property AND owner_contact_id = v_contact ORDER BY id FOR SHARE;
  PERFORM 1 FROM public.leases WHERE org_id = p_org AND id = v_lease FOR SHARE;
  IF app.b023_owner_contact(p_org) IS DISTINCT FROM v_contact THEN
    RAISE EXCEPTION 'Owner lifecycle unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT s.* INTO v_item FROM app.b023s2_lifecycle_scope(p_org, v_contact) s WHERE s.record_id = p_record;
  IF NOT FOUND THEN RAISE EXCEPTION 'Owner lifecycle unavailable' USING ERRCODE = '42501'; END IF;
  IF p_body IS NULL OR length(p_body) NOT BETWEEN 1 AND 2000 OR p_body <> btrim(p_body)
    OR p_notice_version IS NULL OR p_notice_version < 1 THEN
    RETURN jsonb_build_object('state', 'invalid');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('b023_lifecycle_request:' || p_org || ':' || p_request, 0));
  SELECT * INTO prior FROM app.b023_owner_lifecycle_replies r WHERE r.org_id = p_org AND r.request_id = p_request;
  IF FOUND THEN
    IF prior.record_id = p_record AND prior.notice_version = p_notice_version AND prior.body = p_body
      AND prior.owner_contact_id = v_contact AND prior.actor_user_id = auth.uid() THEN
      RETURN jsonb_build_object('state', 'replayed', 'replyId', prior.id);
    END IF;
    RETURN jsonb_build_object('state', 'conflict');
  END IF;
  IF p_notice_version <> v_item.notice_version THEN RETURN jsonb_build_object('state', 'stale'); END IF;
  INSERT INTO app.b023_owner_lifecycle_replies(org_id, lease_id, record_id, notice_version, owner_contact_id,
    actor_user_id, request_id, body)
  VALUES (p_org, v_lease, p_record, p_notice_version, v_contact, auth.uid(), p_request, p_body)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('state', 'recorded', 'replyId', v_id);
END $$;
REVOKE ALL ON FUNCTION app.b023_reply_owner_lifecycle(uuid, uuid, uuid, integer, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b023_reply_owner_lifecycle(uuid, uuid, uuid, integer, uuid, text) TO authenticated;

-- One row per property on which the caller holds current authority; thread_id is
-- null until the owner sends the first message. Only the caller's own thread.
CREATE FUNCTION app.b023_owner_message_threads(p_org uuid)
RETURNS TABLE(property_id uuid, property_name text, thread_id uuid, last_message_at timestamptz, message_count integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
#variable_conflict use_column
DECLARE v_contact uuid;
BEGIN
  v_contact := app.b023_owner_contact(p_org);
  RETURN QUERY
  SELECT cp.property_id, p.name, ot.thread_id, mt.last_message_at,
         (SELECT count(*) FROM public.messages m WHERE m.org_id = p_org AND m.thread_id = ot.thread_id
            AND m.deleted_at IS NULL AND (m.sender_contact_id = v_contact OR m.sender_member_id IS NOT NULL))::integer
    FROM app.b023s2_current_properties(p_org, v_contact) cp
    JOIN public.properties p ON p.org_id = p_org AND p.id = cp.property_id
    LEFT JOIN app.b023_owner_threads ot ON ot.org_id = p_org AND ot.property_id = cp.property_id AND ot.owner_contact_id = v_contact
    LEFT JOIN public.message_threads mt ON mt.org_id = p_org AND mt.id = ot.thread_id
   ORDER BY mt.last_message_at DESC NULLS LAST, p.name, cp.property_id;
END $$;
REVOKE ALL ON FUNCTION app.b023_owner_message_threads(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b023_owner_message_threads(uuid) TO authenticated;

-- Messages of the caller's own thread for one currently authorized property. Only
-- the owner's own messages and company (staff member) messages; no sender names,
-- member ids, system rows, deleted rows or attachments. Edited rows are flagged.
CREATE FUNCTION app.b023_owner_thread_messages(p_org uuid, p_property uuid)
RETURNS TABLE(message_id uuid, sender text, body text, created_at timestamptz, edited boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
#variable_conflict use_column
DECLARE v_contact uuid;
BEGIN
  IF p_property IS NULL THEN RAISE EXCEPTION 'Owner messages unavailable' USING ERRCODE = '42501'; END IF;
  v_contact := app.b023_owner_contact(p_org);
  IF NOT EXISTS (SELECT 1 FROM app.b023s2_current_properties(p_org, v_contact) cp WHERE cp.property_id = p_property) THEN
    RAISE EXCEPTION 'Owner messages unavailable' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  -- edited: edited_at is set, or (owner's own message) the body no longer matches the
  -- digest recorded when the owner sent it (existing staff team_update can edit rows).
  SELECT m.id, CASE WHEN m.sender_contact_id = v_contact THEN 'owner' ELSE 'company' END, m.body, m.created_at,
         (m.edited_at IS NOT NULL OR EXISTS (SELECT 1 FROM app.b023_owner_message_requests q
            WHERE q.org_id = p_org AND q.message_id = m.id
              AND q.body_digest <> encode(sha256(convert_to(m.body, 'UTF8')), 'hex')))
    FROM app.b023_owner_threads ot
    JOIN public.messages m ON m.org_id = p_org AND m.thread_id = ot.thread_id
   WHERE ot.org_id = p_org AND ot.property_id = p_property AND ot.owner_contact_id = v_contact
     AND m.deleted_at IS NULL AND m.body IS NOT NULL
     AND (m.sender_contact_id = v_contact OR m.sender_member_id IS NOT NULL)
   ORDER BY m.created_at, m.id;
END $$;
REVOKE ALL ON FUNCTION app.b023_owner_thread_messages(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b023_owner_thread_messages(uuid, uuid) TO authenticated;

-- Owner post. Creates the property/owner thread on first use (reusing
-- public.message_threads), appends one public.messages row and one request row.
-- Idempotent by request id (replay of a since-deleted message ⇒ 'gone'); at most 30
-- owner messages per thread per rolling 24h ('rate_limited'); denials raise 42501
-- with zero writes. Lock order:
-- platform_settings -> organization -> auth session -> owner contact ->
-- property_owners rows -> thread advisory lock -> request advisory lock.
CREATE FUNCTION app.b023_post_owner_message(p_org uuid, p_session uuid, p_property uuid,
  p_request uuid, p_body text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE v_contact uuid; v_thread uuid; v_message uuid; v_digest text;
  prior app.b023_owner_message_requests%ROWTYPE;
BEGIN
  IF p_org IS NULL OR p_session IS NULL OR p_property IS NULL OR p_request IS NULL THEN
    RAISE EXCEPTION 'Owner messages unavailable' USING ERRCODE = '42501';
  END IF;
  IF NOT app.b023s2_lock_controls(p_org, false) THEN
    RAISE EXCEPTION 'Owner messages unavailable' USING ERRCODE = '42501';
  END IF;
  IF NOT app.b023s2_lock_session(p_session) THEN
    RAISE EXCEPTION 'Owner messages unavailable' USING ERRCODE = '42501';
  END IF;
  v_contact := app.b023_owner_contact(p_org);
  PERFORM 1 FROM public.contacts WHERE org_id = p_org AND id = v_contact FOR SHARE;
  PERFORM 1 FROM public.property_owners
    WHERE org_id = p_org AND property_id = p_property AND owner_contact_id = v_contact ORDER BY id FOR SHARE;
  IF app.b023_owner_contact(p_org) IS DISTINCT FROM v_contact
    OR NOT EXISTS (SELECT 1 FROM app.b023s2_current_properties(p_org, v_contact) cp WHERE cp.property_id = p_property) THEN
    RAISE EXCEPTION 'Owner messages unavailable' USING ERRCODE = '42501';
  END IF;
  IF p_body IS NULL OR length(p_body) NOT BETWEEN 1 AND 2000 OR p_body <> btrim(p_body) THEN
    RETURN jsonb_build_object('state', 'invalid');
  END IF;
  v_digest := encode(sha256(convert_to(p_body, 'UTF8')), 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('b023_owner_thread:' || p_org || ':' || p_property || ':' || v_contact, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('b023_message_request:' || p_org || ':' || p_request, 0));
  SELECT * INTO prior FROM app.b023_owner_message_requests r WHERE r.org_id = p_org AND r.request_id = p_request;
  IF FOUND THEN
    IF prior.property_id = p_property AND prior.owner_contact_id = v_contact AND prior.actor_user_id = auth.uid()
      AND prior.body_digest = v_digest THEN
      -- Never acknowledge a message that staff have since deleted (row or thread).
      IF NOT EXISTS (SELECT 1 FROM public.messages m WHERE m.org_id = p_org AND m.id = prior.message_id AND m.deleted_at IS NULL) THEN
        RETURN jsonb_build_object('state', 'gone');
      END IF;
      RETURN jsonb_build_object('state', 'replayed', 'messageId', prior.message_id);
    END IF;
    RETURN jsonb_build_object('state', 'conflict');
  END IF;
  SELECT ot.thread_id INTO v_thread FROM app.b023_owner_threads ot
   WHERE ot.org_id = p_org AND ot.property_id = p_property AND ot.owner_contact_id = v_contact;
  -- Volume cap: at most 30 owner messages per thread per rolling 24 hours.
  IF v_thread IS NOT NULL AND (SELECT count(*) FROM public.messages m WHERE m.org_id = p_org AND m.thread_id = v_thread
      AND m.sender_contact_id = v_contact AND m.created_at > now() - interval '24 hours') >= 30 THEN
    RETURN jsonb_build_object('state', 'rate_limited');
  END IF;
  IF v_thread IS NULL THEN
    INSERT INTO public.message_threads(org_id, kind, property_id)
    VALUES (p_org, 'owner_company'::public.thread_kind, p_property) RETURNING id INTO v_thread;
    INSERT INTO app.b023_owner_threads(thread_id, org_id, property_id, owner_contact_id, created_by)
    VALUES (v_thread, p_org, p_property, v_contact, auth.uid());
  END IF;
  INSERT INTO public.messages(org_id, thread_id, sender_user_id, sender_contact_id, body, inbound_channel)
  VALUES (p_org, v_thread, auth.uid(), v_contact, p_body, 'in_app') RETURNING id INTO v_message;
  UPDATE public.message_threads SET last_message_at = now() WHERE org_id = p_org AND id = v_thread;
  INSERT INTO app.b023_owner_message_requests(org_id, request_id, thread_id, message_id, property_id,
    owner_contact_id, actor_user_id, body_digest)
  VALUES (p_org, p_request, v_thread, v_message, p_property, v_contact, auth.uid(), v_digest);
  RETURN jsonb_build_object('state', 'recorded', 'messageId', v_message);
END $$;
REVOKE ALL ON FUNCTION app.b023_post_owner_message(uuid, uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b023_post_owner_message(uuid, uuid, uuid, uuid, text) TO authenticated;
-- Read-only staff surfaces, existing staff roles only (admin/manager: the roles of
-- messages.send and of B-012 management). Org/environment scoped through
-- app.has_role (active org + env pinning); other orgs, other roles, owners,
-- tenants and anonymous callers raise 42501.
CREATE FUNCTION app.b023s2_staff_ok(p_org uuid, p_lifecycle boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
  SELECT p_org IS NOT NULL AND auth.uid() IS NOT NULL AND app.b023_flag_on(p_org)
     AND (NOT p_lifecycle OR app.b012_flag_on(p_org))
     AND nullif(current_setting('app.active_org_id', true), '') = p_org::text
     AND coalesce(app.has_role(p_org, '{admin,manager}'::public.org_role[]), false);
$$;
REVOKE ALL ON FUNCTION app.b023s2_staff_ok(uuid, boolean) FROM PUBLIC, anon, authenticated, service_role;

-- Owner <-> company threads for the staff inbox: property, owner display name, last
-- activity and preview. Replies go through the existing staff message path.
CREATE FUNCTION app.b023_staff_owner_threads(p_org uuid)
RETURNS TABLE(thread_id uuid, property_id uuid, property_name text, owner_name text,
  last_message_at timestamptz, preview text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
#variable_conflict use_column
BEGIN
  IF NOT app.b023s2_staff_ok(p_org, false) THEN
    RAISE EXCEPTION 'Owner threads unavailable' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT ot.thread_id, ot.property_id, p.name, c.display_name, mt.last_message_at,
         (SELECT m.body FROM public.messages m WHERE m.org_id = p_org AND m.thread_id = ot.thread_id AND m.deleted_at IS NULL
           ORDER BY m.created_at DESC, m.id DESC LIMIT 1)
    FROM app.b023_owner_threads ot
    JOIN public.message_threads mt ON mt.org_id = p_org AND mt.id = ot.thread_id
    JOIN public.properties p ON p.org_id = p_org AND p.id = ot.property_id
    JOIN public.contacts c ON c.org_id = p_org AND c.id = ot.owner_contact_id
   WHERE ot.org_id = p_org
   ORDER BY mt.last_message_at DESC NULLS LAST, ot.thread_id;
END $$;
REVOKE ALL ON FUNCTION app.b023_staff_owner_threads(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b023_staff_owner_threads(uuid) TO authenticated;

-- Owner lifecycle replies on one lease, for the staff lease page. Read-only; shown
-- separately from B-012 tenant/company responses and never as a stance.
CREATE FUNCTION app.b023_staff_owner_lifecycle_replies(p_org uuid, p_lease uuid)
RETURNS TABLE(reply_id uuid, record_id uuid, notice_version integer, notice_kind text,
  owner_name text, body text, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
#variable_conflict use_column
BEGIN
  IF p_lease IS NULL OR NOT app.b023s2_staff_ok(p_org, true)
    OR NOT EXISTS (SELECT 1 FROM public.leases l WHERE l.org_id = p_org AND l.id = p_lease) THEN
    RAISE EXCEPTION 'Owner replies unavailable' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT r.id, r.record_id, r.notice_version, n.kind, c.display_name, r.body, r.created_at
    FROM app.b023_owner_lifecycle_replies r
    JOIN app.b012_notice_versions n ON n.org_id = r.org_id AND n.record_id = r.record_id AND n.version = r.notice_version
    JOIN public.contacts c ON c.org_id = r.org_id AND c.id = r.owner_contact_id
   WHERE r.org_id = p_org AND r.lease_id = p_lease
   ORDER BY r.created_at, r.id;
END $$;
REVOKE ALL ON FUNCTION app.b023_staff_owner_lifecycle_replies(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b023_staff_owner_lifecycle_replies(uuid, uuid) TO authenticated;
COMMIT;

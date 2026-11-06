-- B-023 slice 1: owner document center + read-only repair progress.
-- Additive only: one default-OFF platform setting, one private append-only access
-- log, and SECURITY DEFINER read gateways. No existing table, column, policy or
-- function changes; no backfill.
--
-- Authority model (reused, no new model): public.property_owners windows
-- [effective_from, effective_to) with an EXCLUSIVE end date, on the owner contact
-- bound to the caller (contacts.user_id = auth.uid(), is_owner, not archived).
-- * current  — a started window contains the property-local today.
-- * history  — the item overlaps only windows that have ended.
-- Dated content (document uploads, repair status entries) is returned only when its
-- property-local date lies INSIDE one of the caller's merged windows: never before
-- the first window start, in a gap between windows, or after the last window end.
-- Content outside every window of the caller (another owner's period, another
-- property, another organization) is never returned.
--
-- Opening or downloading a document writes one access row here and nothing else:
-- no consent, signature, acknowledgement, confirmation or read state changes.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

INSERT INTO public.platform_settings(key,value) VALUES
  ('owner_portal_extensions','{"enabled":false,"allowed_org_ids":[]}'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE app.b023_owner_document_access_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  owner_contact_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES auth.users(id),
  source_kind text NOT NULL CHECK (source_kind = 'lease_signed_pdf'),
  document_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  property_id uuid NOT NULL,
  access_kind text NOT NULL CHECK (access_kind IN ('view','download')),
  access_basis text NOT NULL CHECK (access_basis IN ('current','history')),
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, request_id),
  FOREIGN KEY (org_id, owner_contact_id) REFERENCES public.contacts(org_id, id)
);
CREATE INDEX b023_owner_document_access_events_doc_idx
  ON app.b023_owner_document_access_events(org_id, document_id, created_at);
ALTER TABLE app.b023_owner_document_access_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b023_owner_document_access_events FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION app.b023_history_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'Owner document access history is immutable' USING ERRCODE = '55000';
END $$;
REVOKE ALL ON FUNCTION app.b023_history_immutable() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER b023_access_no_change BEFORE UPDATE OR DELETE ON app.b023_owner_document_access_events
FOR EACH ROW EXECUTE FUNCTION app.b023_history_immutable();
CREATE TRIGGER b023_access_no_truncate BEFORE TRUNCATE ON app.b023_owner_document_access_events
FOR EACH STATEMENT EXECUTE FUNCTION app.b023_history_immutable();

-- Strict flag: global enabled === true, allowed_org_ids is an array containing the
-- org id, and organizations.feature_flags.owner_portal_extensions === true.
CREATE FUNCTION app.b023_flag_on(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.platform_settings f JOIN public.organizations o ON o.id = p_org
    WHERE f.key = 'owner_portal_extensions'
      AND jsonb_typeof(f.value) = 'object'
      AND f.value->'enabled' = 'true'::jsonb
      AND jsonb_typeof(f.value->'allowed_org_ids') = 'array'
      AND f.value->'allowed_org_ids' @> jsonb_build_array(p_org::text)
      AND jsonb_typeof(o.feature_flags) = 'object'
      AND o.feature_flags->'owner_portal_extensions' = 'true'::jsonb
  );
$$;
REVOKE ALL ON FUNCTION app.b023_flag_on(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION app.b023_flag_locked(p_org uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
  PERFORM 1 FROM public.platform_settings WHERE key = 'owner_portal_extensions' FOR SHARE;
  PERFORM 1 FROM public.organizations WHERE id = p_org FOR SHARE;
  RETURN app.b023_flag_on(p_org);
END $$;
REVOKE ALL ON FUNCTION app.b023_flag_locked(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- The caller's single active owner contact in the pinned organization/environment.
-- Staff of the organization (or its live org) never read through the owner path.
CREATE FUNCTION app.b023_owner_contact(p_org uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE v_ids uuid[];
BEGIN
  IF p_org IS NULL OR auth.uid() IS NULL OR NOT app.b023_flag_on(p_org) THEN
    RAISE EXCEPTION 'Owner portal unavailable' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.organizations o WHERE o.id = p_org
      AND (nullif(current_setting('app.active_org_id', true), '') IS NULL
        OR current_setting('app.active_org_id', true) = p_org::text)
      AND (nullif(current_setting('app.env', true), '') IS NULL
        OR current_setting('app.env', true) = o.environment::text)
  ) THEN
    RAISE EXCEPTION 'Owner portal unavailable' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.organizations o JOIN public.org_members m
      ON m.org_id IN (o.id, coalesce(o.live_org_id, o.id))
    WHERE o.id = p_org AND m.user_id = auth.uid() AND m.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Owner portal unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT array_agg(c.id) INTO v_ids FROM public.contacts c
    WHERE c.org_id = p_org AND c.user_id = auth.uid() AND c.is_owner AND c.archived_at IS NULL;
  IF coalesce(cardinality(v_ids), 0) <> 1 THEN
    RAISE EXCEPTION 'Owner portal unavailable' USING ERRCODE = '42501';
  END IF;
  RETURN v_ids[1];
END $$;
REVOKE ALL ON FUNCTION app.b023_owner_contact(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Per property: merged started windows and the window containing local today (if any).
CREATE FUNCTION app.b023_owner_authority(p_org uuid, p_contact uuid)
RETURNS TABLE(property_id uuid, timezone text, today date, windows datemultirange,
  current_window daterange)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
  WITH w AS (
    SELECT po.property_id, p.timezone, (now() AT TIME ZONE p.timezone)::date AS today,
           daterange(po.effective_from, po.effective_to, '[)') AS r
      FROM public.property_owners po
      JOIN public.properties p ON p.org_id = po.org_id AND p.id = po.property_id
     WHERE po.org_id = p_org AND po.owner_contact_id = p_contact
       AND (po.effective_to IS NULL OR po.effective_to > po.effective_from)
       AND po.effective_from <= (now() AT TIME ZONE p.timezone)::date
  ), m AS (
    SELECT w.property_id, min(w.timezone) AS timezone, min(w.today) AS today, range_agg(w.r) AS windows
      FROM w GROUP BY w.property_id
  )
  SELECT m.property_id, m.timezone, m.today, m.windows,
         (SELECT x FROM unnest(m.windows) x WHERE x @> m.today LIMIT 1)
    FROM m;
$$;
REVOKE ALL ON FUNCTION app.b023_owner_authority(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;


-- Paper-signed lease PDFs on leases whose term overlaps one of the caller's windows.
-- Only versions uploaded on a property-local date inside one of the caller's windows.
-- Version currency uses the same rule as the tenant signed-PDF list. Metadata only.
CREATE FUNCTION app.b023_owner_documents(p_org uuid)
RETURNS TABLE(document_id uuid, lease_id uuid, property_id uuid, property_name text,
  unit_label text, room_label text, lease_start date, lease_end date, lease_status text,
  uploaded_at timestamptz, size_bytes integer, is_current_version boolean, access text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
  WITH me AS (SELECT app.b023_owner_contact(p_org) AS contact),
  a AS (SELECT x.* FROM me CROSS JOIN LATERAL app.b023_owner_authority(p_org, me.contact) x),
  s AS (
    SELECT l.id AS l_id, l.property_id AS l_property, l.unit_id AS l_unit, l.target_room_id AS l_room,
           l.start_date AS l_start, l.status::text AS l_status, l.document_file_id AS l_pointer,
           e.end_on AS l_end, daterange(l.start_date, e.end_on, '[]') AS l_term,
           a.timezone AS tz, a.windows, a.current_window
      FROM public.leases l
      JOIN a ON a.property_id = l.property_id
      CROSS JOIN LATERAL (SELECT CASE WHEN least(l.end_date, l.terminated_on) IS NULL THEN NULL::date
             ELSE greatest(l.start_date, least(l.end_date, l.terminated_on)) END AS end_on) e
     WHERE l.org_id = p_org AND l.status IN ('pending_signature','active','ended','terminated')
  ), scoped AS (
    SELECT s.*, (s.current_window IS NOT NULL AND s.current_window && s.l_term) AS is_current_access
      FROM s WHERE s.windows && s.l_term
  ), ranked AS (
    SELECT pdf.id AS d_id, pdf.created_at AS d_at, octet_length(pdf.content) AS d_size, sc.*,
           coalesce(pdf.file_id = sc.l_pointer, false) AS d_pointer,
           bool_or(coalesce(pdf.file_id = sc.l_pointer, false)) OVER (PARTITION BY pdf.lease_id) AS d_has_pointer,
           row_number() OVER (PARTITION BY pdf.lease_id ORDER BY pdf.created_at DESC, pdf.id DESC) AS d_newest
      FROM public.lease_signed_pdfs pdf
      JOIN scoped sc ON pdf.org_id = p_org AND pdf.lease_id = sc.l_id
  )
  SELECT r.d_id, r.l_id, r.l_property, p.name, u.label, rm.label, r.l_start, r.l_end, r.l_status,
         r.d_at, r.d_size, (r.d_pointer OR (NOT r.d_has_pointer AND r.d_newest = 1)),
         CASE WHEN r.is_current_access THEN 'current' ELSE 'history' END
    FROM ranked r
    JOIN public.properties p ON p.org_id = p_org AND p.id = r.l_property
    LEFT JOIN public.units u ON u.org_id = p_org AND u.id = r.l_unit
    LEFT JOIN public.rooms rm ON rm.org_id = p_org AND rm.id = r.l_room
   WHERE r.windows @> (r.d_at AT TIME ZONE r.tz)::date
   ORDER BY p.name, r.l_start DESC, r.d_at DESC, r.d_id DESC;
$$;
REVOKE ALL ON FUNCTION app.b023_owner_documents(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b023_owner_documents(uuid) TO authenticated;

-- Authorized open (view or download): re-admits the document through
-- b023_owner_documents, appends exactly one access row per request id and returns
-- the bytes. Exact replays return the bytes without a second row. It writes nothing
-- else: no consent, signature, acknowledgement, confirmation or read state.
CREATE FUNCTION app.b023_open_owner_document(p_org uuid, p_document uuid, p_request uuid, p_kind text)
RETURNS TABLE(content bytea, file_name text, size_bytes integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
#variable_conflict use_column
DECLARE v_contact uuid; d record; prior app.b023_owner_document_access_events%ROWTYPE;
BEGIN
  IF p_org IS NULL OR p_document IS NULL OR p_request IS NULL OR p_kind IS NULL
    OR p_kind NOT IN ('view','download') THEN
    RAISE EXCEPTION 'Document unavailable' USING ERRCODE = '42501';
  END IF;
  IF NOT app.b023_flag_locked(p_org) THEN
    RAISE EXCEPTION 'Owner portal unavailable' USING ERRCODE = '42501';
  END IF;
  v_contact := app.b023_owner_contact(p_org);
  PERFORM 1 FROM public.contacts WHERE id = v_contact FOR SHARE;
  SELECT x.document_id, x.lease_id, x.property_id, x.access INTO d
    FROM app.b023_owner_documents(p_org) x WHERE x.document_id = p_document;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Document unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('b023_access_request:' || p_org || ':' || p_request, 0));
  SELECT * INTO prior FROM app.b023_owner_document_access_events e
    WHERE e.org_id = p_org AND e.request_id = p_request;
  IF FOUND THEN
    IF prior.document_id <> p_document OR prior.access_kind <> p_kind
      OR prior.owner_contact_id <> v_contact OR prior.actor_user_id <> auth.uid() THEN
      RAISE EXCEPTION 'Document request conflict' USING ERRCODE = '42501';
    END IF;
  ELSE
    INSERT INTO app.b023_owner_document_access_events(org_id, owner_contact_id, actor_user_id,
      source_kind, document_id, lease_id, property_id, access_kind, access_basis, request_id)
    VALUES (p_org, v_contact, auth.uid(), 'lease_signed_pdf', d.document_id, d.lease_id,
      d.property_id, p_kind, d.access, p_request);
  END IF;
  RETURN QUERY SELECT pdf.content, 'signed-lease-' || pdf.id::text || '.pdf', octet_length(pdf.content)
    FROM public.lease_signed_pdfs pdf WHERE pdf.org_id = p_org AND pdf.id = p_document;
END $$;
REVOKE ALL ON FUNCTION app.b023_open_owner_document(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b023_open_owner_document(uuid, uuid, uuid, text) TO authenticated;

-- Repairs on the caller's properties whose life overlaps one of the caller's windows.
-- Owner-safe fields only: no description, comment bodies, internal entries,
-- reporter, assignee, vendor, cost or tenant contact data. Status entries are listed
-- only when dated inside one of the caller's windows; history items show the status
-- of the last such entry.
CREATE FUNCTION app.b023_owner_repair_scope(p_org uuid)
RETURNS TABLE(ticket_id uuid, ticket_number integer, property_id uuid, unit_id uuid, room_id uuid,
  category text, priority text, live_status text, title text, reported_at timestamptz,
  tz text, windows datemultirange, is_current_access boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
  WITH me AS (SELECT app.b023_owner_contact(p_org) AS contact),
  a AS (SELECT x.* FROM me CROSS JOIN LATERAL app.b023_owner_authority(p_org, me.contact) x)
  SELECT t.id, t.ticket_number, t.property_id, t.unit_id, t.room_id, t.category::text, t.priority::text,
         t.status::text, t.title, t.created_at, a.timezone, a.windows,
         (a.current_window IS NOT NULL AND a.current_window && k.span)
    FROM public.maintenance_tickets t
    JOIN a ON a.property_id = t.property_id
    CROSS JOIN LATERAL (SELECT (t.created_at AT TIME ZONE a.timezone)::date AS opened) o
    CROSS JOIN LATERAL (SELECT daterange(o.opened,
      CASE WHEN t.status IN ('resolved','closed','cancelled')
           THEN greatest(o.opened, (coalesce(t.closed_at, t.resolved_at, t.updated_at) AT TIME ZONE a.timezone)::date)
      END, '[]') AS span) k
   WHERE t.org_id = p_org AND a.windows && k.span;
$$;
REVOKE ALL ON FUNCTION app.b023_owner_repair_scope(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION app.b023_owner_repair_events(p_org uuid, p_ticket uuid, p_tz text, p_windows datemultirange)
RETURNS TABLE(status_from text, status_to text, occurred_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
  SELECT c.status_from::text, c.status_to::text, c.created_at
    FROM public.ticket_comments c
   WHERE c.org_id = p_org AND c.ticket_id = p_ticket AND c.status_to IS NOT NULL AND NOT c.is_internal
     AND p_windows @> (c.created_at AT TIME ZONE p_tz)::date
   ORDER BY c.created_at, c.id;
$$;
REVOKE ALL ON FUNCTION app.b023_owner_repair_events(uuid, uuid, text, datemultirange) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION app.b023_owner_repairs(p_org uuid)
RETURNS TABLE(ticket_id uuid, ticket_number integer, property_name text, unit_label text, room_label text,
  category text, priority text, status text, title text, reported_at timestamptz,
  last_status_at timestamptz, access text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
  SELECT r.ticket_id, r.ticket_number, p.name, u.label, rm.label, r.category, r.priority,
         CASE WHEN r.is_current_access THEN r.live_status ELSE coalesce(last_ev.status_to, 'open') END,
         r.title, r.reported_at, last_ev.occurred_at,
         CASE WHEN r.is_current_access THEN 'current' ELSE 'history' END
    FROM app.b023_owner_repair_scope(p_org) r
    JOIN public.properties p ON p.org_id = p_org AND p.id = r.property_id
    LEFT JOIN public.units u ON u.org_id = p_org AND u.id = r.unit_id
    LEFT JOIN public.rooms rm ON rm.org_id = p_org AND rm.id = r.room_id
    LEFT JOIN LATERAL (
      SELECT ev.status_to, ev.occurred_at FROM app.b023_owner_repair_events(p_org, r.ticket_id, r.tz, r.windows) ev
       ORDER BY ev.occurred_at DESC LIMIT 1
    ) last_ev ON true
   ORDER BY (CASE WHEN r.is_current_access THEN 0 ELSE 1 END), r.reported_at DESC, r.ticket_id;
$$;
REVOKE ALL ON FUNCTION app.b023_owner_repairs(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b023_owner_repairs(uuid) TO authenticated;

CREATE FUNCTION app.b023_owner_repair_detail(p_org uuid, p_ticket uuid)
RETURNS TABLE(ticket_id uuid, ticket_number integer, property_name text, unit_label text, room_label text,
  category text, priority text, status text, title text, reported_at timestamptz,
  last_status_at timestamptz, access text, timeline jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
#variable_conflict use_column
DECLARE r record;
BEGIN
  IF p_ticket IS NULL THEN RAISE EXCEPTION 'Repair unavailable' USING ERRCODE = '42501'; END IF;
  SELECT s.* INTO r FROM app.b023_owner_repair_scope(p_org) s
   WHERE s.ticket_id = p_ticket;
  IF NOT FOUND THEN RAISE EXCEPTION 'Repair unavailable' USING ERRCODE = '42501'; END IF;
  RETURN QUERY
  SELECT l.ticket_id, l.ticket_number, l.property_name, l.unit_label, l.room_label, l.category, l.priority,
         l.status, l.title, l.reported_at, l.last_status_at, l.access,
         coalesce((SELECT jsonb_agg(jsonb_build_object('from', ev.status_from, 'to', ev.status_to, 'at', ev.occurred_at) ORDER BY ev.occurred_at)
           FROM app.b023_owner_repair_events(p_org, p_ticket, r.tz, r.windows) ev), '[]'::jsonb)
    FROM app.b023_owner_repairs(p_org) l WHERE l.ticket_id = p_ticket;
END $$;
REVOKE ALL ON FUNCTION app.b023_owner_repair_detail(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b023_owner_repair_detail(uuid, uuid) TO authenticated;
COMMIT;

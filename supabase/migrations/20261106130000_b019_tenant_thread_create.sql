-- B-019: a tenant can start the lease conversation when none exists (CAP-T-12).
-- Flag tenant_thread_create seeded OFF. The existing unique index
-- message_threads_one_per_lease already guarantees one lease thread; this RPC creates it
-- idempotently together with participants and the first message (message id = request id).
BEGIN;
SET LOCAL lock_timeout = '5s';
INSERT INTO public.platform_settings(key, value)
VALUES ('tenant_thread_create', '{"enabled":false,"allowed_org_ids":[]}'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE FUNCTION app.b019_start_tenant_thread(p_lease uuid, p_request uuid, p_body text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_org uuid; v_property uuid; v_status text; v_contact uuid; v_thread uuid; v_flags jsonb; v_global jsonb;
  prior public.messages%ROWTYPE;
BEGIN
  SELECT l.org_id, l.property_id, l.status::text INTO v_org, v_property, v_status FROM public.leases l WHERE l.id = p_lease;
  IF v_org IS NULL OR v_actor IS NULL OR p_request IS NULL THEN
    RAISE EXCEPTION 'Conversation unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.platform_settings WHERE key = 'tenant_thread_create' FOR SHARE;
  SELECT value INTO v_global FROM public.platform_settings WHERE key = 'tenant_thread_create';
  SELECT feature_flags INTO v_flags FROM public.organizations WHERE id = v_org FOR SHARE;
  -- IS NOT TRUE: a missing row/key (SQL NULL) is OFF, never a pass.
  IF (v_global->'enabled' = 'true'::jsonb AND jsonb_typeof(v_global->'allowed_org_ids') = 'array'
      AND v_global->'allowed_org_ids' @> jsonb_build_array(v_org::text) AND v_flags->'tenant_thread_create' = 'true'::jsonb) IS NOT TRUE THEN
    RAISE EXCEPTION 'Conversation unavailable' USING ERRCODE = '42501';
  END IF;
  -- Pinned scope must match the lease's organization.
  IF nullif(current_setting('app.active_org_id', true), '') IS DISTINCT FROM v_org::text
     OR nullif(current_setting('app.env', true), '') IS DISTINCT FROM (SELECT o.environment::text FROM public.organizations o WHERE o.id = v_org) THEN
    RAISE EXCEPTION 'Conversation unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT c.id INTO v_contact FROM public.lease_parties lp JOIN public.contacts c ON c.org_id = lp.org_id AND c.id = lp.contact_id
   WHERE lp.lease_id = p_lease AND lp.org_id = v_org AND lp.role IN ('primary','co_tenant','occupant')
     AND c.user_id = v_actor AND c.is_tenant AND c.archived_at IS NULL
   ORDER BY lp.role = 'primary' DESC, c.id LIMIT 1;
  IF v_contact IS NULL OR v_status NOT IN ('active', 'pending_signature') THEN
    RAISE EXCEPTION 'Conversation unavailable' USING ERRCODE = '42501';
  END IF;
  IF p_body IS NULL OR btrim(p_body) = '' OR char_length(p_body) > 4000 THEN
    RAISE EXCEPTION 'Message required' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('b019_thread:' || p_lease::text, 0));
  SELECT * INTO prior FROM public.messages WHERE id = p_request;
  IF FOUND THEN
    IF prior.org_id = v_org AND prior.sender_user_id = v_actor AND prior.body = btrim(p_body)
       AND EXISTS (SELECT 1 FROM public.message_threads t WHERE t.id = prior.thread_id AND t.lease_id = p_lease AND t.kind = 'lease') THEN
      RETURN prior.thread_id;
    END IF;
    RAISE EXCEPTION 'Conversation request conflict' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.message_threads(org_id, kind, lease_id, property_id) VALUES (v_org, 'lease', p_lease, v_property)
  ON CONFLICT (lease_id) WHERE kind = 'lease' DO NOTHING;
  SELECT t.id INTO v_thread FROM public.message_threads t WHERE t.lease_id = p_lease AND t.kind = 'lease';
  INSERT INTO public.thread_participants(org_id, thread_id, contact_id)
  SELECT v_org, v_thread, lp.contact_id FROM public.lease_parties lp
   JOIN public.contacts pc ON pc.org_id = lp.org_id AND pc.id = lp.contact_id
   WHERE lp.lease_id = p_lease AND lp.org_id = v_org
     -- Only current, eligible tenant parties join; archived or non-tenant contacts never gain access.
     AND lp.role IN ('primary','co_tenant','occupant') AND pc.is_tenant AND pc.archived_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.thread_participants tp WHERE tp.thread_id = v_thread AND tp.contact_id = lp.contact_id);
  INSERT INTO public.messages(id, org_id, thread_id, sender_user_id, sender_contact_id, body, inbound_channel)
  VALUES (p_request, v_org, v_thread, v_actor, v_contact, btrim(p_body), 'in_app');
  RETURN v_thread;
END $$;
REVOKE ALL ON FUNCTION app.b019_start_tenant_thread(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app.b019_start_tenant_thread(uuid, uuid, text) TO authenticated;
COMMIT;

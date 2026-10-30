BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Both switches require the explicit per-org bit and the global allowlist.
INSERT INTO public.platform_settings(key,value,description) VALUES
  ('rent_reminders_v2','{"enabled":false,"allowed_org_ids":[]}'::jsonb,'Local reminder event rollout'),
  ('payment_results_v2','{"enabled":false,"allowed_org_ids":[]}'::jsonb,'Local payment result event rollout')
ON CONFLICT(key) DO NOTHING;

-- No rendered content, address, account number, reason text or bearer token.
CREATE TABLE app.b010_source_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  lease_id uuid NOT NULL,
  invoice_id uuid,
  payment_id uuid,
  kind text NOT NULL CHECK (kind IN ('rent_due','rent_overdue','rent_manual','payment_confirmed','payment_rejected','payment_reversed')),
  occurrence_key text NOT NULL CHECK (length(occurrence_key) BETWEEN 1 AND 128),
  actor_id uuid REFERENCES auth.users(id),
  local_date date,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (org_id,id),
  FOREIGN KEY (org_id,lease_id) REFERENCES public.leases(org_id,id),
  FOREIGN KEY (org_id,invoice_id) REFERENCES public.invoices(org_id,id),
  FOREIGN KEY (org_id,payment_id) REFERENCES public.payments(org_id,id),
  CHECK ((kind IN ('rent_due','rent_overdue','rent_manual') AND invoice_id IS NOT NULL AND payment_id IS NULL)
      OR (kind IN ('payment_confirmed','payment_rejected','payment_reversed') AND payment_id IS NOT NULL AND invoice_id IS NULL)),
  CHECK ((kind IN ('rent_due','rent_overdue') AND local_date IS NOT NULL AND actor_id IS NULL)
      OR (kind = 'rent_manual' AND local_date IS NOT NULL AND actor_id IS NOT NULL)
      OR (kind LIKE 'payment_%' AND actor_id IS NOT NULL))
);
CREATE UNIQUE INDEX b010_reminder_occurrence ON app.b010_source_events(org_id,kind,invoice_id,occurrence_key) WHERE invoice_id IS NOT NULL;
CREATE UNIQUE INDEX b010_manual_request ON app.b010_source_events(org_id,actor_id,occurrence_key) WHERE kind='rent_manual';
CREATE UNIQUE INDEX b010_payment_transition ON app.b010_source_events(org_id,kind,payment_id) WHERE payment_id IS NOT NULL;

-- Event-time principal is immutable, independently of later contact reassignment.
CREATE TABLE app.b028_recipient_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  event_id uuid NOT NULL,
  principal_user_id uuid REFERENCES auth.users(id),
  contact_id uuid,
  member_id uuid,
  channel text NOT NULL CHECK (channel = 'email'),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','claimed','captured','failed')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  claim_token uuid,
  claimed_until timestamptz,
  completed_at timestamptz,
  capture_digest text CHECK (capture_digest IS NULL OR capture_digest ~ '^[0-9a-f]{64}$'),
  failure_code text CHECK (failure_code IS NULL OR failure_code IN ('capture_failed','claim_expired')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(org_id,id),
  FOREIGN KEY (org_id,event_id) REFERENCES app.b010_source_events(org_id,id),
  FOREIGN KEY (org_id,contact_id) REFERENCES public.contacts(org_id,id),
  FOREIGN KEY (org_id,member_id) REFERENCES public.org_members(org_id,id),
  CHECK (num_nonnulls(contact_id,member_id)=1),
  CHECK (member_id IS NULL OR principal_user_id IS NOT NULL),
  CHECK ((state='claimed' AND claim_token IS NOT NULL AND claimed_until IS NOT NULL)
      OR (state<>'claimed' AND claim_token IS NULL AND claimed_until IS NULL)),
  CHECK (state <> 'captured' OR (completed_at IS NOT NULL AND capture_digest IS NOT NULL)),
  CHECK (state <> 'failed' OR failure_code IS NOT NULL)
);
CREATE UNIQUE INDEX b028_contact_claim ON app.b028_recipient_claims(org_id,event_id,contact_id,channel) WHERE contact_id IS NOT NULL;
CREATE UNIQUE INDEX b028_member_claim ON app.b028_recipient_claims(org_id,event_id,member_id,channel) WHERE member_id IS NOT NULL;
CREATE UNIQUE INDEX b028_principal_claim ON app.b028_recipient_claims(org_id,event_id,principal_user_id,channel) WHERE principal_user_id IS NOT NULL;

-- No row means the tenant's due reminder is enabled; only the tenant may change it.
CREATE TABLE app.b010_tenant_due_preferences (
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  due_enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(org_id,user_id)
);
REVOKE ALL ON app.b010_tenant_due_preferences FROM PUBLIC,anon,authenticated,service_role;

CREATE TABLE app.b028_read_markers (
  org_id uuid NOT NULL,
  claim_id uuid NOT NULL,
  principal_user_id uuid NOT NULL REFERENCES auth.users(id),
  read_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(org_id,claim_id,principal_user_id),
  FOREIGN KEY (org_id,claim_id) REFERENCES app.b028_recipient_claims(org_id,id)
);

-- Form retries are bound to a payload digest and resulting payment. No payload is stored here.
CREATE TABLE app.b010_payment_commands (
  org_id uuid NOT NULL REFERENCES public.organizations(id),
  actor_id uuid NOT NULL REFERENCES auth.users(id),
  request_id uuid NOT NULL,
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  payment_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id,actor_id,request_id),
  FOREIGN KEY (org_id,payment_id) REFERENCES public.payments(org_id,id)
);
REVOKE ALL ON app.b010_source_events,app.b028_recipient_claims,app.b028_read_markers,app.b010_payment_commands FROM PUBLIC,anon,authenticated,service_role;

-- Legacy group claims must not be created or erased after the new path owns
-- this org. NOWAIT avoids waiting after an older writer owns a child tuple.
CREATE FUNCTION app.b010_fence_legacy_reminders() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_enabled boolean;
BEGIN
  -- Completion metadata may be updated to preserve evidence of an old send;
  -- never allow an identity change to hide or manufacture an overlap.
  IF TG_OP='UPDATE' AND NEW.org_id IS NOT DISTINCT FROM OLD.org_id
    AND NEW.kind IS NOT DISTINCT FROM OLD.kind AND NEW.target_id IS NOT DISTINCT FROM OLD.target_id
    AND NEW.threshold IS NOT DISTINCT FROM OLD.threshold THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' AND NEW.kind NOT IN ('rent_overdue_admin','rent_overdue_tenant') THEN RETURN NEW; END IF;
  IF TG_OP='DELETE' AND OLD.kind NOT IN ('rent_overdue_admin','rent_overdue_tenant') THEN RETURN OLD; END IF;
  IF TG_OP='UPDATE' AND NEW.kind NOT IN ('rent_overdue_admin','rent_overdue_tenant')
    AND OLD.kind NOT IN ('rent_overdue_admin','rent_overdue_tenant') THEN RETURN NEW; END IF;
  LOCK TABLE public.platform_settings IN SHARE MODE NOWAIT;
  IF TG_OP <> 'INSERT' THEN PERFORM 1 FROM public.organizations WHERE id=OLD.org_id FOR SHARE NOWAIT; END IF;
  IF TG_OP <> 'DELETE' THEN PERFORM 1 FROM public.organizations WHERE id=NEW.org_id FOR SHARE NOWAIT; END IF;
  SELECT EXISTS (SELECT 1 FROM public.organizations o JOIN public.platform_settings p ON p.key='rent_reminders_v2'
    WHERE ((TG_OP <> 'INSERT' AND o.id=OLD.org_id AND OLD.kind IN ('rent_overdue_admin','rent_overdue_tenant'))
       OR (TG_OP <> 'DELETE' AND o.id=NEW.org_id AND NEW.kind IN ('rent_overdue_admin','rent_overdue_tenant')))
      AND o.feature_flags->'rent_reminders_v2'='true'::jsonb
      AND p.value->'enabled'='true'::jsonb AND jsonb_typeof(p.value->'allowed_org_ids')='array'
      AND p.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) INTO v_enabled;
  IF v_enabled THEN RAISE EXCEPTION 'Legacy reminder claim unavailable' USING ERRCODE='42501'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
REVOKE ALL ON FUNCTION app.b010_fence_legacy_reminders() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b010_fence_legacy_reminders BEFORE INSERT OR UPDATE OR DELETE ON public.email_log
  FOR EACH ROW EXECUTE FUNCTION app.b010_fence_legacy_reminders();

-- The action accepts a stable request ID, never an actor or recipient ID.
CREATE FUNCTION app.b010_manual_reminder(p_org uuid,p_live_org uuid,p_environment text,p_session uuid,p_lease uuid,p_invoice uuid,p_request uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE v_actor uuid := auth.uid(); v_lease uuid; v_date date; v_key text; v_event uuid; v_count integer;
BEGIN
  IF v_actor IS NULL OR p_request IS NULL OR p_environment NOT IN ('live','sandbox') THEN
    RAISE EXCEPTION 'Reminder unavailable' USING ERRCODE='42501';
  END IF;
  LOCK TABLE public.platform_settings IN SHARE MODE NOWAIT;
  PERFORM 1 FROM public.organizations o JOIN public.org_members m
       ON m.org_id=CASE WHEN o.environment='sandbox' THEN o.live_org_id ELSE o.id END
       JOIN public.auth_sessions s ON s.id=p_session AND s.user_id=v_actor
       JOIN public.platform_settings f ON f.key='rent_reminders_v2'
      WHERE o.id=p_org AND o.environment::text=p_environment
        AND ((o.environment='live' AND o.id=p_live_org AND o.live_org_id IS NULL) OR (o.environment='sandbox' AND o.live_org_id=p_live_org))
        AND m.user_id=v_actor AND m.status='active' AND m.role IN ('admin','manager')
        AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
        AND o.feature_flags->'rent_reminders_v2'='true'::jsonb AND f.value->'enabled'='true'::jsonb
        AND jsonb_typeof(f.value->'allowed_org_ids')='array' AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)
      FOR SHARE OF o,m,s NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reminder unavailable' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.reminder_rules r WHERE r.org_id=p_org AND r.event_type='rent_overdue' AND r.is_enabled AND 'email'=ANY(r.channels) FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reminder unavailable' USING ERRCODE='42501'; END IF;
  SELECT i.lease_id INTO v_lease FROM public.invoices i WHERE i.id=p_invoice AND i.org_id=p_org;
  IF v_lease IS NULL OR v_lease IS DISTINCT FROM p_lease THEN RAISE EXCEPTION 'Reminder unavailable' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.leases l WHERE l.id=v_lease AND l.org_id=p_org FOR SHARE;
  PERFORM 1 FROM public.invoices i WHERE i.id=p_invoice AND i.org_id=p_org AND i.lease_id=v_lease FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reminder unavailable' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.auth_sessions s WHERE s.id=p_session AND s.user_id=v_actor
      AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()) THEN
    RAISE EXCEPTION 'Reminder unavailable' USING ERRCODE='42501';
  END IF;
  SELECT (clock_timestamp() AT TIME ZONE o.timezone)::date INTO v_date
    FROM public.leases l JOIN public.organizations o ON o.id=l.org_id
    JOIN public.invoices i ON i.lease_id=l.id AND i.org_id=l.org_id
    WHERE l.id=v_lease AND l.org_id=p_org AND i.id=p_invoice AND l.status='active' AND l.terminated_on IS NULL
      AND i.status IN ('open','partially_paid') AND i.balance_minor>0
      AND EXISTS (SELECT 1 FROM public.invoice_lines il WHERE il.org_id=i.org_id AND il.invoice_id=i.id AND il.charge_type='rent' AND il.amount_minor>0);
  IF v_date IS NULL OR EXISTS (SELECT 1 FROM public.email_log e WHERE e.org_id=p_org AND e.target_id=p_invoice AND e.kind IN ('rent_overdue_admin','rent_overdue_tenant')) THEN
    RAISE EXCEPTION 'Reminder unavailable' USING ERRCODE='42501';
  END IF;
  v_key := 'manual:' || p_request::text;
  SELECT e.id INTO v_event FROM app.b010_source_events e WHERE e.org_id=p_org AND e.actor_id=v_actor AND e.kind='rent_manual' AND e.occurrence_key=v_key;
  IF v_event IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM app.b010_source_events WHERE id=v_event AND org_id=p_org AND lease_id=v_lease AND invoice_id=p_invoice) THEN
      RAISE EXCEPTION 'Reminder unavailable' USING ERRCODE='42501';
    END IF;
    RETURN v_event;
  END IF;
  INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,actor_id,local_date)
    VALUES(p_org,v_lease,p_invoice,'rent_manual',v_key,v_actor,v_date) RETURNING id INTO v_event;
  INSERT INTO app.b028_recipient_claims(org_id,event_id,principal_user_id,contact_id,channel)
    SELECT DISTINCT p_org,v_event,c.user_id,c.id,'email' FROM public.lease_parties lp
    JOIN public.contacts c ON c.id=lp.contact_id AND c.org_id=lp.org_id
    WHERE lp.org_id=p_org AND lp.lease_id=v_lease AND lp.role IN ('primary','co_tenant')
      AND c.archived_at IS NULL AND c.email IS NOT NULL AND btrim(c.email::text)<>''
      AND EXISTS (SELECT 1 FROM public.organizations o WHERE o.id=p_org AND coalesce(o.settings->>'email_tenant_rent_overdue','true') <> 'false');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count=0 THEN RAISE EXCEPTION 'Reminder unavailable' USING ERRCODE='42501'; END IF;
  RETURN v_event;
END $$;
REVOKE ALL ON FUNCTION app.b010_manual_reminder(uuid,uuid,text,uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b010_manual_reminder(uuid,uuid,text,uuid,uuid,uuid,uuid) TO service_role;

CREATE FUNCTION app.b010_manual_status(p_org uuid,p_live_org uuid,p_environment text,p_session uuid,p_lease uuid,p_event uuid)
RETURNS TABLE(queued bigint,claimed bigint,captured bigint,failed bigint)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
  SELECT count(*) FILTER (WHERE c.state='queued'),count(*) FILTER (WHERE c.state='claimed'),
         count(*) FILTER (WHERE c.state='captured'),count(*) FILTER (WHERE c.state='failed')
    FROM app.b010_source_events e JOIN app.b028_recipient_claims c ON c.org_id=e.org_id AND c.event_id=e.id
    JOIN public.organizations o ON o.id=e.org_id
    JOIN public.org_members m ON m.org_id=CASE WHEN o.environment='sandbox' THEN o.live_org_id ELSE o.id END
    JOIN public.auth_sessions s ON s.id=p_session AND s.user_id=auth.uid()
    JOIN public.platform_settings f ON f.key='rent_reminders_v2'
   WHERE e.id=p_event AND e.org_id=p_org AND e.lease_id=p_lease AND e.kind='rent_manual' AND e.actor_id=auth.uid()
     AND o.environment::text=p_environment AND ((o.environment='live' AND o.id=p_live_org AND o.live_org_id IS NULL) OR (o.environment='sandbox' AND o.live_org_id=p_live_org))
     AND m.user_id=auth.uid() AND m.status='active' AND m.role IN ('admin','manager')
     AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
     AND o.feature_flags->'rent_reminders_v2'='true'::jsonb AND f.value->'enabled'='true'::jsonb
     AND jsonb_typeof(f.value->'allowed_org_ids')='array' AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)
   GROUP BY e.id
$$;
REVOKE ALL ON FUNCTION app.b010_manual_status(uuid,uuid,text,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b010_manual_status(uuid,uuid,text,uuid,uuid,uuid) TO service_role;

-- Local-only consumer: the caller renders and records within this transaction.
-- It has no transport capability. The owner token fences stale completion.
CREATE FUNCTION app.b028_claim_manual(p_org uuid,p_live_org uuid,p_environment text,p_session uuid,p_lease uuid,p_event uuid,p_exclude uuid[])
RETURNS TABLE(claim_id uuid,claim_token uuid,email text,recipient_name text,locale text,due_date text,balance_minor text,currency text,firm_name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE v_actor uuid:=auth.uid(); v_invoice uuid; v_claim uuid; v_token uuid;
BEGIN
  LOCK TABLE public.platform_settings IN SHARE MODE NOWAIT;
  PERFORM 1 FROM public.organizations o JOIN public.org_members m ON m.org_id=CASE WHEN o.environment='sandbox' THEN o.live_org_id ELSE o.id END
    JOIN public.auth_sessions s ON s.id=p_session AND s.user_id=v_actor
    WHERE o.id=p_org AND o.environment::text=p_environment
      AND ((o.environment='live' AND o.id=p_live_org AND o.live_org_id IS NULL) OR (o.environment='sandbox' AND o.live_org_id=p_live_org))
      AND m.user_id=v_actor AND m.status='active' AND m.role IN ('admin','manager') AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
    FOR SHARE OF o,m,s NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reminder unavailable' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.reminder_rules r WHERE r.org_id=p_org AND r.event_type='rent_overdue' AND r.is_enabled AND 'email'=ANY(r.channels) FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reminder unavailable' USING ERRCODE='42501'; END IF;
  SELECT e.invoice_id INTO v_invoice FROM app.b010_source_events e WHERE e.id=p_event AND e.org_id=p_org AND e.lease_id=p_lease AND e.actor_id=v_actor AND e.kind='rent_manual';
  IF v_invoice IS NULL THEN RAISE EXCEPTION 'Reminder unavailable' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.leases l WHERE l.id=p_lease AND l.org_id=p_org FOR SHARE;
  PERFORM 1 FROM public.invoices i WHERE i.id=v_invoice AND i.org_id=p_org AND i.lease_id=p_lease FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM app.b010_manual_status(p_org,p_live_org,p_environment,p_session,p_lease,p_event)) THEN
    RAISE EXCEPTION 'Reminder unavailable' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.leases l JOIN public.invoices i ON i.lease_id=l.id AND i.org_id=l.org_id
      JOIN public.organizations o ON o.id=l.org_id WHERE l.id=p_lease AND l.org_id=p_org AND l.status='active' AND l.terminated_on IS NULL
      AND i.id=v_invoice AND i.status IN ('open','partially_paid') AND i.balance_minor>0
      AND coalesce(o.settings->>'email_tenant_rent_overdue','true') <> 'false'
      AND EXISTS (SELECT 1 FROM public.invoice_lines il WHERE il.org_id=i.org_id AND il.invoice_id=i.id AND il.charge_type='rent' AND il.amount_minor>0))
    OR EXISTS (SELECT 1 FROM public.email_log x WHERE x.org_id=p_org AND x.target_id=v_invoice AND x.kind IN ('rent_overdue_admin','rent_overdue_tenant')) THEN
    RAISE EXCEPTION 'Reminder unavailable' USING ERRCODE='42501';
  END IF;
  SELECT c.id INTO v_claim FROM app.b028_recipient_claims c JOIN public.contacts ct ON ct.id=c.contact_id AND ct.org_id=c.org_id
    JOIN public.lease_parties lp ON lp.contact_id=ct.id AND lp.org_id=ct.org_id AND lp.lease_id=p_lease AND lp.role IN ('primary','co_tenant')
    WHERE c.org_id=p_org AND c.event_id=p_event AND NOT (c.id=ANY(coalesce(p_exclude,'{}'::uuid[]))) AND (c.state IN ('queued','failed') OR (c.state='claimed' AND c.claimed_until<=clock_timestamp())) AND ct.archived_at IS NULL
      AND ct.user_id IS NOT DISTINCT FROM c.principal_user_id AND ct.email IS NOT NULL AND btrim(ct.email::text)<>''
    ORDER BY c.id LIMIT 1 FOR UPDATE OF c SKIP LOCKED;
  IF v_claim IS NULL THEN RETURN; END IF;
  PERFORM 1 FROM public.contacts ct JOIN app.b028_recipient_claims c ON c.contact_id=ct.id AND c.org_id=ct.org_id
    JOIN public.lease_parties lp ON lp.contact_id=ct.id AND lp.org_id=ct.org_id AND lp.lease_id=p_lease AND lp.role IN ('primary','co_tenant')
    WHERE c.id=v_claim AND ct.user_id IS NOT DISTINCT FROM c.principal_user_id AND ct.archived_at IS NULL
      AND ct.email IS NOT NULL AND btrim(ct.email::text)<>'' FOR SHARE OF ct,lp NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reminder unavailable' USING ERRCODE='42501'; END IF;
  v_token:=gen_random_uuid();
  UPDATE app.b028_recipient_claims SET state='claimed',claim_token=v_token,claimed_until=clock_timestamp()+interval '2 minutes',attempt=attempt+1,failure_code=NULL WHERE id=v_claim;
  RETURN QUERY SELECT c.id,v_token,ct.email::text,ct.display_name,ct.locale,i.due_date::text,i.balance_minor::text,i.currency::text,o.name
    FROM app.b028_recipient_claims c JOIN public.contacts ct ON ct.id=c.contact_id AND ct.org_id=c.org_id
    JOIN public.invoices i ON i.id=v_invoice AND i.org_id=c.org_id JOIN public.organizations o ON o.id=c.org_id WHERE c.id=v_claim;
END $$;
REVOKE ALL ON FUNCTION app.b028_claim_manual(uuid,uuid,text,uuid,uuid,uuid,uuid[]) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b028_claim_manual(uuid,uuid,text,uuid,uuid,uuid,uuid[]) TO service_role;

CREATE FUNCTION app.b028_finish_manual(p_org uuid,p_live_org uuid,p_environment text,p_session uuid,p_lease uuid,p_event uuid,p_claim uuid,p_token uuid,p_digest text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE v_actor uuid:=auth.uid(); v_invoice uuid;
BEGIN
  LOCK TABLE public.platform_settings IN SHARE MODE NOWAIT;
  PERFORM 1 FROM public.organizations o JOIN public.org_members m ON m.org_id=CASE WHEN o.environment='sandbox' THEN o.live_org_id ELSE o.id END
    JOIN public.auth_sessions s ON s.id=p_session AND s.user_id=v_actor
    WHERE o.id=p_org AND o.environment::text=p_environment
      AND ((o.environment='live' AND o.id=p_live_org AND o.live_org_id IS NULL) OR (o.environment='sandbox' AND o.live_org_id=p_live_org))
      AND m.user_id=v_actor AND m.status='active' AND m.role IN ('admin','manager') AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
    FOR SHARE OF o,m,s NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reminder unavailable' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.reminder_rules r WHERE r.org_id=p_org AND r.event_type='rent_overdue' AND r.is_enabled AND 'email'=ANY(r.channels) FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reminder unavailable' USING ERRCODE='42501'; END IF;
  SELECT e.invoice_id INTO v_invoice FROM app.b010_source_events e WHERE e.id=p_event AND e.org_id=p_org AND e.lease_id=p_lease AND e.actor_id=v_actor AND e.kind='rent_manual';
  IF v_invoice IS NULL THEN RAISE EXCEPTION 'Reminder unavailable' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.leases l WHERE l.id=p_lease AND l.org_id=p_org FOR SHARE;
  PERFORM 1 FROM public.invoices i WHERE i.id=v_invoice AND i.org_id=p_org AND i.lease_id=p_lease FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM app.b010_manual_status(p_org,p_live_org,p_environment,p_session,p_lease,p_event)) OR NOT EXISTS (
    SELECT 1 FROM public.leases l JOIN public.invoices i ON i.lease_id=l.id AND i.org_id=l.org_id
      JOIN public.organizations o ON o.id=l.org_id JOIN app.b028_recipient_claims c ON c.id=p_claim AND c.org_id=l.org_id AND c.event_id=p_event
      JOIN public.contacts ct ON ct.id=c.contact_id AND ct.org_id=c.org_id
      JOIN public.lease_parties lp ON lp.contact_id=ct.id AND lp.org_id=ct.org_id AND lp.lease_id=l.id AND lp.role IN ('primary','co_tenant')
     WHERE l.id=p_lease AND l.org_id=p_org AND l.status='active' AND l.terminated_on IS NULL
       AND i.id=v_invoice AND i.status IN ('open','partially_paid') AND i.balance_minor>0
       AND coalesce(o.settings->>'email_tenant_rent_overdue','true') <> 'false'
       AND ct.user_id IS NOT DISTINCT FROM c.principal_user_id AND ct.archived_at IS NULL AND ct.email IS NOT NULL AND btrim(ct.email::text)<>''
       AND EXISTS (SELECT 1 FROM public.invoice_lines il WHERE il.org_id=i.org_id AND il.invoice_id=i.id AND il.charge_type='rent' AND il.amount_minor>0))
    OR EXISTS (SELECT 1 FROM public.email_log x WHERE x.org_id=p_org AND x.target_id=v_invoice AND x.kind IN ('rent_overdue_admin','rent_overdue_tenant')) THEN
    RAISE EXCEPTION 'Reminder unavailable' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM public.contacts ct JOIN app.b028_recipient_claims c ON c.contact_id=ct.id AND c.org_id=ct.org_id
    JOIN public.lease_parties lp ON lp.contact_id=ct.id AND lp.org_id=ct.org_id AND lp.lease_id=p_lease AND lp.role IN ('primary','co_tenant')
    WHERE c.id=p_claim AND ct.user_id IS NOT DISTINCT FROM c.principal_user_id AND ct.archived_at IS NULL
      AND ct.email IS NOT NULL AND btrim(ct.email::text)<>'' FOR SHARE OF ct,lp NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reminder unavailable' USING ERRCODE='42501'; END IF;
  UPDATE app.b028_recipient_claims SET state=CASE WHEN p_digest IS NULL THEN 'failed' ELSE 'captured' END,
    claim_token=NULL,claimed_until=NULL,completed_at=CASE WHEN p_digest IS NULL THEN NULL ELSE clock_timestamp() END,
    capture_digest=p_digest,failure_code=CASE WHEN p_digest IS NULL THEN 'capture_failed' ELSE NULL END
   WHERE id=p_claim AND org_id=p_org AND event_id=p_event AND state='claimed' AND claim_token=p_token AND claimed_until>clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'Reminder unavailable' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION app.b028_finish_manual(uuid,uuid,text,uuid,uuid,uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b028_finish_manual(uuid,uuid,text,uuid,uuid,uuid,uuid,uuid,text) TO service_role;

-- A pre-hook writer cannot finish an enabled financial transition without its
-- same-transaction event. This private requirement is not an audit record.
CREATE TABLE app.b010_payment_requirements (
  tx_id bigint NOT NULL, org_id uuid NOT NULL, lease_id uuid NOT NULL,
  payment_id uuid NOT NULL, kind text NOT NULL, actor_id uuid NOT NULL, event_id uuid,
  PRIMARY KEY(tx_id,payment_id,kind)
);
REVOKE ALL ON app.b010_payment_requirements FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE app.b010_payment_contexts (
  tx_id bigint NOT NULL,org_id uuid NOT NULL,lease_id uuid NOT NULL,actor_id uuid NOT NULL,session_id uuid NOT NULL,role text NOT NULL,
  PRIMARY KEY(tx_id,org_id,lease_id,actor_id)
);
REVOKE ALL ON app.b010_payment_contexts FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b010_clean_payment_context() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.b010_payment_requirements r WHERE r.tx_id=NEW.tx_id AND r.org_id=NEW.org_id AND r.lease_id=NEW.lease_id AND r.actor_id=NEW.actor_id) THEN
    DELETE FROM app.b010_payment_contexts WHERE tx_id=NEW.tx_id AND org_id=NEW.org_id AND lease_id=NEW.lease_id AND actor_id=NEW.actor_id;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.b010_clean_payment_context() FROM PUBLIC,anon,authenticated,service_role;
CREATE CONSTRAINT TRIGGER b010_payment_context_cleanup AFTER INSERT OR UPDATE ON app.b010_payment_contexts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.b010_clean_payment_context();

CREATE FUNCTION app.b010_lock_payment_context(p_org uuid,p_live_org uuid,p_environment text,p_session uuid,p_lease uuid,p_role text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_actor uuid:=auth.uid(); v_enabled boolean;
BEGIN
  -- Validate membership and scope before granting a caller any privileged locks.
  IF NOT EXISTS (SELECT 1 FROM public.organizations o JOIN public.org_members m
      ON m.org_id=CASE WHEN o.environment='sandbox' THEN o.live_org_id ELSE o.id END
    WHERE o.id=p_org AND o.environment::text=p_environment
      AND ((o.environment='live' AND o.id=p_live_org AND o.live_org_id IS NULL) OR (o.environment='sandbox' AND o.live_org_id=p_live_org))
      AND m.user_id=v_actor AND m.status='active' AND m.role::text=p_role AND m.role IN ('admin','manager','accountant')) THEN
    RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501';
  END IF;
  LOCK TABLE public.platform_settings IN SHARE MODE NOWAIT;
  PERFORM 1 FROM public.organizations o WHERE o.id=p_org FOR SHARE NOWAIT;
  SELECT EXISTS (SELECT 1 FROM public.organizations o JOIN public.platform_settings f ON f.key='payment_results_v2'
    WHERE o.id=p_org AND o.feature_flags->'payment_results_v2'='true'::jsonb AND f.value->'enabled'='true'::jsonb
      AND jsonb_typeof(f.value->'allowed_org_ids')='array' AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) INTO v_enabled;
  IF NOT v_enabled THEN RETURN false; END IF;
  PERFORM 1 FROM public.organizations o JOIN public.org_members m ON m.org_id=CASE WHEN o.environment='sandbox' THEN o.live_org_id ELSE o.id END
    JOIN public.auth_sessions s ON s.id=p_session AND s.user_id=v_actor
    WHERE o.id=p_org AND o.environment::text=p_environment
      AND ((o.environment='live' AND o.id=p_live_org AND o.live_org_id IS NULL) OR (o.environment='sandbox' AND o.live_org_id=p_live_org))
      AND m.user_id=v_actor AND m.status='active' AND m.role::text=p_role AND m.role IN ('admin','manager','accountant')
      AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR SHARE OF m,s NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.leases WHERE id=p_lease AND org_id=p_org FOR SHARE NOWAIT;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.auth_sessions s WHERE s.id=p_session AND s.user_id=v_actor AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()) THEN
    RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501';
  END IF;
  INSERT INTO app.b010_payment_contexts(tx_id,org_id,lease_id,actor_id,session_id,role)
    VALUES(txid_current(),p_org,p_lease,v_actor,p_session,p_role)
    ON CONFLICT(tx_id,org_id,lease_id,actor_id) DO UPDATE SET session_id=EXCLUDED.session_id,role=EXCLUDED.role;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION app.b010_lock_payment_context(uuid,uuid,text,uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b010_lock_payment_context(uuid,uuid,text,uuid,uuid,text) TO authenticated,service_role;

CREATE FUNCTION app.b010_guard_payment_transition() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE v_kind text; v_enabled boolean; v_actor uuid:=auth.uid();
BEGIN
  IF TG_OP='INSERT' AND NEW.status='submitted' THEN RETURN NEW;
  ELSIF TG_OP='UPDATE' AND OLD.status=NEW.status THEN RETURN NEW;
  ELSIF TG_OP='INSERT' AND NEW.status='confirmed' THEN v_kind:='payment_confirmed';
  ELSIF TG_OP='UPDATE' AND OLD.status='submitted' AND NEW.status='confirmed' THEN v_kind:='payment_confirmed';
  ELSIF TG_OP='UPDATE' AND OLD.status='submitted' AND NEW.status='rejected' THEN v_kind:='payment_rejected';
  ELSIF TG_OP='UPDATE' AND OLD.status='confirmed' AND NEW.status='reversed' THEN v_kind:='payment_reversed';
  ELSE v_kind:='unsupported'; END IF;
  -- This trigger can run after an old writer already has a tuple; never wait
  -- for a parent/control lock from this inverted position.
  LOCK TABLE public.platform_settings IN SHARE MODE NOWAIT;
  PERFORM 1 FROM public.organizations WHERE id=NEW.org_id FOR SHARE NOWAIT;
  SELECT EXISTS (SELECT 1 FROM public.organizations o JOIN public.platform_settings f ON f.key='payment_results_v2'
    WHERE o.id=NEW.org_id AND o.feature_flags->'payment_results_v2'='true'::jsonb AND f.value->'enabled'='true'::jsonb
      AND jsonb_typeof(f.value->'allowed_org_ids')='array' AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) INTO v_enabled;
  IF NOT v_enabled THEN RETURN NEW; END IF;
  IF v_kind='unsupported' THEN RAISE EXCEPTION 'Payment transition unavailable' USING ERRCODE='23514'; END IF;
  PERFORM 1 FROM public.leases WHERE id=NEW.lease_id AND org_id=NEW.org_id FOR SHARE NOWAIT;
  IF NOT FOUND OR v_actor IS NULL THEN RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501'; END IF;
  INSERT INTO app.b010_payment_requirements(tx_id,org_id,lease_id,payment_id,kind,actor_id)
    VALUES(txid_current(),NEW.org_id,NEW.lease_id,NEW.id,v_kind,v_actor);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.b010_guard_payment_transition() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER a_b010_payment_transition AFTER INSERT OR UPDATE OF status ON public.payments
  FOR EACH ROW EXECUTE FUNCTION app.b010_guard_payment_transition();

CREATE FUNCTION app.b010_emit_payment_event(p_payment uuid,p_kind text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE v_requirement app.b010_payment_requirements; v_event uuid;
BEGIN
  SELECT * INTO v_requirement FROM app.b010_payment_requirements
    WHERE tx_id=txid_current() AND payment_id=p_payment AND kind=p_kind AND actor_id=auth.uid();
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM app.b010_payment_contexts ctx
    JOIN public.auth_sessions s ON s.id=ctx.session_id AND s.user_id=ctx.actor_id
    WHERE ctx.tx_id=txid_current() AND ctx.org_id=v_requirement.org_id AND ctx.lease_id=v_requirement.lease_id
      AND ctx.actor_id=auth.uid() AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()) THEN
    RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501';
  END IF;
  INSERT INTO app.b010_source_events(org_id,lease_id,payment_id,kind,occurrence_key,actor_id)
    VALUES(v_requirement.org_id,v_requirement.lease_id,v_requirement.payment_id,v_requirement.kind,v_requirement.kind,v_requirement.actor_id)
    RETURNING id INTO v_event;
  UPDATE app.b010_payment_requirements SET event_id=v_event
    WHERE tx_id=txid_current() AND payment_id=p_payment AND kind=p_kind AND actor_id=auth.uid();
  RETURN v_event;
END $$;
REVOKE ALL ON FUNCTION app.b010_emit_payment_event(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b010_emit_payment_event(uuid,text) TO authenticated,service_role;

CREATE FUNCTION app.b010_require_payment_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.b010_payment_requirements r
      JOIN app.b010_source_events e ON e.id=r.event_id AND e.org_id=r.org_id AND e.lease_id=r.lease_id
        AND e.payment_id=r.payment_id AND e.kind=r.kind AND e.actor_id=r.actor_id
      JOIN public.payments p ON p.id=r.payment_id AND p.org_id=r.org_id AND p.lease_id=r.lease_id
        AND p.status::text=CASE r.kind WHEN 'payment_confirmed' THEN 'confirmed' WHEN 'payment_rejected' THEN 'rejected' WHEN 'payment_reversed' THEN 'reversed' END
      JOIN app.b010_payment_contexts ctx ON ctx.tx_id=r.tx_id AND ctx.org_id=r.org_id AND ctx.lease_id=r.lease_id AND ctx.actor_id=r.actor_id
      JOIN public.auth_sessions s ON s.id=ctx.session_id AND s.user_id=ctx.actor_id
      WHERE r.tx_id=NEW.tx_id AND r.payment_id=NEW.payment_id AND r.kind=NEW.kind
        AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
        AND CASE r.kind
          WHEN 'payment_confirmed' THEN p.confirmed_by=r.actor_id AND p.confirmed_at IS NOT NULL
            AND (SELECT coalesce(sum(a.amount_minor),0) FROM public.payment_allocations a WHERE a.org_id=p.org_id AND a.payment_id=p.id)=p.amount_minor
            AND EXISTS (SELECT 1 FROM public.ledger_transactions t WHERE t.id=p.ledger_transaction_id AND t.org_id=p.org_id
              AND t.kind='payment' AND t.source_table='payments' AND t.source_id=p.id
              AND (SELECT coalesce(sum(le.amount_minor),0) FROM public.ledger_entries le WHERE le.org_id=p.org_id AND le.transaction_id=t.id AND le.account='cash_clearing')=p.amount_minor
              AND (SELECT coalesce(sum(le.amount_minor),0) FROM public.ledger_entries le WHERE le.org_id=p.org_id AND le.transaction_id=t.id AND le.account='tenant_receivable')=-p.amount_minor)
          WHEN 'payment_rejected' THEN btrim(coalesce(p.rejected_reason,''))<>''
          WHEN 'payment_reversed' THEN EXISTS (SELECT 1 FROM public.ledger_transactions original JOIN public.ledger_transactions reversal
              ON reversal.org_id=original.org_id AND reversal.reverses_transaction_id=original.id AND reversal.kind='reversal'
              WHERE original.id=p.ledger_transaction_id AND original.org_id=p.org_id AND original.kind='payment'
                AND original.source_table='payments' AND original.source_id=p.id
                AND reversal.created_by=r.actor_id AND btrim(coalesce(reversal.reason,''))<>''
                AND EXISTS (SELECT 1 FROM public.ledger_entries le WHERE le.org_id=p.org_id AND le.transaction_id=original.id)
                AND NOT EXISTS ((SELECT le.account,le.currency,le.contact_id,le.property_id,le.lease_id,le.invoice_id,sum(le.amount_minor)
                    FROM public.ledger_entries le WHERE le.org_id=p.org_id AND le.transaction_id=original.id
                    GROUP BY le.account,le.currency,le.contact_id,le.property_id,le.lease_id,le.invoice_id)
                  EXCEPT (SELECT le.account,le.currency,le.contact_id,le.property_id,le.lease_id,le.invoice_id,-sum(le.amount_minor)
                    FROM public.ledger_entries le WHERE le.org_id=p.org_id AND le.transaction_id=reversal.id
                    GROUP BY le.account,le.currency,le.contact_id,le.property_id,le.lease_id,le.invoice_id))
                AND NOT EXISTS ((SELECT le.account,le.currency,le.contact_id,le.property_id,le.lease_id,le.invoice_id,-sum(le.amount_minor)
                    FROM public.ledger_entries le WHERE le.org_id=p.org_id AND le.transaction_id=reversal.id
                    GROUP BY le.account,le.currency,le.contact_id,le.property_id,le.lease_id,le.invoice_id)
                  EXCEPT (SELECT le.account,le.currency,le.contact_id,le.property_id,le.lease_id,le.invoice_id,sum(le.amount_minor)
                    FROM public.ledger_entries le WHERE le.org_id=p.org_id AND le.transaction_id=original.id
                    GROUP BY le.account,le.currency,le.contact_id,le.property_id,le.lease_id,le.invoice_id)))
          ELSE false END) THEN
    RAISE EXCEPTION 'Payment transition requires result event' USING ERRCODE='23514';
  END IF;
  DELETE FROM app.b010_payment_requirements WHERE tx_id=NEW.tx_id AND payment_id=NEW.payment_id AND kind=NEW.kind;
  IF NOT EXISTS (SELECT 1 FROM app.b010_payment_requirements r WHERE r.tx_id=NEW.tx_id AND r.org_id=NEW.org_id AND r.lease_id=NEW.lease_id AND r.actor_id=NEW.actor_id) THEN
    DELETE FROM app.b010_payment_contexts WHERE tx_id=NEW.tx_id AND org_id=NEW.org_id AND lease_id=NEW.lease_id AND actor_id=NEW.actor_id;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.b010_require_payment_event() FROM PUBLIC,anon,authenticated,service_role;
CREATE CONSTRAINT TRIGGER b010_payment_event_required AFTER INSERT ON app.b010_payment_requirements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.b010_require_payment_event();

-- One request key serializes a manager payment before a new payment exists.
CREATE FUNCTION app.b010_payment_command_lookup(p_org uuid,p_live uuid,p_env text,p_session uuid,p_lease uuid,p_role text,p_request uuid,p_digest text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE v_actor uuid:=auth.uid(); v_result uuid; v_digest text; v_lease uuid; v_status text;
BEGIN
  IF p_request IS NULL OR p_digest !~ '^[0-9a-f]{64}$' OR NOT app.b010_lock_payment_context(p_org,p_live,p_env,p_session,p_lease,p_role) THEN
    RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('b010:payment:' || p_org::text || ':' || v_actor::text || ':' || p_request::text,0));
  IF NOT app.b010_lock_payment_context(p_org,p_live,p_env,p_session,p_lease,p_role) THEN RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501'; END IF;
  SELECT c.payment_id,c.payload_digest,p.lease_id,p.status::text INTO v_result,v_digest,v_lease,v_status
    FROM app.b010_payment_commands c JOIN public.payments p ON p.id=c.payment_id AND p.org_id=c.org_id
    WHERE c.org_id=p_org AND c.actor_id=v_actor AND c.request_id=p_request;
  IF v_result IS NOT NULL AND (v_digest IS DISTINCT FROM p_digest OR v_lease IS DISTINCT FROM p_lease OR v_status <> 'confirmed') THEN
    RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501';
  END IF;
  RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION app.b010_payment_command_lookup(uuid,uuid,text,uuid,uuid,text,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b010_payment_command_lookup(uuid,uuid,text,uuid,uuid,text,uuid,text) TO authenticated,service_role;

CREATE FUNCTION app.b010_payment_command_store(p_org uuid,p_request uuid,p_digest text,p_payment uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE v_actor uuid:=auth.uid();
BEGIN
  IF p_request IS NULL OR p_digest !~ '^[0-9a-f]{64}$' OR NOT EXISTS (
    SELECT 1 FROM app.b010_payment_requirements r WHERE r.tx_id=txid_current() AND r.org_id=p_org AND r.payment_id=p_payment
      AND r.actor_id=v_actor AND r.kind='payment_confirmed') THEN
    RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501';
  END IF;
  INSERT INTO app.b010_payment_commands(org_id,actor_id,request_id,payload_digest,payment_id) VALUES(p_org,v_actor,p_request,p_digest,p_payment);
END $$;
REVOKE ALL ON FUNCTION app.b010_payment_command_store(uuid,uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b010_payment_command_store(uuid,uuid,text,uuid) TO authenticated,service_role;

-- Service-only cron producer; this function records local intent, never sends.
CREATE FUNCTION app.b010_schedule_rent(p_org uuid,p_invoice uuid,p_instant timestamptz)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE v_lease uuid; v_due date; v_today date; v_offset integer; v_key text; v_event uuid; v_count integer; v_kind text;
BEGIN
  IF p_instant IS NULL THEN RAISE EXCEPTION 'Reminder unavailable' USING ERRCODE='42501'; END IF;
  LOCK TABLE public.platform_settings IN SHARE MODE NOWAIT;
  PERFORM 1 FROM public.organizations o JOIN public.platform_settings f ON f.key='rent_reminders_v2'
    WHERE o.id=p_org AND o.environment='live' AND o.live_org_id IS NULL
      AND o.feature_flags->'rent_reminders_v2'='true'::jsonb AND f.value->'enabled'='true'::jsonb
      AND jsonb_typeof(f.value->'allowed_org_ids')='array' AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)
    FOR SHARE OF o NOWAIT;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.reminder_rules r WHERE r.org_id=p_org AND r.event_type IN ('rent_due','rent_overdue') ORDER BY r.event_type FOR SHARE NOWAIT;
  SELECT i.lease_id INTO v_lease FROM public.invoices i WHERE i.id=p_invoice AND i.org_id=p_org;
  IF v_lease IS NULL THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.leases l WHERE l.id=v_lease AND l.org_id=p_org FOR SHARE;
  PERFORM 1 FROM public.invoices i WHERE i.id=p_invoice AND i.org_id=p_org AND i.lease_id=v_lease FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT i.due_date,(p_instant AT TIME ZONE o.timezone)::date INTO v_due,v_today
    FROM public.leases l JOIN public.invoices i ON i.lease_id=l.id AND i.org_id=l.org_id
    JOIN public.organizations o ON o.id=l.org_id
    WHERE l.id=v_lease AND l.org_id=p_org AND i.id=p_invoice AND l.status='active' AND l.terminated_on IS NULL
      AND i.status IN ('open','partially_paid') AND i.balance_minor>0
      AND EXISTS (SELECT 1 FROM public.invoice_lines il WHERE il.org_id=i.org_id AND il.invoice_id=i.id AND il.charge_type='rent' AND il.amount_minor>0);
  IF v_due IS NULL THEN RETURN NULL; END IF;
  v_offset:=v_today-v_due;
  -- Due: tenant-only at configured nonpositive offsets. Overdue retains the
  -- existing staff day 1/7 and tenant day 1 behavior.
  IF v_offset <= 0 THEN v_kind:='rent_due';
  ELSIF v_offset IN (1,7) THEN v_kind:='rent_overdue';
  ELSE RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.reminder_rules r WHERE r.org_id=p_org AND r.event_type=v_kind
      AND r.is_enabled AND v_offset=ANY(r.offsets_days) AND 'email'=ANY(r.channels)) THEN RETURN NULL; END IF;
  IF v_kind='rent_overdue' AND EXISTS (SELECT 1 FROM public.email_log x WHERE x.org_id=p_org AND x.target_id=p_invoice AND x.threshold=v_offset
      AND x.kind IN ('rent_overdue_admin','rent_overdue_tenant')) THEN RETURN NULL; END IF;
  v_key:=v_due::text || ':' || v_offset::text;
  INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,local_date)
    VALUES(p_org,v_lease,p_invoice,v_kind,v_key,v_today)
    ON CONFLICT(org_id,kind,invoice_id,occurrence_key) WHERE invoice_id IS NOT NULL DO NOTHING RETURNING id INTO v_event;
  IF v_event IS NULL THEN RETURN NULL; END IF;
  IF v_kind='rent_overdue' THEN
    INSERT INTO app.b028_recipient_claims(org_id,event_id,principal_user_id,member_id,channel)
      SELECT p_org,v_event,m.user_id,m.id,'email' FROM public.org_members m JOIN auth.users u ON u.id=m.user_id
      LEFT JOIN public.profiles pr ON pr.id=m.user_id
      WHERE m.org_id=p_org AND m.status='active' AND m.role IN ('admin','manager')
        AND coalesce(m.email_prefs->>'rent_overdue','true') <> 'false'
        AND coalesce(nullif(btrim(u.email::text),''),nullif(btrim(pr.email::text),'')) IS NOT NULL
      ON CONFLICT DO NOTHING;
  END IF;
  IF v_kind='rent_due' THEN
    INSERT INTO app.b010_tenant_due_preferences(org_id,user_id)
      SELECT DISTINCT p_org,c.user_id FROM public.lease_parties lp JOIN public.contacts c ON c.id=lp.contact_id AND c.org_id=lp.org_id
      WHERE lp.org_id=p_org AND lp.lease_id=v_lease AND lp.role IN ('primary','co_tenant') AND c.user_id IS NOT NULL AND c.archived_at IS NULL
      ON CONFLICT(org_id,user_id) DO NOTHING;
  END IF;
  IF v_kind='rent_due' OR v_offset=1 THEN
    INSERT INTO app.b028_recipient_claims(org_id,event_id,principal_user_id,contact_id,channel)
      SELECT DISTINCT p_org,v_event,c.user_id,c.id,'email' FROM public.lease_parties lp
      JOIN public.contacts c ON c.id=lp.contact_id AND c.org_id=lp.org_id
      JOIN public.organizations o ON o.id=lp.org_id
      LEFT JOIN app.b010_tenant_due_preferences pref ON pref.org_id=c.org_id AND pref.user_id=c.user_id
      WHERE lp.org_id=p_org AND lp.lease_id=v_lease AND lp.role IN ('primary','co_tenant')
        AND c.archived_at IS NULL AND c.email IS NOT NULL AND btrim(c.email::text)<>''
        AND ((v_kind='rent_due' AND (c.user_id IS NULL OR pref.due_enabled=true))
          OR (v_kind='rent_overdue' AND coalesce(o.settings->>'email_tenant_rent_overdue','true') <> 'false'))
      ON CONFLICT DO NOTHING;
  END IF;
  SELECT count(*) INTO v_count FROM app.b028_recipient_claims WHERE org_id=p_org AND event_id=v_event;
  IF v_count=0 THEN DELETE FROM app.b010_source_events WHERE id=v_event; RETURN NULL; END IF;
  RETURN v_event;
END $$;
REVOKE ALL ON FUNCTION app.b010_schedule_rent(uuid,uuid,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b010_schedule_rent(uuid,uuid,timestamptz) TO service_role;

CREATE TABLE app.b028_scheduled_contexts (tx_id bigint NOT NULL,org_id uuid NOT NULL,claim_id uuid NOT NULL,claim_token uuid NOT NULL,PRIMARY KEY(tx_id,claim_id));
REVOKE ALL ON app.b028_scheduled_contexts FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION app.b028_require_scheduled_finish() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM app.b028_scheduled_contexts WHERE tx_id=NEW.tx_id AND claim_id=NEW.claim_id) THEN
    RAISE EXCEPTION 'Local capture must finish in its transaction' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.b028_require_scheduled_finish() FROM PUBLIC,anon,authenticated,service_role;
CREATE CONSTRAINT TRIGGER b028_scheduled_finish_required AFTER INSERT ON app.b028_scheduled_contexts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.b028_require_scheduled_finish();

-- Internal cron-only local capture. A recipient is rechecked and pinned after
-- invoice eligibility; the caller holds this transaction through finish.
CREATE FUNCTION app.b028_claim_scheduled(p_org uuid,p_event uuid,p_exclude uuid[],p_instant timestamptz)
RETURNS TABLE(claim_id uuid,claim_token uuid,email text,recipient_name text,locale text,due_date text,balance_minor text,currency text,firm_name text,recipient_kind text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE v_lease uuid; v_invoice uuid; v_claim uuid; v_token uuid;
BEGIN
  LOCK TABLE public.platform_settings IN SHARE MODE NOWAIT;
  PERFORM 1 FROM public.organizations o JOIN public.platform_settings f ON f.key='rent_reminders_v2'
    WHERE o.id=p_org AND o.environment='live' AND o.live_org_id IS NULL
      AND o.feature_flags->'rent_reminders_v2'='true'::jsonb AND f.value->'enabled'='true'::jsonb
      AND jsonb_typeof(f.value->'allowed_org_ids')='array' AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)
    FOR SHARE OF o NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reminder unavailable' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.reminder_rules r WHERE r.org_id=p_org AND r.event_type IN ('rent_due','rent_overdue') ORDER BY r.event_type FOR SHARE NOWAIT;
  SELECT e.lease_id,e.invoice_id INTO v_lease,v_invoice FROM app.b010_source_events e
    WHERE e.id=p_event AND e.org_id=p_org AND e.kind IN ('rent_due','rent_overdue') AND e.actor_id IS NULL;
  IF v_lease IS NULL THEN RAISE EXCEPTION 'Reminder unavailable' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.leases WHERE id=v_lease AND org_id=p_org FOR SHARE;
  PERFORM 1 FROM public.invoices WHERE id=v_invoice AND org_id=p_org AND lease_id=v_lease FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.leases l JOIN public.invoices i ON i.lease_id=l.id AND i.org_id=l.org_id
    JOIN app.b010_source_events e ON e.id=p_event AND e.org_id=l.org_id AND e.lease_id=l.id AND e.invoice_id=i.id
    JOIN public.organizations organization ON organization.id=l.org_id
    WHERE p_instant IS NOT NULL AND (p_instant AT TIME ZONE organization.timezone)::date=e.local_date AND l.id=v_lease AND l.org_id=p_org AND l.status='active' AND l.terminated_on IS NULL
      AND i.id=v_invoice AND i.status IN ('open','partially_paid') AND i.balance_minor>0
      AND e.occurrence_key=i.due_date::text || ':' || (e.local_date-i.due_date)::text
      AND ((e.kind='rent_due' AND e.local_date-i.due_date <= 0) OR (e.kind='rent_overdue' AND e.local_date-i.due_date IN (1,7)))
      AND EXISTS (SELECT 1 FROM public.reminder_rules r WHERE r.org_id=l.org_id AND r.event_type=e.kind AND r.is_enabled AND (e.local_date-i.due_date)=ANY(r.offsets_days) AND 'email'=ANY(r.channels))
      AND EXISTS (SELECT 1 FROM public.invoice_lines il WHERE il.org_id=i.org_id AND il.invoice_id=i.id AND il.charge_type='rent' AND il.amount_minor>0))
    OR EXISTS (SELECT 1 FROM public.email_log x JOIN app.b010_source_events e ON e.id=p_event AND e.kind='rent_overdue'
      WHERE x.org_id=p_org AND x.target_id=v_invoice AND x.threshold=e.local_date-(SELECT iv.due_date FROM public.invoices iv WHERE iv.id=v_invoice)
        AND x.kind IN ('rent_overdue_admin','rent_overdue_tenant')) THEN RAISE EXCEPTION 'Reminder unavailable' USING ERRCODE='42501'; END IF;
  SELECT c.id INTO v_claim FROM app.b028_recipient_claims c JOIN app.b010_source_events e ON e.id=c.event_id AND e.org_id=c.org_id WHERE c.org_id=p_org AND c.event_id=p_event
    AND NOT (c.id=ANY(coalesce(p_exclude,'{}'::uuid[])))
    AND (c.state IN ('queued','failed') OR (c.state='claimed' AND c.claimed_until<=clock_timestamp()))
    AND ((c.contact_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.contacts ct JOIN public.lease_parties lp ON lp.contact_id=ct.id AND lp.org_id=ct.org_id
      JOIN public.organizations o ON o.id=ct.org_id WHERE ct.id=c.contact_id AND ct.org_id=c.org_id AND lp.lease_id=v_lease AND lp.role IN ('primary','co_tenant')
      AND ct.user_id IS NOT DISTINCT FROM c.principal_user_id AND ct.archived_at IS NULL AND ct.email IS NOT NULL AND btrim(ct.email::text)<>''
      AND ((e.kind='rent_overdue' AND coalesce(o.settings->>'email_tenant_rent_overdue','true') <> 'false') OR
           (e.kind='rent_due' AND (c.principal_user_id IS NULL OR EXISTS (SELECT 1 FROM app.b010_tenant_due_preferences pref WHERE pref.org_id=c.org_id AND pref.user_id=c.principal_user_id AND pref.due_enabled=true))))))
      OR (c.member_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.org_members m JOIN auth.users u ON u.id=m.user_id LEFT JOIN public.profiles pr ON pr.id=m.user_id
      WHERE m.id=c.member_id AND m.org_id=c.org_id AND m.user_id=c.principal_user_id AND m.status='active' AND m.role IN ('admin','manager')
      AND coalesce(m.email_prefs->>'rent_overdue','true') <> 'false' AND coalesce(nullif(btrim(u.email::text),''),nullif(btrim(pr.email::text),'')) IS NOT NULL)))
    ORDER BY c.id LIMIT 1 FOR UPDATE OF c SKIP LOCKED;
  IF v_claim IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM app.b028_recipient_claims WHERE id=v_claim AND contact_id IS NOT NULL) THEN
    PERFORM 1 FROM public.contacts ct JOIN app.b028_recipient_claims c ON c.contact_id=ct.id AND c.org_id=ct.org_id
      JOIN public.lease_parties lp ON lp.contact_id=ct.id AND lp.org_id=ct.org_id AND lp.lease_id=v_lease AND lp.role IN ('primary','co_tenant')
      WHERE c.id=v_claim AND ct.user_id IS NOT DISTINCT FROM c.principal_user_id AND ct.archived_at IS NULL AND ct.email IS NOT NULL AND btrim(ct.email::text)<>'' FOR SHARE OF ct,lp NOWAIT;
  ELSE
    PERFORM 1 FROM public.org_members m JOIN app.b028_recipient_claims c ON c.member_id=m.id AND c.org_id=m.org_id
      JOIN auth.users u ON u.id=m.user_id LEFT JOIN public.profiles pr ON pr.id=m.user_id
      WHERE c.id=v_claim AND m.user_id=c.principal_user_id AND m.status='active' AND m.role IN ('admin','manager')
        AND coalesce(m.email_prefs->>'rent_overdue','true') <> 'false' AND coalesce(nullif(btrim(u.email::text),''),nullif(btrim(pr.email::text),'')) IS NOT NULL FOR SHARE OF m,u NOWAIT;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reminder unavailable' USING ERRCODE='42501'; END IF;
  IF EXISTS (SELECT 1 FROM app.b028_recipient_claims c JOIN app.b010_source_events e ON e.id=c.event_id WHERE c.id=v_claim AND e.kind='rent_due' AND c.principal_user_id IS NOT NULL) THEN
    PERFORM 1 FROM app.b010_tenant_due_preferences pref JOIN app.b028_recipient_claims c ON c.org_id=pref.org_id AND c.principal_user_id=pref.user_id
      WHERE c.id=v_claim AND pref.due_enabled=true FOR SHARE OF pref NOWAIT;
    IF NOT FOUND THEN RAISE EXCEPTION 'Reminder unavailable' USING ERRCODE='42501'; END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM app.b028_recipient_claims c JOIN public.org_members m ON m.id=c.member_id JOIN auth.users u ON u.id=m.user_id WHERE c.id=v_claim AND nullif(btrim(u.email::text),'') IS NULL) THEN
    PERFORM 1 FROM public.profiles pr JOIN public.org_members m ON m.user_id=pr.id JOIN app.b028_recipient_claims c ON c.member_id=m.id WHERE c.id=v_claim AND nullif(btrim(pr.email::text),'') IS NOT NULL FOR SHARE OF pr NOWAIT;
    IF NOT FOUND THEN RAISE EXCEPTION 'Reminder unavailable' USING ERRCODE='42501'; END IF;
  END IF;
  v_token:=gen_random_uuid();
  UPDATE app.b028_recipient_claims SET state='claimed',claim_token=v_token,claimed_until=clock_timestamp()+interval '2 minutes',attempt=attempt+1,failure_code=NULL WHERE id=v_claim;
  INSERT INTO app.b028_scheduled_contexts(tx_id,org_id,claim_id,claim_token) VALUES(txid_current(),p_org,v_claim,v_token);
  RETURN QUERY SELECT c.id,v_token,coalesce(ct.email::text,nullif(btrim(u.email::text),''),nullif(btrim(pr.email::text),'')),coalesce(ct.display_name,pr.display_name,u.email::text),
    coalesce(ct.locale,pr.locale,'zh-TW'),i.due_date::text,i.balance_minor::text,i.currency::text,o.name,CASE WHEN c.contact_id IS NULL THEN 'staff' ELSE 'tenant' END
    FROM app.b028_recipient_claims c LEFT JOIN public.contacts ct ON ct.id=c.contact_id AND ct.org_id=c.org_id
    LEFT JOIN public.org_members m ON m.id=c.member_id AND m.org_id=c.org_id LEFT JOIN auth.users u ON u.id=m.user_id LEFT JOIN public.profiles pr ON pr.id=m.user_id
    JOIN public.invoices i ON i.id=v_invoice AND i.org_id=c.org_id JOIN public.organizations o ON o.id=c.org_id WHERE c.id=v_claim;
END $$;
REVOKE ALL ON FUNCTION app.b028_claim_scheduled(uuid,uuid,uuid[],timestamptz) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b028_claim_scheduled(uuid,uuid,uuid[],timestamptz) TO service_role;
CREATE FUNCTION app.b028_finish_scheduled(p_org uuid,p_claim uuid,p_token uuid,p_digest text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.b028_scheduled_contexts WHERE tx_id=txid_current() AND org_id=p_org AND claim_id=p_claim AND claim_token=p_token) THEN
    RAISE EXCEPTION 'Reminder unavailable' USING ERRCODE='42501'; END IF;
  IF EXISTS (SELECT 1 FROM app.b028_recipient_claims c JOIN app.b010_source_events e ON e.id=c.event_id AND e.org_id=c.org_id
      WHERE c.id=p_claim AND e.kind='rent_due' AND c.principal_user_id IS NOT NULL AND NOT EXISTS
        (SELECT 1 FROM app.b010_tenant_due_preferences pref WHERE pref.org_id=c.org_id AND pref.user_id=c.principal_user_id AND pref.due_enabled=true)) THEN
    RAISE EXCEPTION 'Reminder unavailable' USING ERRCODE='42501'; END IF;
  UPDATE app.b028_recipient_claims SET state=CASE WHEN p_digest IS NULL THEN 'failed' ELSE 'captured' END,
    claim_token=NULL,claimed_until=NULL,completed_at=CASE WHEN p_digest IS NULL THEN NULL ELSE clock_timestamp() END,
    capture_digest=p_digest,failure_code=CASE WHEN p_digest IS NULL THEN 'capture_failed' ELSE NULL END
    WHERE id=p_claim AND org_id=p_org AND state='claimed' AND claim_token=p_token AND claimed_until>clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'Reminder unavailable' USING ERRCODE='42501'; END IF;
  DELETE FROM app.b028_scheduled_contexts WHERE tx_id=txid_current() AND org_id=p_org AND claim_id=p_claim AND claim_token=p_token;
END $$;
REVOKE ALL ON FUNCTION app.b028_finish_scheduled(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b028_finish_scheduled(uuid,uuid,uuid,text) TO service_role;


CREATE FUNCTION app.b028_pending_scheduled(p_instant timestamptz) RETURNS TABLE(org_id uuid,event_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
  SELECT DISTINCT e.org_id,e.id FROM app.b010_source_events e JOIN app.b028_recipient_claims c ON c.org_id=e.org_id AND c.event_id=e.id
    JOIN public.leases l ON l.id=e.lease_id AND l.org_id=e.org_id
    JOIN public.organizations o ON o.id=e.org_id JOIN public.platform_settings f ON f.key='rent_reminders_v2'
    WHERE e.kind IN ('rent_due','rent_overdue') AND c.state IN ('queued','failed','claimed') AND o.environment='live'
      AND o.feature_flags->'rent_reminders_v2'='true'::jsonb AND f.value->'enabled'='true'::jsonb
      AND jsonb_typeof(f.value->'allowed_org_ids')='array' AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)
      AND EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name=o.timezone)
      AND (p_instant AT TIME ZONE o.timezone)::date=e.local_date ORDER BY e.org_id,e.id
$$;
REVOKE ALL ON FUNCTION app.b028_pending_scheduled(timestamptz) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b028_pending_scheduled(timestamptz) TO service_role;

-- Tenant preferences are derived from the current authenticated user; the
-- caller cannot submit another user ID or act for an unlinked contact.
CREATE FUNCTION app.b010_tenant_due_preference(p_org uuid,p_live uuid,p_env text,p_session uuid,p_lease uuid,p_value boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE v_actor uuid:=auth.uid(); v_old boolean; v_new boolean;
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (SELECT 1 FROM public.organizations o JOIN public.contacts ct ON ct.org_id=o.id
    JOIN public.lease_parties lp ON lp.contact_id=ct.id AND lp.org_id=ct.org_id
    JOIN public.auth_sessions sess ON sess.id=p_session AND sess.user_id=v_actor
    WHERE o.id=p_org AND o.environment::text=p_env AND ((o.environment='live' AND o.id=p_live AND o.live_org_id IS NULL) OR (o.environment='sandbox' AND o.live_org_id=p_live))
      AND ct.user_id=v_actor AND ct.archived_at IS NULL AND lp.lease_id=p_lease AND lp.role IN ('primary','co_tenant') AND sess.revoked_at IS NULL AND sess.expires_at>clock_timestamp()) THEN
    RAISE EXCEPTION 'Preference unavailable' USING ERRCODE='42501';
  END IF;
  LOCK TABLE public.platform_settings IN SHARE MODE NOWAIT;
  PERFORM 1 FROM public.organizations o JOIN public.platform_settings f ON f.key='rent_reminders_v2'
    JOIN public.contacts ct ON ct.org_id=o.id JOIN public.lease_parties lp ON lp.contact_id=ct.id AND lp.org_id=ct.org_id
    JOIN public.auth_sessions sess ON sess.id=p_session AND sess.user_id=v_actor
    WHERE o.id=p_org AND o.environment::text=p_env AND ((o.environment='live' AND o.id=p_live AND o.live_org_id IS NULL) OR (o.environment='sandbox' AND o.live_org_id=p_live))
      AND o.feature_flags->'rent_reminders_v2'='true'::jsonb AND f.value->'enabled'='true'::jsonb
      AND jsonb_typeof(f.value->'allowed_org_ids')='array' AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)
      AND ct.user_id=v_actor AND ct.archived_at IS NULL AND lp.lease_id=p_lease AND lp.role IN ('primary','co_tenant') AND sess.revoked_at IS NULL AND sess.expires_at>clock_timestamp()
    LIMIT 1 FOR SHARE OF o,ct,lp,sess NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'Preference unavailable' USING ERRCODE='42501'; END IF;
  SELECT pref.due_enabled INTO v_old FROM app.b010_tenant_due_preferences pref WHERE pref.org_id=p_org AND pref.user_id=v_actor;
  IF p_value IS NULL THEN RETURN coalesce(v_old,true); END IF;
  INSERT INTO app.b010_tenant_due_preferences(org_id,user_id) VALUES(p_org,v_actor) ON CONFLICT(org_id,user_id) DO NOTHING;
  SELECT due_enabled INTO v_old FROM app.b010_tenant_due_preferences WHERE org_id=p_org AND user_id=v_actor FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM public.auth_sessions sess WHERE sess.id=p_session AND sess.user_id=v_actor AND sess.revoked_at IS NULL AND sess.expires_at>clock_timestamp()) THEN
    RAISE EXCEPTION 'Preference unavailable' USING ERRCODE='42501';
  END IF;
  UPDATE app.b010_tenant_due_preferences SET due_enabled=p_value,updated_at=clock_timestamp() WHERE org_id=p_org AND user_id=v_actor;
  v_new:=p_value;
  IF v_old IS DISTINCT FROM v_new THEN
    INSERT INTO public.audit_log(org_id,actor_user_id,actor_role,table_name,row_id,action,event_type,old_row,new_row)
      VALUES(p_org,v_actor,'tenant','b010_tenant_due_preferences',v_actor::text,'update','tenant_due_reminder_preference_changed',jsonb_build_object('due_enabled',v_old),jsonb_build_object('due_enabled',v_new));
  END IF;
  RETURN v_new;
END $$;
REVOKE ALL ON FUNCTION app.b010_tenant_due_preference(uuid,uuid,text,uuid,uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b010_tenant_due_preference(uuid,uuid,text,uuid,uuid,boolean) TO service_role;

-- Read only the current actor's own committed command, not submitted payload.
CREATE FUNCTION app.b010_payment_command_status(p_org uuid,p_live uuid,p_env text,p_session uuid,p_lease uuid,p_role text,p_request uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE v_actor uuid:=auth.uid();
BEGIN
  IF p_request IS NULL OR NOT app.b010_lock_payment_context(p_org,p_live,p_env,p_session,p_lease,p_role) THEN
    RAISE EXCEPTION 'Payment result unavailable' USING ERRCODE='42501';
  END IF;
  IF EXISTS (SELECT 1 FROM app.b010_payment_commands cmd JOIN public.payments p ON p.id=cmd.payment_id AND p.org_id=cmd.org_id
    JOIN app.b010_source_events e ON e.org_id=p.org_id AND e.payment_id=p.id AND e.kind='payment_confirmed' AND e.actor_id=v_actor
    WHERE cmd.org_id=p_org AND cmd.actor_id=v_actor AND cmd.request_id=p_request AND p.lease_id=p_lease AND p.status IN ('confirmed','reversed')) THEN
    RETURN 'recorded';
  END IF;
  RETURN 'unknown';
END $$;
REVOKE ALL ON FUNCTION app.b010_payment_command_status(uuid,uuid,text,uuid,uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b010_payment_command_status(uuid,uuid,text,uuid,uuid,text,uuid) TO authenticated,service_role;

COMMIT;

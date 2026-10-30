BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- Independent center control: no dependency on email or payment rollouts.
INSERT INTO public.platform_settings(key,value,description)
VALUES ('notification_center_v2','{"enabled":false,"allowed_org_ids":[]}'::jsonb,'Local notification center rollout') ON CONFLICT(key) DO NOTHING;
CREATE UNIQUE INDEX IF NOT EXISTS b028_vendor_job_scope_unique ON public.repair_vendor_jobs(org_id,ticket_id,id);

-- Only source families with an existing durable source identity are allowed.
-- No producer gateway is granted by this migration.
CREATE TABLE app.b028_center_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES public.organizations(id),
 kind text NOT NULL CHECK(kind IN ('rent_due','rent_overdue','rent_manual','payment_confirmed','payment_rejected','payment_reversed','vendor_job_assigned')),
 b010_event_id uuid, ticket_id uuid, job_id uuid,
 occurred_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(org_id,id), UNIQUE(org_id,b010_event_id), UNIQUE(org_id,job_id),
 FOREIGN KEY(org_id,b010_event_id) REFERENCES app.b010_source_events(org_id,id),
 FOREIGN KEY(org_id,ticket_id,job_id) REFERENCES public.repair_vendor_jobs(org_id,ticket_id,id),
 CHECK ((kind='vendor_job_assigned' AND b010_event_id IS NULL AND ticket_id IS NOT NULL AND job_id IS NOT NULL)
     OR (kind<>'vendor_job_assigned' AND b010_event_id IS NOT NULL AND ticket_id IS NULL AND job_id IS NULL))
);
CREATE FUNCTION app.b028_center_source_valid() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF NEW.b010_event_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.b010_source_events b WHERE b.id=NEW.b010_event_id AND b.org_id=NEW.org_id AND b.kind=NEW.kind AND b.created_at=NEW.occurred_at) THEN
   RAISE EXCEPTION 'Invalid event source' USING ERRCODE='23514';
 END IF;
 IF NEW.job_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.repair_vendor_jobs j WHERE j.id=NEW.job_id AND j.org_id=NEW.org_id AND j.ticket_id=NEW.ticket_id AND j.created_at=NEW.occurred_at) THEN
   RAISE EXCEPTION 'Invalid event source' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER b028_center_source_valid AFTER INSERT ON app.b028_center_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.b028_center_source_valid();
CREATE TABLE app.b028_center_recipients (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, event_id uuid NOT NULL,
 persona text NOT NULL CHECK(persona IN ('staff','tenant','owner','vendor_job')),
 principal_user_id uuid REFERENCES auth.users(id), member_id uuid REFERENCES public.org_members(id), contact_id uuid,
 ticket_id uuid, job_id uuid, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(org_id,id), FOREIGN KEY(org_id,event_id) REFERENCES app.b028_center_events(org_id,id),
 FOREIGN KEY(org_id,contact_id) REFERENCES public.contacts(org_id,id),
 FOREIGN KEY(org_id,ticket_id,job_id) REFERENCES public.repair_vendor_jobs(org_id,ticket_id,id),
 CHECK ((persona='staff' AND principal_user_id IS NOT NULL AND member_id IS NOT NULL AND contact_id IS NULL AND ticket_id IS NULL AND job_id IS NULL)
 OR (persona IN ('tenant','owner') AND principal_user_id IS NOT NULL AND contact_id IS NOT NULL AND member_id IS NULL AND ticket_id IS NULL AND job_id IS NULL)
 OR (persona='vendor_job' AND principal_user_id IS NULL AND member_id IS NULL AND contact_id IS NULL AND ticket_id IS NOT NULL AND job_id IS NOT NULL))
);
CREATE UNIQUE INDEX b028_center_staff_recipient ON app.b028_center_recipients(org_id,event_id,member_id) WHERE persona='staff';
CREATE UNIQUE INDEX b028_center_contact_recipient ON app.b028_center_recipients(org_id,event_id,persona,contact_id) WHERE persona IN ('tenant','owner');
CREATE UNIQUE INDEX b028_center_vendor_recipient ON app.b028_center_recipients(org_id,event_id,job_id) WHERE persona='vendor_job';
-- Verify the immutable recipient snapshot at issuance, including source scope.
-- This is a private owner-only contract; no application producer is enabled.
CREATE FUNCTION app.b028_center_recipient_valid() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE e app.b028_center_events; v_lease uuid; v_property uuid; v_ticket uuid;
BEGIN
 SELECT * INTO e FROM app.b028_center_events WHERE id=NEW.event_id AND org_id=NEW.org_id FOR SHARE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Invalid recipient' USING ERRCODE='23514'; END IF;
 IF e.b010_event_id IS NOT NULL THEN
  SELECT b.lease_id INTO v_lease FROM app.b010_source_events b WHERE b.id=e.b010_event_id AND b.org_id=e.org_id;
 ELSE
  SELECT t.lease_id,t.property_id,t.id INTO v_lease,v_property,v_ticket FROM public.maintenance_tickets t
   JOIN public.repair_vendor_jobs j ON j.ticket_id=t.id AND j.org_id=t.org_id
   WHERE j.id=e.job_id AND j.org_id=e.org_id AND t.id=e.ticket_id FOR SHARE OF t,j NOWAIT;
 END IF;
 IF NEW.persona='staff' THEN
  PERFORM 1 FROM public.org_members m JOIN public.organizations o ON o.id=NEW.org_id
   WHERE m.id=NEW.member_id AND m.user_id=NEW.principal_user_id AND m.status='active'
    AND m.org_id=CASE WHEN o.environment='sandbox' THEN o.live_org_id ELSE o.id END
    AND ((e.kind LIKE 'payment_%' AND m.role IN ('admin','manager','accountant')) OR (e.kind IN ('rent_due','rent_overdue','rent_manual') AND m.role IN ('admin','manager')) OR (e.kind='vendor_job_assigned' AND m.role IN ('admin','manager','maintenance'))) FOR SHARE OF m NOWAIT;
 ELSIF NEW.persona='tenant' THEN
  IF v_ticket IS NOT NULL THEN LOCK TABLE public.contacts IN SHARE MODE NOWAIT; END IF;
  PERFORM 1 FROM public.contacts c JOIN public.lease_parties lp ON lp.contact_id=c.id AND lp.org_id=c.org_id
   WHERE c.id=NEW.contact_id AND c.org_id=NEW.org_id AND c.user_id=NEW.principal_user_id AND c.is_tenant AND c.archived_at IS NULL
    AND lp.lease_id=v_lease AND lp.role IN ('primary','co_tenant') FOR SHARE OF c,lp NOWAIT;
  IF FOUND AND v_ticket IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.maintenance_tickets t WHERE t.id=v_ticket AND t.org_id=NEW.org_id AND (
   t.reported_by_user=NEW.principal_user_id OR t.reported_by_contact_id=NEW.contact_id OR
   (t.reported_by_contact_id IS NULL AND NOT EXISTS (SELECT 1 FROM public.contacts other WHERE other.user_id=t.reported_by_user AND other.is_tenant AND other.archived_at IS NULL AND other.user_id IS DISTINCT FROM NEW.principal_user_id)))) THEN
   RAISE EXCEPTION 'Invalid recipient' USING ERRCODE='23514';
  END IF;
 ELSIF NEW.persona='owner' THEN
  PERFORM 1 FROM public.contacts c JOIN public.property_owners po ON po.owner_contact_id=c.id AND po.org_id=c.org_id JOIN public.organizations o ON o.id=c.org_id
   WHERE e.kind='vendor_job_assigned' AND c.id=NEW.contact_id AND c.org_id=NEW.org_id AND c.user_id=NEW.principal_user_id AND c.is_owner AND c.archived_at IS NULL
    AND po.property_id=v_property AND EXISTS(SELECT 1 FROM pg_timezone_names z WHERE z.name=o.timezone) AND po.effective_from<=(clock_timestamp() AT TIME ZONE o.timezone)::date AND (po.effective_to IS NULL OR po.effective_to>(clock_timestamp() AT TIME ZONE o.timezone)::date) FOR SHARE OF c,po NOWAIT;
 ELSE
  PERFORM 1 FROM public.repair_vendor_jobs j JOIN public.maintenance_tickets t ON t.id=j.ticket_id AND t.org_id=j.org_id
   WHERE e.kind='vendor_job_assigned' AND j.id=e.job_id AND j.id=NEW.job_id AND j.ticket_id=NEW.ticket_id AND j.org_id=NEW.org_id
    AND j.active AND j.revoked_at IS NULL AND j.expires_at>clock_timestamp() AND j.vendor_contact_id IS NOT NULL AND j.vendor_contact_id=t.assigned_vendor_contact_id FOR SHARE OF j,t NOWAIT;
 END IF;
 IF NOT FOUND THEN RAISE EXCEPTION 'Invalid recipient' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER b028_center_recipient_valid BEFORE INSERT ON app.b028_center_recipients FOR EACH ROW EXECUTE FUNCTION app.b028_center_recipient_valid();
REVOKE ALL ON FUNCTION app.b028_center_recipient_valid() FROM PUBLIC,anon,authenticated,service_role;

CREATE TABLE app.b028_center_reads (
 org_id uuid NOT NULL,recipient_id uuid NOT NULL,read_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(org_id,recipient_id), FOREIGN KEY(org_id,recipient_id) REFERENCES app.b028_center_recipients(org_id,id)
);
-- Server-owned opaque short-lived continuation; no source IDs are returned.
CREATE TABLE app.b028_center_cursors (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, actor_id uuid, session_id uuid, persona text, job_id uuid,
 after_time timestamptz NOT NULL, after_id uuid NOT NULL, expires_at timestamptz NOT NULL DEFAULT (clock_timestamp()+interval '15 minutes'),
 CHECK ((actor_id IS NOT NULL AND session_id IS NOT NULL AND persona IN ('staff','tenant','owner') AND job_id IS NULL)
     OR (actor_id IS NULL AND session_id IS NULL AND persona IS NULL AND job_id IS NOT NULL))
);
CREATE TABLE app.b028_center_mark_contexts (
 tx_id bigint NOT NULL, org_id uuid NOT NULL, recipient_id uuid NOT NULL, actor_id uuid, session_id uuid, job_id uuid, persona text, contact_id uuid, property_id uuid,
 PRIMARY KEY(tx_id,org_id,recipient_id), CHECK ((actor_id IS NOT NULL AND session_id IS NOT NULL AND job_id IS NULL) OR (actor_id IS NULL AND session_id IS NULL AND job_id IS NOT NULL))
);
REVOKE ALL ON app.b028_center_events,app.b028_center_recipients,app.b028_center_reads,app.b028_center_mark_contexts,app.b028_center_cursors FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION app.b028_center_mark_commit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF NEW.actor_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.auth_sessions s WHERE s.id=NEW.session_id AND s.user_id=NEW.actor_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()) THEN
  RAISE EXCEPTION 'Notification unavailable' USING ERRCODE='42501';
 END IF;
 IF NEW.persona='owner' AND NOT EXISTS (SELECT 1 FROM public.organizations o JOIN public.contacts c ON c.org_id=o.id JOIN public.property_owners po ON po.org_id=o.id AND po.owner_contact_id=c.id
  WHERE o.id=NEW.org_id AND c.id=NEW.contact_id AND c.user_id=NEW.actor_id AND c.is_owner AND c.archived_at IS NULL AND po.property_id=NEW.property_id
   AND EXISTS(SELECT 1 FROM pg_timezone_names z WHERE z.name=o.timezone) AND po.effective_from<=(clock_timestamp() AT TIME ZONE o.timezone)::date
   AND (po.effective_to IS NULL OR po.effective_to>(clock_timestamp() AT TIME ZONE o.timezone)::date)) THEN
  RAISE EXCEPTION 'Notification unavailable' USING ERRCODE='42501';
 END IF;
 IF NEW.job_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.repair_vendor_jobs j WHERE j.id=NEW.job_id AND j.org_id=NEW.org_id AND j.active AND j.revoked_at IS NULL AND j.expires_at>clock_timestamp()) THEN
  RAISE EXCEPTION 'Notification unavailable' USING ERRCODE='42501';
 END IF;
 DELETE FROM app.b028_center_mark_contexts WHERE tx_id=NEW.tx_id AND org_id=NEW.org_id AND recipient_id=NEW.recipient_id;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER b028_center_mark_commit AFTER INSERT ON app.b028_center_mark_contexts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.b028_center_mark_commit();
REVOKE ALL ON FUNCTION app.b028_center_mark_commit() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION app.b028_center_source_valid() FROM PUBLIC,anon,authenticated,service_role;

-- No mutation of historical source or entitlement records by any application role.
CREATE FUNCTION app.b028_center_immutable() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Immutable notification' USING ERRCODE='42501'; END $$;
CREATE TRIGGER b028_center_events_immutable BEFORE UPDATE OR DELETE ON app.b028_center_events FOR EACH ROW EXECUTE FUNCTION app.b028_center_immutable();
CREATE TRIGGER b028_center_recipients_immutable BEFORE UPDATE OR DELETE ON app.b028_center_recipients FOR EACH ROW EXECUTE FUNCTION app.b028_center_immutable();
REVOKE ALL ON FUNCTION app.b028_center_immutable() FROM PUBLIC,anon,authenticated,service_role;

-- Internal context lock. Initial authorization precedes privileged locks.
CREATE FUNCTION app.b028_center_context(p_org uuid,p_live uuid,p_env text,p_session uuid,p_persona text,p_role text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE v_actor uuid:=auth.uid(); v_allowed boolean;
BEGIN
 IF v_actor IS NULL OR p_persona NOT IN ('staff','tenant','owner') OR NOT EXISTS (
   SELECT 1 FROM public.organizations o JOIN public.auth_sessions s ON s.id=p_session AND s.user_id=v_actor
   WHERE o.id=p_org AND o.environment::text=p_env AND ((o.environment='live' AND o.id=p_live AND o.live_org_id IS NULL) OR (o.environment='sandbox' AND o.live_org_id=p_live))
     AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
     AND ((p_persona='staff' AND EXISTS (SELECT 1 FROM public.org_members m WHERE m.org_id=CASE WHEN o.environment='sandbox' THEN o.live_org_id ELSE o.id END AND m.user_id=v_actor AND m.status='active' AND m.role::text=p_role))
       OR (p_persona IN ('tenant','owner') AND EXISTS (SELECT 1 FROM public.contacts c WHERE c.org_id=o.id AND c.user_id=v_actor AND c.archived_at IS NULL AND ((p_persona='tenant' AND c.is_tenant) OR (p_persona='owner' AND c.is_owner)))))
 ) THEN RAISE EXCEPTION 'Notification unavailable' USING ERRCODE='42501'; END IF;
 LOCK TABLE public.platform_settings IN SHARE MODE NOWAIT;
 PERFORM 1 FROM public.organizations o WHERE o.id=p_org FOR SHARE NOWAIT;
 SELECT EXISTS (SELECT 1 FROM public.organizations o JOIN public.platform_settings f ON f.key='notification_center_v2'
   WHERE o.id=p_org AND o.environment::text=p_env AND ((o.environment='live' AND o.id=p_live AND o.live_org_id IS NULL) OR (o.environment='sandbox' AND o.live_org_id=p_live))
    AND o.feature_flags->'notification_center_v2'='true'::jsonb AND f.value->'enabled'='true'::jsonb
    AND jsonb_typeof(f.value->'allowed_org_ids')='array' AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) INTO v_allowed;
 IF NOT v_allowed THEN RETURN false; END IF;
 PERFORM 1 FROM public.auth_sessions s WHERE s.id=p_session AND s.user_id=v_actor AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR SHARE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Notification unavailable' USING ERRCODE='42501'; END IF;
 IF p_persona='staff' THEN
  PERFORM 1 FROM public.org_members m JOIN public.organizations o ON o.id=p_org
   WHERE m.org_id=CASE WHEN o.environment='sandbox' THEN o.live_org_id ELSE o.id END AND m.user_id=v_actor AND m.status='active' AND m.role::text=p_role FOR SHARE OF m NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'Notification unavailable' USING ERRCODE='42501'; END IF;
 END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION app.b028_center_context(uuid,uuid,text,uuid,text,text) FROM PUBLIC,anon,authenticated,service_role;

-- A single predicate is used for listing and marking; mark IDs never authorize.
CREATE FUNCTION app.b028_center_session(p_org uuid,p_live uuid,p_env text,p_session uuid,p_persona text,p_role text,p_mark uuid DEFAULT NULL,p_cursor uuid DEFAULT NULL)
RETURNS TABLE(recipient_id uuid,kind text,occurred_at timestamptz,read_at timestamptz,continuation uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE v_actor uuid:=auth.uid(); r record; v_lease uuid; v_property uuid; v_read timestamptz; v_count integer:=0; v_scanned integer:=0; v_after_time timestamptz; v_after_id uuid; v_last_time timestamptz; v_last_id uuid; v_owner_recipients uuid[]:=ARRAY[]::uuid[];
BEGIN
 IF NOT app.b028_center_context(p_org,p_live,p_env,p_session,p_persona,p_role) THEN RETURN; END IF;
 DELETE FROM app.b028_center_cursors WHERE id IN (SELECT cur.id FROM app.b028_center_cursors cur WHERE cur.expires_at<=clock_timestamp() ORDER BY cur.expires_at,cur.id LIMIT 100 FOR UPDATE SKIP LOCKED);
 IF p_cursor IS NOT NULL THEN
  SELECT cur.after_time,cur.after_id INTO v_after_time,v_after_id FROM app.b028_center_cursors cur
   WHERE cur.id=p_cursor AND cur.org_id=p_org AND cur.actor_id=v_actor AND cur.session_id=p_session AND cur.persona=p_persona AND cur.expires_at>clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'Notification unavailable' USING ERRCODE='42501'; END IF;
 END IF;
 FOR r IN SELECT ent.id AS rid,ent.contact_id,ent.member_id,e.id AS eid,e.kind AS ekind,e.occurred_at AS happened,e.b010_event_id,e.ticket_id,e.job_id
   FROM app.b028_center_recipients ent JOIN app.b028_center_events e ON e.id=ent.event_id AND e.org_id=ent.org_id
   WHERE ent.org_id=p_org AND ent.persona=p_persona AND ent.principal_user_id=v_actor AND (p_mark IS NULL OR ent.id=p_mark)
     AND (p_mark IS NOT NULL OR v_after_time IS NULL OR (e.occurred_at,ent.id)>(v_after_time,v_after_id))
   ORDER BY e.occurred_at,ent.id LIMIT 500
 LOOP
  v_scanned:=v_scanned+1; v_last_time:=r.happened; v_last_id:=r.rid;
  v_lease:=NULL; v_property:=NULL;
  IF r.b010_event_id IS NOT NULL THEN
   SELECT b.lease_id INTO v_lease FROM app.b010_source_events b WHERE b.org_id=p_org AND b.id=r.b010_event_id AND b.kind=r.ekind;
  ELSE
   SELECT t.lease_id,t.property_id INTO v_lease,v_property FROM public.maintenance_tickets t JOIN public.repair_vendor_jobs j ON j.ticket_id=t.id AND j.org_id=t.org_id
    WHERE t.org_id=p_org AND t.id=r.ticket_id AND j.id=r.job_id;
  END IF;
  IF p_persona='staff' THEN
   IF NOT EXISTS (SELECT 1 FROM public.org_members m JOIN public.organizations o ON o.id=p_org WHERE m.id=r.member_id AND m.user_id=v_actor AND m.status='active' AND m.role::text=p_role AND m.org_id=CASE WHEN o.environment='sandbox' THEN o.live_org_id ELSE o.id END
     AND ((r.ekind LIKE 'payment_%' AND m.role IN ('admin','manager','accountant')) OR (r.ekind IN ('rent_due','rent_overdue','rent_manual') AND m.role IN ('admin','manager')) OR (r.ekind='vendor_job_assigned' AND m.role IN ('admin','manager','maintenance')))) THEN CONTINUE; END IF;
  ELSIF p_persona='tenant' THEN
   IF v_lease IS NULL THEN CONTINUE; END IF;
   IF r.ticket_id IS NOT NULL THEN LOCK TABLE public.contacts IN SHARE MODE NOWAIT; END IF;
   PERFORM 1 FROM public.contacts c JOIN public.lease_parties lp ON lp.contact_id=c.id AND lp.org_id=c.org_id
    WHERE c.id=r.contact_id AND c.org_id=p_org AND c.user_id=v_actor AND c.is_tenant AND c.archived_at IS NULL AND lp.lease_id=v_lease AND lp.role IN ('primary','co_tenant') FOR SHARE OF c,lp NOWAIT;
   IF NOT FOUND THEN CONTINUE; END IF;
  ELSE
   IF r.ekind<>'vendor_job_assigned' OR v_property IS NULL THEN CONTINUE; END IF;
   PERFORM 1 FROM public.contacts c JOIN public.property_owners po ON po.owner_contact_id=c.id AND po.org_id=c.org_id JOIN public.organizations o ON o.id=c.org_id
    WHERE c.id=r.contact_id AND c.org_id=p_org AND c.user_id=v_actor AND c.is_owner AND c.archived_at IS NULL AND po.property_id=v_property
      AND EXISTS(SELECT 1 FROM pg_timezone_names z WHERE z.name=o.timezone) AND po.effective_from<=(clock_timestamp() AT TIME ZONE o.timezone)::date AND (po.effective_to IS NULL OR po.effective_to>(clock_timestamp() AT TIME ZONE o.timezone)::date) FOR SHARE OF c,po NOWAIT;
   IF NOT FOUND THEN CONTINUE; END IF;
  END IF;
  IF v_lease IS NOT NULL THEN PERFORM 1 FROM public.leases l WHERE l.id=v_lease AND l.org_id=p_org FOR SHARE NOWAIT; IF NOT FOUND THEN CONTINUE; END IF; END IF;
  IF r.ticket_id IS NOT NULL THEN
   PERFORM 1 FROM public.maintenance_tickets t WHERE t.id=r.ticket_id AND t.org_id=p_org AND t.lease_id IS NOT DISTINCT FROM v_lease AND t.property_id=v_property FOR SHARE NOWAIT;
   IF NOT FOUND THEN CONTINUE; END IF;
   IF p_persona='tenant' AND NOT app.tenant_owns_ticket(r.ticket_id) THEN CONTINUE; END IF;
   PERFORM 1 FROM public.repair_vendor_jobs j WHERE j.id=r.job_id AND j.ticket_id=r.ticket_id AND j.org_id=p_org FOR SHARE NOWAIT;
   IF NOT FOUND THEN CONTINUE; END IF;
  END IF;
  PERFORM 1 FROM app.b028_center_events e JOIN app.b028_center_recipients ent ON ent.event_id=e.id AND ent.org_id=e.org_id
   WHERE e.id=r.eid AND ent.id=r.rid AND ent.principal_user_id=v_actor AND ent.persona=p_persona FOR SHARE OF e,ent NOWAIT;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.auth_sessions s WHERE s.id=p_session AND s.user_id=v_actor AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'Notification unavailable' USING ERRCODE='42501'; END IF;
  IF p_mark IS NOT NULL THEN
   INSERT INTO app.b028_center_reads(org_id,recipient_id) VALUES(p_org,r.rid) ON CONFLICT DO NOTHING;
   IF NOT EXISTS(SELECT 1 FROM public.auth_sessions s WHERE s.id=p_session AND s.user_id=v_actor AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'Notification unavailable' USING ERRCODE='42501'; END IF;
   INSERT INTO app.b028_center_mark_contexts(tx_id,org_id,recipient_id,actor_id,session_id,persona,contact_id,property_id) VALUES(txid_current(),p_org,r.rid,v_actor,p_session,p_persona,r.contact_id,v_property) ON CONFLICT DO NOTHING;
  END IF;
  SELECT rd.read_at INTO v_read FROM app.b028_center_reads rd WHERE rd.org_id=p_org AND rd.recipient_id=r.rid;
  IF p_persona='owner' THEN v_owner_recipients:=array_append(v_owner_recipients,r.rid); END IF;
  recipient_id:=r.rid; kind:=r.ekind; occurred_at:=r.happened; read_at:=v_read; continuation:=NULL; RETURN NEXT;
  v_count:=v_count+1; IF v_count>=100 THEN EXIT; END IF;
 END LOOP;
 IF p_mark IS NULL AND (v_count>=100 OR v_scanned>=500) THEN
  IF NOT EXISTS(SELECT 1 FROM public.auth_sessions sess WHERE sess.id=p_session AND sess.user_id=v_actor AND sess.revoked_at IS NULL AND sess.expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'Notification unavailable' USING ERRCODE='42501'; END IF;
  INSERT INTO app.b028_center_cursors(org_id,actor_id,session_id,persona,after_time,after_id) VALUES(p_org,v_actor,p_session,p_persona,v_last_time,v_last_id) RETURNING id INTO continuation;
  recipient_id:=NULL;kind:=NULL;occurred_at:=NULL;read_at:=NULL; RETURN NEXT;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.auth_sessions sess WHERE sess.id=p_session AND sess.user_id=v_actor AND sess.revoked_at IS NULL AND sess.expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'Notification unavailable' USING ERRCODE='42501'; END IF;
 IF p_persona='owner' AND EXISTS(SELECT 1 FROM unnest(v_owner_recipients) AS requested(id) JOIN app.b028_center_recipients ent ON ent.id=requested.id JOIN app.b028_center_events e ON e.id=ent.event_id AND e.org_id=ent.org_id JOIN public.maintenance_tickets t ON t.id=e.ticket_id AND t.org_id=e.org_id
  WHERE NOT EXISTS(SELECT 1 FROM public.organizations o JOIN public.contacts c ON c.org_id=o.id JOIN public.property_owners po ON po.org_id=o.id AND po.owner_contact_id=c.id
   WHERE o.id=p_org AND c.id=ent.contact_id AND c.user_id=v_actor AND c.is_owner AND c.archived_at IS NULL AND po.property_id=t.property_id AND EXISTS(SELECT 1 FROM pg_timezone_names z WHERE z.name=o.timezone)
    AND po.effective_from<=(clock_timestamp() AT TIME ZONE o.timezone)::date AND (po.effective_to IS NULL OR po.effective_to>(clock_timestamp() AT TIME ZONE o.timezone)::date))) THEN
  RAISE EXCEPTION 'Notification unavailable' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION app.b028_center_session(uuid,uuid,text,uuid,text,text,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b028_center_session(uuid,uuid,text,uuid,text,text,uuid,uuid) TO service_role;

CREATE FUNCTION app.b028_center_session_enabled(p_org uuid,p_live uuid,p_env text,p_session uuid,p_persona text,p_role text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT app.b028_center_context(p_org,p_live,p_env,p_session,p_persona,p_role)
$$;
REVOKE ALL ON FUNCTION app.b028_center_session_enabled(uuid,uuid,text,uuid,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b028_center_session_enabled(uuid,uuid,text,uuid,text,text) TO service_role;

-- Exact job-bound bearer resolution; the hash is an input only, never stored.
CREATE FUNCTION app.b028_center_vendor_context(p_hash text)
RETURNS TABLE(org_id uuid,ticket_id uuid,job_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE v_org uuid; v_ticket uuid; v_job uuid; v_enabled boolean;
BEGIN
 IF p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Notification unavailable' USING ERRCODE='42501'; END IF;
 SELECT j.org_id,j.ticket_id,j.id INTO v_org,v_ticket,v_job FROM public.repair_vendor_jobs j JOIN public.maintenance_tickets t ON t.id=j.ticket_id AND t.org_id=j.org_id
  WHERE j.token_hash=p_hash AND j.active AND j.revoked_at IS NULL AND j.expires_at>clock_timestamp()
    AND j.vendor_contact_id IS NOT NULL AND j.vendor_contact_id=t.assigned_vendor_contact_id AND app.vendor_dispatch_enabled(j.org_id);
 IF v_job IS NULL THEN RAISE EXCEPTION 'Notification unavailable' USING ERRCODE='42501'; END IF;
 LOCK TABLE public.platform_settings IN SHARE MODE NOWAIT;
 PERFORM 1 FROM public.organizations o WHERE o.id=v_org FOR SHARE NOWAIT;
 SELECT EXISTS(SELECT 1 FROM public.organizations o JOIN public.platform_settings f ON f.key='notification_center_v2'
   WHERE o.id=v_org AND o.feature_flags->'notification_center_v2'='true'::jsonb AND f.value->'enabled'='true'::jsonb
    AND jsonb_typeof(f.value->'allowed_org_ids')='array' AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) INTO v_enabled;
 IF NOT v_enabled THEN RETURN; END IF;
 PERFORM 1 FROM public.maintenance_tickets t WHERE t.id=v_ticket AND t.org_id=v_org FOR SHARE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Notification unavailable' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.repair_vendor_jobs j JOIN public.maintenance_tickets t ON t.id=j.ticket_id AND t.org_id=j.org_id JOIN public.organizations o ON o.id=j.org_id
  WHERE j.id=v_job AND j.ticket_id=v_ticket AND j.org_id=v_org AND j.token_hash=p_hash
    AND j.active AND j.revoked_at IS NULL AND j.expires_at>clock_timestamp() AND j.vendor_contact_id IS NOT NULL
    AND j.vendor_contact_id=t.assigned_vendor_contact_id AND app.vendor_dispatch_enabled(j.org_id)
    AND (coalesce(o.feature_flags->>'vendor_link','false') <> 'true' OR (j.scope='case_collaboration' AND j.sharing_approved_at IS NOT NULL)) FOR SHARE OF j NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Notification unavailable' USING ERRCODE='42501'; END IF;
 org_id:=v_org; ticket_id:=v_ticket; job_id:=v_job; RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION app.b028_center_vendor_context(text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION app.b028_center_vendor(p_hash text,p_mark uuid DEFAULT NULL,p_cursor uuid DEFAULT NULL)
RETURNS TABLE(recipient_id uuid,kind text,occurred_at timestamptz,read_at timestamptz,continuation uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE ctx record; r record; v_read timestamptz; v_count integer:=0; v_scanned integer:=0; v_after_time timestamptz; v_after_id uuid; v_last_time timestamptz; v_last_id uuid;
BEGIN
 SELECT * INTO ctx FROM app.b028_center_vendor_context(p_hash);
 IF ctx.job_id IS NULL THEN RETURN; END IF;
 DELETE FROM app.b028_center_cursors WHERE id IN (SELECT cur.id FROM app.b028_center_cursors cur WHERE cur.expires_at<=clock_timestamp() ORDER BY cur.expires_at,cur.id LIMIT 100 FOR UPDATE SKIP LOCKED);
 IF p_cursor IS NOT NULL THEN
  SELECT cur.after_time,cur.after_id INTO v_after_time,v_after_id FROM app.b028_center_cursors cur
   WHERE cur.id=p_cursor AND cur.org_id=ctx.org_id AND cur.job_id=ctx.job_id AND cur.expires_at>clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'Notification unavailable' USING ERRCODE='42501'; END IF;
 END IF;
 FOR r IN SELECT ent.id AS rid,e.id AS eid,e.kind AS ekind,e.occurred_at AS happened FROM app.b028_center_recipients ent
  JOIN app.b028_center_events e ON e.id=ent.event_id AND e.org_id=ent.org_id
  WHERE ent.org_id=ctx.org_id AND ent.persona='vendor_job' AND ent.job_id=ctx.job_id AND ent.ticket_id=ctx.ticket_id
   AND e.job_id=ctx.job_id AND e.ticket_id=ctx.ticket_id AND e.kind='vendor_job_assigned' AND (p_mark IS NULL OR ent.id=p_mark)
   AND (p_mark IS NOT NULL OR v_after_time IS NULL OR (e.occurred_at,ent.id)>(v_after_time,v_after_id))
  ORDER BY e.occurred_at,ent.id LIMIT 500
 LOOP
  v_scanned:=v_scanned+1; v_last_time:=r.happened; v_last_id:=r.rid;
  PERFORM 1 FROM app.b028_center_events e JOIN app.b028_center_recipients ent ON ent.event_id=e.id AND ent.org_id=e.org_id WHERE e.id=r.eid AND ent.id=r.rid FOR SHARE OF e,ent NOWAIT;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.repair_vendor_jobs j WHERE j.id=ctx.job_id AND j.token_hash=p_hash AND j.active AND j.revoked_at IS NULL AND j.expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'Notification unavailable' USING ERRCODE='42501'; END IF;
  IF p_mark IS NOT NULL THEN
   INSERT INTO app.b028_center_reads(org_id,recipient_id) VALUES(ctx.org_id,r.rid) ON CONFLICT DO NOTHING;
   IF NOT EXISTS(SELECT 1 FROM public.repair_vendor_jobs j WHERE j.id=ctx.job_id AND j.org_id=ctx.org_id AND j.active AND j.revoked_at IS NULL AND j.expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'Notification unavailable' USING ERRCODE='42501'; END IF;
   INSERT INTO app.b028_center_mark_contexts(tx_id,org_id,recipient_id,job_id) VALUES(txid_current(),ctx.org_id,r.rid,ctx.job_id) ON CONFLICT DO NOTHING;
  END IF;
  SELECT rd.read_at INTO v_read FROM app.b028_center_reads rd WHERE rd.org_id=ctx.org_id AND rd.recipient_id=r.rid;
  recipient_id:=r.rid;kind:=r.ekind;occurred_at:=r.happened;read_at:=v_read;continuation:=NULL;RETURN NEXT;
  v_count:=v_count+1; IF v_count>=100 THEN EXIT; END IF;
 END LOOP;
 IF p_mark IS NULL AND (v_count>=100 OR v_scanned>=500) THEN
  IF NOT EXISTS(SELECT 1 FROM public.repair_vendor_jobs j WHERE j.id=ctx.job_id AND j.org_id=ctx.org_id AND j.active AND j.revoked_at IS NULL AND j.expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'Notification unavailable' USING ERRCODE='42501'; END IF;
  INSERT INTO app.b028_center_cursors(org_id,job_id,after_time,after_id) VALUES(ctx.org_id,ctx.job_id,v_last_time,v_last_id) RETURNING id INTO continuation;
  recipient_id:=NULL;kind:=NULL;occurred_at:=NULL;read_at:=NULL;RETURN NEXT;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.repair_vendor_jobs j WHERE j.id=ctx.job_id AND j.org_id=ctx.org_id AND j.active AND j.revoked_at IS NULL AND j.expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'Notification unavailable' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION app.b028_center_vendor(text,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b028_center_vendor(text,uuid,uuid) TO service_role;
CREATE FUNCTION app.b028_center_vendor_enabled(p_hash text) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT EXISTS(SELECT 1 FROM app.b028_center_vendor_context(p_hash))
$$;
REVOKE ALL ON FUNCTION app.b028_center_vendor_enabled(text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b028_center_vendor_enabled(text) TO service_role;
COMMIT;

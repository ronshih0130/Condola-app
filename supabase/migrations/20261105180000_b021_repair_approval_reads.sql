-- B-021: scoped approval reads and appointment/job agreement. No flag changes.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION app.b013_owner_pending(p_org uuid,p_live uuid,p_env text,p_session uuid)
RETURNS TABLE(ticket_id uuid,property_id uuid,version_id uuid,version_no bigint,
 currency char(3),minor_unit smallint,amount_minor bigint,captured_threshold_minor bigint,
 threshold_source text,work_scope text,evidence_snapshot jsonb,submitted_at timestamptz,
 has_emergency boolean,reminder_intent_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE a record;
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM public.organizations o
  JOIN public.organizations live ON live.id=p_live AND live.environment='live' AND live.live_org_id IS NULL
  WHERE o.id=p_org AND o.environment::text=p_env AND
   ((p_env='live' AND o.id=p_live AND o.live_org_id IS NULL)
    OR (p_env='sandbox' AND o.live_org_id=p_live))
 ) THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 SELECT * INTO a FROM app.b013_actor(p_org,p_session);
 IF NOT app.b013_approvals_enabled(p_org) THEN RETURN; END IF;
 RETURN QUERY
 SELECT v.ticket_id,v.property_id,v.id,v.version_no,v.currency,v.minor_unit,v.amount_minor,
  v.captured_threshold_minor,v.threshold_source,v.work_scope,
  coalesce((SELECT jsonb_agg(jsonb_build_object('id', x->>'id'))
    FROM jsonb_array_elements(v.evidence_snapshot) x),'[]'::jsonb),
  v.submitted_at,
  EXISTS (SELECT 1 FROM app.b013_repair_emergencies e
   WHERE e.org_id=v.org_id AND e.ticket_id=v.ticket_id AND e.version_id=v.id),
  (SELECT r.occurred_at FROM app.b013_repair_event_outbox r
   WHERE r.org_id=v.org_id AND r.ticket_id=v.ticket_id AND r.version_id=v.id
    AND r.kind='approval_reminder_24h')
 FROM app.b013_estimate_versions v
 JOIN app.b013_estimate_heads h ON h.org_id=v.org_id AND h.ticket_id=v.ticket_id AND h.current_version_id=v.id
 WHERE v.org_id=p_org AND v.designated_principal_id=a.actor AND v.requires_owner_decision
  AND NOT EXISTS (SELECT 1 FROM app.b013_estimate_decisions d
   WHERE d.org_id=v.org_id AND d.ticket_id=v.ticket_id AND d.version_id=v.id)
 ORDER BY v.submitted_at,v.ticket_id;
END $$;
REVOKE ALL ON FUNCTION app.b013_owner_pending(uuid,uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b013_owner_pending(uuid,uuid,text,uuid) TO service_role;

CREATE FUNCTION app.b013_owner_history(p_org uuid,p_live uuid,p_env text,p_session uuid,p_ticket uuid)
RETURNS TABLE(version_id uuid,version_no bigint,amount_minor bigint,currency char(3),
 minor_unit smallint,captured_threshold_minor bigint,requires_owner_decision boolean,
 submitted_at timestamptz,decision text,decided_at timestamptz,decision_reason text,
 emergency_category text,emergency_reason text,emergency_photo_refs jsonb,
 emergency_notice_intent_at timestamptz,is_current boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE a record;
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM public.organizations o
  JOIN public.organizations live ON live.id=p_live AND live.environment='live' AND live.live_org_id IS NULL
  WHERE o.id=p_org AND o.environment::text=p_env AND
   ((p_env='live' AND o.id=p_live AND o.live_org_id IS NULL)
    OR (p_env='sandbox' AND o.live_org_id=p_live))
 ) THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 SELECT * INTO a FROM app.b013_actor(p_org,p_session);
 IF NOT app.b013_approvals_enabled(p_org) THEN RETURN; END IF;
 RETURN QUERY
 SELECT v.id,v.version_no,v.amount_minor,v.currency,v.minor_unit,v.captured_threshold_minor,
  v.requires_owner_decision,v.submitted_at,d.decision,d.decided_at,d.reason,e.category,e.reason,
  coalesce((SELECT jsonb_agg(jsonb_build_object('id', x->>'id'))
    FROM jsonb_array_elements(e.authorized_photo_snapshot) x),'[]'::jsonb),
  n.occurred_at,h.current_version_id=v.id
 FROM app.b013_estimate_versions v
 JOIN app.b013_estimate_heads h ON h.org_id=v.org_id AND h.ticket_id=v.ticket_id
 LEFT JOIN app.b013_estimate_decisions d ON d.org_id=v.org_id AND d.ticket_id=v.ticket_id AND d.version_id=v.id
 LEFT JOIN app.b013_repair_emergencies e ON e.org_id=v.org_id AND e.ticket_id=v.ticket_id AND e.version_id=v.id
 LEFT JOIN app.b013_repair_event_outbox n ON n.org_id=v.org_id AND n.ticket_id=v.ticket_id
  AND n.version_id=v.id AND n.kind='emergency_owner_notice'
 WHERE v.org_id=p_org AND v.ticket_id=p_ticket AND v.designated_principal_id=a.actor
 ORDER BY v.version_no DESC;
END $$;
REVOKE ALL ON FUNCTION app.b013_owner_history(uuid,uuid,text,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b013_owner_history(uuid,uuid,text,uuid,uuid) TO service_role;

CREATE FUNCTION app.b013_manager_view(p_org uuid,p_live uuid,p_env text,p_session uuid,p_ticket uuid)
RETURNS TABLE(version_id uuid,version_no bigint,amount_minor bigint,currency char(3),
 minor_unit smallint,captured_threshold_minor bigint,threshold_source text,
 requires_owner_decision boolean,submitted_at timestamptz,submitted_by uuid,
 decision text,decided_at timestamptz,decided_by uuid,decision_reason text,
 emergency_category text,emergency_reason text,emergency_photo_refs jsonb,
 appointment_event_kind text,appointment_occurred_at timestamptz,
 reminder_intent_at timestamptz,emergency_notice_intent_at timestamptz,is_current boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE a record;
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM public.organizations o
  JOIN public.organizations live ON live.id=p_live AND live.environment='live' AND live.live_org_id IS NULL
  WHERE o.id=p_org AND o.environment::text=p_env AND
   ((p_env='live' AND o.id=p_live AND o.live_org_id IS NULL)
    OR (p_env='sandbox' AND o.live_org_id=p_live))
 ) THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 SELECT * INTO a FROM app.b013_actor(p_org,p_session);
 IF NOT app.b013_approvals_enabled(p_org) THEN RETURN; END IF;
 IF a.member_role IS NULL OR a.member_role NOT IN ('admin','manager') THEN
  RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501';
 END IF;
 RETURN QUERY
 SELECT v.id,v.version_no,v.amount_minor,v.currency,v.minor_unit,v.captured_threshold_minor,
  v.threshold_source,v.requires_owner_decision,v.submitted_at,v.submitted_by,
  d.decision,d.decided_at,d.decided_by,d.reason,e.category,e.reason,
  coalesce((SELECT jsonb_agg(jsonb_build_object('id', x->>'id'))
    FROM jsonb_array_elements(e.authorized_photo_snapshot) x),'[]'::jsonb),
  ap.event_kind,ap.occurred_at,r.occurred_at,n.occurred_at,h.current_version_id=v.id
 FROM app.b013_estimate_versions v
 JOIN app.b013_estimate_heads h ON h.org_id=v.org_id AND h.ticket_id=v.ticket_id
 LEFT JOIN app.b013_estimate_decisions d ON d.org_id=v.org_id AND d.ticket_id=v.ticket_id AND d.version_id=v.id
 LEFT JOIN app.b013_repair_emergencies e ON e.org_id=v.org_id AND e.ticket_id=v.ticket_id AND e.version_id=v.id
 LEFT JOIN LATERAL (
  SELECT x.event_kind,x.occurred_at FROM app.b013_repair_appointments x
  WHERE x.org_id=v.org_id AND x.ticket_id=v.ticket_id AND x.version_id=v.id
  ORDER BY x.occurred_at DESC,x.id DESC LIMIT 1
 ) ap ON true
 LEFT JOIN app.b013_repair_event_outbox r ON r.org_id=v.org_id AND r.ticket_id=v.ticket_id
  AND r.version_id=v.id AND r.kind='approval_reminder_24h'
 LEFT JOIN app.b013_repair_event_outbox n ON n.org_id=v.org_id AND n.ticket_id=v.ticket_id
  AND n.version_id=v.id AND n.kind='emergency_owner_notice'
 WHERE v.org_id=p_org AND v.ticket_id=p_ticket
 ORDER BY v.version_no DESC;
END $$;
REVOKE ALL ON FUNCTION app.b013_manager_view(uuid,uuid,text,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b013_manager_view(uuid,uuid,text,uuid,uuid) TO service_role;

CREATE FUNCTION app.b013_appointment_job_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 PERFORM 1 FROM public.repair_vendor_jobs j
 WHERE j.id=NEW.repair_vendor_job_id AND j.org_id=NEW.org_id AND j.ticket_id=NEW.ticket_id
 FOR SHARE;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Appointment job must belong to the same org and ticket' USING ERRCODE='23503';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.b013_appointment_job_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER b013_appointment_job_guard BEFORE INSERT ON app.b013_repair_appointments
 FOR EACH ROW EXECUTE FUNCTION app.b013_appointment_job_guard();
COMMIT;

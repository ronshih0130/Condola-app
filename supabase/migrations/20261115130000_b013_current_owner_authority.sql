-- PR-015 / B-080: B-013 owner readers require current property authority.
-- Reader bodies: 20261105180000; use the org-local date, same as the decision
-- function from 20261107120000 (with lock_timeout from 20261107151000 unchanged).
-- Keep snapshot designation, flags, errors, return shapes,
-- SECURITY DEFINER/search_path and service-only ACLs unchanged.
-- History is also withheld after authority ends, including decided versions.
-- No schema/data/flag change beyond these two reader replacements.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION app.b013_owner_pending(p_org uuid,p_live uuid,p_env text,p_session uuid)
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
  AND EXISTS (
   SELECT 1 FROM public.property_owners po
   JOIN public.contacts c ON c.id=po.owner_contact_id AND c.org_id=po.org_id
   JOIN public.organizations o ON o.id=po.org_id
   WHERE po.org_id=v.org_id AND po.property_id=v.property_id
    AND c.user_id=a.actor AND c.is_owner AND c.archived_at IS NULL
    AND po.effective_from <= (clock_timestamp() AT TIME ZONE o.timezone)::date
    AND (po.effective_to IS NULL OR po.effective_to > (clock_timestamp() AT TIME ZONE o.timezone)::date)
  )
  AND NOT EXISTS (SELECT 1 FROM app.b013_estimate_decisions d
   WHERE d.org_id=v.org_id AND d.ticket_id=v.ticket_id AND d.version_id=v.id)
 ORDER BY v.submitted_at,v.ticket_id;
END $$;
REVOKE ALL ON FUNCTION app.b013_owner_pending(uuid,uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b013_owner_pending(uuid,uuid,text,uuid) TO service_role;

CREATE OR REPLACE FUNCTION app.b013_owner_history(p_org uuid,p_live uuid,p_env text,p_session uuid,p_ticket uuid)
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
  AND EXISTS (
   SELECT 1 FROM public.property_owners po
   JOIN public.contacts c ON c.id=po.owner_contact_id AND c.org_id=po.org_id
   JOIN public.organizations o ON o.id=po.org_id
   WHERE po.org_id=v.org_id AND po.property_id=v.property_id
    AND c.user_id=a.actor AND c.is_owner AND c.archived_at IS NULL
    AND po.effective_from <= (clock_timestamp() AT TIME ZONE o.timezone)::date
    AND (po.effective_to IS NULL OR po.effective_to > (clock_timestamp() AT TIME ZONE o.timezone)::date)
  )
 ORDER BY v.version_no DESC;
END $$;
REVOKE ALL ON FUNCTION app.b013_owner_history(uuid,uuid,text,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b013_owner_history(uuid,uuid,text,uuid,uuid) TO service_role;

COMMIT;

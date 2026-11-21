-- B-070 3b M1 / B1: PR-015 body plus terminal exclusion only. Not add-only.
-- Includes brand_v3 OFF. History and stale decision writes are unchanged.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

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
  AND EXISTS (
   SELECT 1 FROM public.maintenance_tickets t
   WHERE t.org_id=v.org_id AND t.id=v.ticket_id AND t.property_id=v.property_id
    AND t.status NOT IN ('closed','cancelled')
  )
  AND NOT EXISTS (SELECT 1 FROM app.b013_estimate_decisions d
   WHERE d.org_id=v.org_id AND d.ticket_id=v.ticket_id AND d.version_id=v.id)
 ORDER BY v.submitted_at,v.ticket_id;
END $$;
REVOKE ALL ON FUNCTION app.b013_owner_pending(uuid,uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b013_owner_pending(uuid,uuid,text,uuid) TO service_role;

COMMIT;

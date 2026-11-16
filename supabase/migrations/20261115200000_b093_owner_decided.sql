-- B-093 / OWN-35-AC1…AC3 (RO-DECIDED, 更多 › 核准紀錄): the owner's own decided estimates.
-- Two NEW service-only read gateways; no existing object, table grant, policy, flag or data change.
-- Admission is exactly app.b013_owner_history's (20261115130000, PR-015): the selected env/live
-- tuple, app.b013_actor, app.b013_approvals_enabled and the org-local current property-owner
-- predicate, plus the decision's decider is this actor. Pending versions never appear (inner join
-- on a decision). Migration-owned, fixed search_path, every name schema-qualified.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- VOLATILE: b013_actor takes FOR SHARE; never call in READ ONLY. Keyset page, newest first.
CREATE FUNCTION app.b093_owner_decided(p_org uuid,p_live uuid,p_env text,p_session uuid,
 p_after jsonb DEFAULT NULL,p_limit integer DEFAULT 20)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE a record; page_limit integer:=greatest(1,least(50,coalesce(p_limit,20)));
 cursor_at timestamptz; cursor_id uuid; result jsonb;
BEGIN
 IF current_setting('app.active_org_id',true) IS DISTINCT FROM p_org::text
   OR current_setting('app.env',true) IS DISTINCT FROM p_env
   OR NOT EXISTS (
  SELECT 1 FROM public.organizations o
  JOIN public.organizations live ON live.id=p_live AND live.environment='live' AND live.live_org_id IS NULL
  WHERE o.id=p_org AND o.environment::text=p_env AND
   ((p_env='live' AND o.id=p_live AND o.live_org_id IS NULL)
    OR (p_env='sandbox' AND o.live_org_id=p_live))
 ) THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 SELECT * INTO a FROM app.b013_actor(p_org,p_session);
 IF p_after IS NOT NULL THEN
  IF jsonb_typeof(p_after)<>'object' OR NOT p_after ?& ARRAY['decidedAt','versionId']
    OR p_after - ARRAY['decidedAt','versionId'] <> '{}'::jsonb
    OR jsonb_typeof(p_after->'decidedAt') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_after->'versionId') IS DISTINCT FROM 'string' THEN
   RAISE EXCEPTION 'Invalid decided cursor' USING ERRCODE='22023'; END IF;
  BEGIN
   cursor_at:=(p_after->>'decidedAt')::timestamptz; cursor_id:=(p_after->>'versionId')::uuid;
  EXCEPTION WHEN data_exception THEN
   RAISE EXCEPTION 'Invalid decided cursor' USING ERRCODE='22023';
  END;
  IF NOT isfinite(cursor_at) THEN RAISE EXCEPTION 'Invalid decided cursor' USING ERRCODE='22023'; END IF;
 END IF;
 IF NOT app.b013_approvals_enabled(p_org) THEN RETURN jsonb_build_object('rows','[]'::jsonb,'next',NULL); END IF;
 WITH decided AS MATERIALIZED (
  SELECT v.id version_id,v.ticket_id,v.currency,v.minor_unit,v.amount_minor,d.decision,d.decided_at,
   (d.decided_at AT TIME ZONE org.timezone)::date decided_on,pr.name property,t.title item,
   row_number() OVER (ORDER BY d.decided_at DESC,v.id DESC) rn
  FROM app.b013_estimate_versions v
  JOIN app.b013_estimate_decisions d ON d.org_id=v.org_id AND d.ticket_id=v.ticket_id AND d.version_id=v.id
  JOIN public.maintenance_tickets t ON t.org_id=v.org_id AND t.id=v.ticket_id AND t.property_id=v.property_id
  JOIN public.properties pr ON pr.org_id=v.org_id AND pr.id=v.property_id
  JOIN public.organizations org ON org.id=v.org_id
  WHERE v.org_id=p_org AND v.designated_principal_id=a.actor AND d.decided_by=a.actor
   AND EXISTS (
   SELECT 1 FROM public.property_owners po
   JOIN public.contacts c ON c.id=po.owner_contact_id AND c.org_id=po.org_id
   JOIN public.organizations o ON o.id=po.org_id
   WHERE po.org_id=v.org_id AND po.property_id=v.property_id
    AND c.user_id=a.actor AND c.is_owner AND c.archived_at IS NULL
    AND po.effective_from <= (clock_timestamp() AT TIME ZONE o.timezone)::date
    AND (po.effective_to IS NULL OR po.effective_to > (clock_timestamp() AT TIME ZONE o.timezone)::date)
  )
   AND (p_after IS NULL OR (d.decided_at,v.id) < (cursor_at,cursor_id))
  ORDER BY d.decided_at DESC,v.id DESC
  LIMIT page_limit+1
 )
 SELECT jsonb_build_object(
  'rows',coalesce((SELECT jsonb_agg(jsonb_build_object('ticketId',x.ticket_id,'versionId',x.version_id,
     'property',x.property,'item',x.item,'currency',btrim(x.currency::text),'minorUnit',x.minor_unit,
     'amountMinor',x.amount_minor::text,'decision',x.decision,'decidedAt',x.decided_at,
     'decidedOn',x.decided_on::text) ORDER BY x.rn) FROM decided x WHERE x.rn<=page_limit),'[]'::jsonb),
  'next',CASE WHEN EXISTS (SELECT 1 FROM decided x WHERE x.rn>page_limit) THEN
   (SELECT jsonb_build_object('decidedAt',x.decided_at,'versionId',x.version_id) FROM decided x WHERE x.rn=page_limit) END)
 INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.b093_owner_decided(uuid,uuid,text,uuid,jsonb,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.b093_owner_decided(uuid,uuid,text,uuid,jsonb,integer) TO service_role;

-- OWN-35-AC2 read-only view of one ticket: this owner's decided versions (version, scope, reason)
-- and the ticket's current status as the repair's later progress. NULL when nothing is admitted:
-- another owner's, another company's or a missing ticket are indistinguishable (403 in the app).
CREATE FUNCTION app.b093_owner_decided_ticket(p_org uuid,p_live uuid,p_env text,p_session uuid,p_ticket uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE a record; result jsonb;
BEGIN
 IF current_setting('app.active_org_id',true) IS DISTINCT FROM p_org::text
   OR current_setting('app.env',true) IS DISTINCT FROM p_env
   OR NOT EXISTS (
  SELECT 1 FROM public.organizations o
  JOIN public.organizations live ON live.id=p_live AND live.environment='live' AND live.live_org_id IS NULL
  WHERE o.id=p_org AND o.environment::text=p_env AND
   ((p_env='live' AND o.id=p_live AND o.live_org_id IS NULL)
    OR (p_env='sandbox' AND o.live_org_id=p_live))
 ) THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 SELECT * INTO a FROM app.b013_actor(p_org,p_session);
 IF p_ticket IS NULL THEN RAISE EXCEPTION 'Invalid decided ticket' USING ERRCODE='22023'; END IF;
 IF NOT app.b013_approvals_enabled(p_org) THEN RETURN NULL; END IF;
 SELECT jsonb_build_object('ticketId',t.id,'property',pr.name,'item',t.title,'status',t.status::text,
   'versions',jsonb_agg(jsonb_build_object('versionId',v.id,'versionNo',v.version_no::text,
     'currency',btrim(v.currency::text),'minorUnit',v.minor_unit,'amountMinor',v.amount_minor::text,
     'workScope',v.work_scope,'decision',d.decision,'reason',d.reason,'decidedAt',d.decided_at,
     'decidedOn',(d.decided_at AT TIME ZONE org.timezone)::date::text) ORDER BY v.version_no DESC))
 INTO result
 FROM app.b013_estimate_versions v
 JOIN app.b013_estimate_decisions d ON d.org_id=v.org_id AND d.ticket_id=v.ticket_id AND d.version_id=v.id
 JOIN public.maintenance_tickets t ON t.org_id=v.org_id AND t.id=v.ticket_id AND t.property_id=v.property_id
 JOIN public.properties pr ON pr.org_id=v.org_id AND pr.id=v.property_id
 JOIN public.organizations org ON org.id=v.org_id
 WHERE v.org_id=p_org AND v.ticket_id=p_ticket AND v.designated_principal_id=a.actor AND d.decided_by=a.actor
  AND EXISTS (
   SELECT 1 FROM public.property_owners po
   JOIN public.contacts c ON c.id=po.owner_contact_id AND c.org_id=po.org_id
   JOIN public.organizations o ON o.id=po.org_id
   WHERE po.org_id=v.org_id AND po.property_id=v.property_id
    AND c.user_id=a.actor AND c.is_owner AND c.archived_at IS NULL
    AND po.effective_from <= (clock_timestamp() AT TIME ZONE o.timezone)::date
    AND (po.effective_to IS NULL OR po.effective_to > (clock_timestamp() AT TIME ZONE o.timezone)::date)
  )
 GROUP BY t.id,pr.name,t.title,t.status;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.b093_owner_decided_ticket(uuid,uuid,text,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.b093_owner_decided_ticket(uuid,uuid,text,uuid,uuid) TO service_role;
COMMIT;

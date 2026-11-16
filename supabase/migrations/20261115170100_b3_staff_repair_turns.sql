-- B-070 3b / PLT-52/53, MGT-125/126. No stored turns, raw grants or business writes.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- VOLATILE: b013_actor takes FOR SHARE; never call in READ ONLY.
CREATE FUNCTION app.b3_staff_repair_turns(p_org uuid,p_live uuid,p_env text,p_user uuid,p_session uuid,
 p_ticket uuid DEFAULT NULL,p_group text DEFAULT NULL,p_after jsonb DEFAULT NULL,p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE actor record; authority jsonb; approvals boolean; dispatch boolean; enhanced boolean;
 selected_org uuid:=p_org; selected_ticket uuid:=p_ticket; result jsonb; page_limit integer:=greatest(1,least(50,coalesce(p_limit,50)));
 cursor_id uuid; cursor_since timestamptz;
BEGIN
 IF current_setting('app.active_org_id',true) IS DISTINCT FROM p_org::text
   OR current_setting('app.env',true) IS DISTINCT FROM p_env
   OR NOT EXISTS(SELECT 1 FROM public.organizations o
     JOIN public.organizations live ON live.id=p_live AND live.environment='live' AND live.live_org_id IS NULL
     WHERE o.id=p_org AND o.environment::text=p_env AND
       ((p_env='live' AND o.id=p_live AND o.live_org_id IS NULL) OR (p_env='sandbox' AND o.live_org_id=p_live)))
 THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 SELECT * INTO actor FROM app.b013_actor(p_org,p_session);
 authority:=public.b017_resolve(p_live,p_user,p_session);
 IF actor.actor IS DISTINCT FROM p_user OR actor.member_role IS NULL OR actor.member_role NOT IN ('admin','manager','maintenance')
   OR coalesce(authority->>'nativeRole','') NOT IN ('admin','manager','maintenance')
   OR NOT coalesce(authority->'keys' ? 'tickets.update',false)
   OR app.b056_member_paused(p_org,p_user) OR app.b056_member_paused(p_live,p_user)
 THEN RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 IF p_group IS NOT NULL AND p_group NOT IN ('mine','others') THEN
   RAISE EXCEPTION 'Invalid turn page' USING ERRCODE='22023'; END IF;
 IF p_after IS NOT NULL THEN
   IF p_group IS NULL OR jsonb_typeof(p_after)<>'object' OR NOT p_after ?& ARRAY['since','ticketId']
     OR p_after - ARRAY['since','ticketId'] <> '{}'::jsonb
     OR jsonb_typeof(p_after->'ticketId') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_after->'since') NOT IN ('string','null') THEN
     RAISE EXCEPTION 'Invalid turn cursor' USING ERRCODE='22023'; END IF;
   cursor_id:=(p_after->>'ticketId')::uuid; cursor_since:=(p_after->>'since')::timestamptz;
   IF cursor_id IS NULL OR (cursor_since IS NOT NULL AND NOT isfinite(cursor_since)) THEN
     RAISE EXCEPTION 'Invalid turn cursor' USING ERRCODE='22023'; END IF;
 END IF;
 -- The maintenance branch exits BEFORE any private helper/estimate/event/flag read.
 -- Public facts do not prove C: no guessed holder, rule, exact marker or task count.
 IF actor.member_role='maintenance' OR authority->>'nativeRole'='maintenance' THEN
   SELECT jsonb_build_object('state','ready','projection','maintenance','counts','[]'::jsonb,
     'yourTurn',0,'mine','[]'::jsonb,'others','[]'::jsonb,'next',jsonb_build_object('mine',NULL,'others',NULL),
     'detail',(SELECT jsonb_build_object('ticketId',t.id,'status',t.status::text,'holder',NULL,'step',NULL,
       'viewerCanAct',false,'since',NULL,'sinceExact',false)
       FROM public.maintenance_tickets t WHERE t.org_id=p_org AND t.id=p_ticket)) INTO result;
   RETURN result;
 END IF;
 -- Both selected-org and native live ceilings must admit b013_manager_view's data.
 IF actor.member_role NOT IN ('admin','manager') OR authority->>'nativeRole' NOT IN ('admin','manager') THEN
   RAISE EXCEPTION 'errors.forbidden' USING ERRCODE='42501'; END IF;
 approvals:=app.b013_approvals_enabled(p_org); dispatch:=coalesce(app.vendor_dispatch_enabled(p_org),false);
 SELECT coalesce((SELECT f.value->'enabled'='true'::jsonb
   AND jsonb_typeof(f.value->'allowed_org_ids')='array'
   AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)
   AND o.feature_flags->>'vendor_link'='true'
   FROM public.organizations o CROSS JOIN public.platform_settings f
   WHERE o.id=selected_org AND f.key='vendor_link'),false) INTO enhanced;

 WITH facts AS MATERIALIZED (
 SELECT t.id,t.status::text status,t.created_at,t.resolved_at,pr.timezone,
   pr.name || coalesce(' '||u.label,'') || coalesce(' '||r.label,'') place,
   pr.archived_at IS NULL AND (u.id IS NULL OR u.archived_at IS NULL)
     AND (r.id IS NULL OR r.archived_at IS NULL) ancestry_open,
   j.id job_id,j.created_at job_created,j.reported_at,j.confirmed_at,j.reported_cost_minor,
   j.id IS NOT NULL AND j.reported_at IS NOT NULL AND j.confirmed_at IS NULL pending_cost,
   j.sharing_approved_at,
   coalesce(j.active AND j.revoked_at IS NULL AND j.expires_at>clock_timestamp()
     AND t.status::text IN ('open','triaged','assigned','in_progress','on_hold','resolved')
     AND (NOT enhanced OR (j.scope='case_collaboration' AND j.sharing_approved_at IS NOT NULL
       AND j.vendor_contact_id=t.assigned_vendor_contact_id)),false) capability,
   coalesce(reprice.ready,false) reestimate_ready,
   v.id version_id,coalesce(v.requires_owner_decision,false) requires_owner,
   v.submitted_at,d.decision,d.decided_at,e.authorized_at,
   retained_work.ticket_id IS NOT NULL retained,
   -- b013_dispatch_allowed: the joined version must be the current head;
   -- an emergency overrides any decision, including rejection. Org flags are
   -- read once above in the caller's repeatable-read snapshot, not per ticket.
   coalesce(approvals AND dispatch AND v.id IS NOT NULL AND
     (NOT v.requires_owner_decision OR d.decision='approved' OR e.id IS NOT NULL),false) allowed,
   coalesce(ev.event_kind,'none') event,
   ev.occurred_at event_at,
   greatest(t.created_at,sc.changed_at,hj.revoked_at) fallback_at,
   EXISTS(SELECT 1 FROM public.expenses x WHERE x.org_id=t.org_id AND x.ticket_id=t.id AND x.status<>'void') expense_conflict
 FROM public.maintenance_tickets t
 JOIN public.properties pr ON pr.org_id=t.org_id AND pr.id=t.property_id
 LEFT JOIN public.units u ON u.org_id=t.org_id AND u.id=t.unit_id
 LEFT JOIN public.rooms r ON r.org_id=t.org_id AND r.id=t.room_id
 LEFT JOIN public.repair_vendor_jobs j ON j.org_id=t.org_id AND j.ticket_id=t.id AND j.active AND j.revoked_at IS NULL
 LEFT JOIN (
   SELECT DISTINCT b.org_id,b.ticket_id FROM app.b026_vendor_estimates b
   WHERE b.org_id=selected_org AND (selected_ticket IS NULL OR b.ticket_id=selected_ticket)
 ) retained_work ON retained_work.org_id=t.org_id AND retained_work.ticket_id=t.id
 -- Mirror submit_estimate's first current owner and threshold/scale availability.
 -- This is a boolean action prerequisite; no owner identity or policy data enters the DTO.
 LEFT JOIN LATERAL (
   SELECT (CASE WHEN own.repair_approval_threshold_minor IS NOT NULL THEN own.repair_approval_threshold_minor
     WHEN rev.mode='set' THEN rev.threshold_minor ELSE region.threshold_minor END) IS NOT NULL
     AND (CASE WHEN own.repair_approval_threshold_minor IS NULL AND rev.mode='set' THEN rev.minor_unit
       ELSE coalesce(region.minor_unit,rev.minor_unit) END) IS NOT NULL
     AND (region.minor_unit IS NULL OR region.minor_unit=
       CASE WHEN own.repair_approval_threshold_minor IS NULL AND rev.mode='set' THEN rev.minor_unit
         ELSE coalesce(region.minor_unit,rev.minor_unit) END) ready
   FROM (
     SELECT po.repair_approval_threshold_minor,c.user_id principal_id,o.country_code
     FROM public.property_owners po JOIN public.contacts c ON c.org_id=po.org_id AND c.id=po.owner_contact_id
     JOIN public.organizations o ON o.id=po.org_id
     WHERE approvals AND po.org_id=t.org_id AND po.property_id=t.property_id AND c.is_owner
       AND c.user_id IS NOT NULL AND c.archived_at IS NULL
       AND po.effective_from <= (clock_timestamp() AT TIME ZONE o.timezone)::date
       AND (po.effective_to IS NULL OR po.effective_to > (clock_timestamp() AT TIME ZONE o.timezone)::date)
     ORDER BY po.id LIMIT 1
   ) own
   LEFT JOIN app.b013_regional_defaults region ON region.country_code=own.country_code::text AND region.currency=pr.currency
   LEFT JOIN app.b013_default_roots root ON root.org_id=t.org_id AND root.principal_id=own.principal_id AND root.currency=pr.currency
   LEFT JOIN app.b013_default_revisions rev ON rev.org_id=root.org_id AND rev.root_id=root.id AND rev.id=root.current_revision AND rev.revision_no=root.version
 ) reprice ON true
 -- Inline b104_current_repair_version; the composite head key preserves one
 -- row per ticket, including tickets with no estimate or approvals disabled.
 LEFT JOIN app.b013_estimate_heads head ON approvals AND head.org_id=t.org_id AND head.ticket_id=t.id
 LEFT JOIN app.b013_estimate_versions v ON approvals AND v.org_id=t.org_id AND v.ticket_id=t.id AND v.id=head.current_version_id
 LEFT JOIN app.b013_estimate_decisions d ON approvals AND d.org_id=t.org_id AND d.ticket_id=t.id AND d.version_id=v.id
 LEFT JOIN app.b013_repair_emergencies e ON approvals AND e.org_id=t.org_id AND e.ticket_id=t.id AND e.version_id=v.id
 LEFT JOIN LATERAL (
   -- Inline b104_vendor_latest_event and read its timestamp from the same row.
   SELECT a.event_kind::text event_kind,a.occurred_at FROM app.b013_repair_appointments a
   WHERE approvals AND dispatch AND a.org_id=t.org_id AND a.ticket_id=t.id AND a.repair_vendor_job_id=j.id AND a.version_id=v.id
   ORDER BY a.occurred_at DESC,a.id DESC LIMIT 1
 ) ev ON true
 LEFT JOIN LATERAL (SELECT max(c.created_at) changed_at FROM public.ticket_comments c
   WHERE c.org_id=t.org_id AND c.ticket_id=t.id AND c.status_to IS NOT NULL) sc ON true
 LEFT JOIN LATERAL (SELECT max(h.revoked_at) revoked_at FROM public.repair_vendor_jobs h
   WHERE h.org_id=t.org_id AND h.ticket_id=t.id) hj ON true
 WHERE t.org_id=selected_org AND (selected_ticket IS NULL OR t.id=selected_ticket)
 ), predicates AS MATERIALIZED (
 SELECT *,job_id IS NOT NULL AND confirmed_at IS NULL unfinished,
   approvals AND authorized_at IS NOT NULL emergency,
   NOT retained OR allowed closure_guard,
   CASE WHEN approvals THEN allowed ELSE dispatch AND NOT retained END authorized
 FROM facts
 ), rules AS MATERIALIZED (
 SELECT *,CASE
   WHEN status IN ('closed','cancelled') THEN 'R1'
   WHEN pending_cost AND dispatch AND closure_guard THEN 'R2'
   WHEN approvals AND requires_owner AND decision IS NULL AND NOT emergency THEN 'R3'
   WHEN approvals AND decision IN ('rejected','more_information') AND NOT emergency THEN 'R5'
   WHEN job_id IS NOT NULL AND dispatch AND authorized AND closure_guard AND event='vendor_rejected' THEN 'R6'
   WHEN job_id IS NOT NULL AND dispatch AND capability AND authorized AND closure_guard AND unfinished
     AND reported_at IS NULL AND event='vendor_completion_submitted' THEN 'R7a'
   WHEN job_id IS NOT NULL AND dispatch AND capability AND authorized AND closure_guard AND unfinished
     AND reported_at IS NULL THEN 'R7b'
   WHEN pending_cost OR (unfinished AND NOT (dispatch AND capability AND authorized AND closure_guard))
     OR (emergency AND job_id IS NULL) THEN 'R8-blocked'
   WHEN status='resolved' THEN 'R4'
   ELSE 'R8' END rule
 FROM predicates
 ), mapped AS MATERIALIZED (
 SELECT *,CASE WHEN rule IN ('R1','R4') THEN 'none' WHEN rule='R3' THEN 'owner'
   WHEN rule IN ('R7a','R7b') THEN 'vendor' ELSE 'manager' END holder,
 CASE rule WHEN 'R1' THEN 'done' WHEN 'R4' THEN 'done' WHEN 'R2' THEN 'confirm_cost'
   WHEN 'R3' THEN 'approve_estimate' WHEN 'R5' THEN 're_estimate' WHEN 'R6' THEN 'dispatch'
   WHEN 'R7a' THEN 'report_cost' WHEN 'R7b' THEN 'do_repair'
   WHEN 'R8-blocked' THEN CASE WHEN dispatch AND (job_id IS NULL OR NOT capability OR event='vendor_rejected')
     THEN 'dispatch' ELSE 'in_progress' END
   ELSE CASE WHEN status IN ('open','triaged') THEN 'dispatch' ELSE 'in_progress' END END step,
 CASE rule WHEN 'R1' THEN NULL::timestamptz WHEN 'R4' THEN resolved_at
   WHEN 'R2' THEN reported_at WHEN 'R3' THEN submitted_at WHEN 'R5' THEN decided_at
   WHEN 'R6' THEN event_at WHEN 'R7a' THEN event_at
   WHEN 'R7b' THEN greatest(job_created,CASE WHEN enhanced THEN sharing_approved_at END,
     least(authorized_at,CASE WHEN decision='approved' THEN decided_at END,
       CASE WHEN NOT requires_owner THEN submitted_at END))
   ELSE fallback_at END since
 FROM rules
 )
, eligible AS MATERIALIZED (
 SELECT *,CASE
   WHEN rule='R2' THEN coalesce(authority->'keys' ? 'exp.add',false) AND closure_guard AND dispatch
     AND NOT expense_conflict AND reported_cost_minor>0 AND reported_cost_minor<=1000000000
   WHEN rule='R5' THEN approvals AND ancestry_open AND reestimate_ready
   WHEN rule IN ('R6','R8','R8-blocked') THEN ancestry_open AND status<>'resolved'
     AND NOT (pending_cost AND NOT closure_guard)
     -- Existing dispatch/revoke can repair a handoff before approval; the vendor
     -- still cannot work. Existing status coordination can set triaged/on_hold.
     -- Neither is offered for resolved work or a guard-denied cost report.
     AND CASE WHEN step='dispatch' THEN dispatch AND NOT pending_cost AND confirmed_at IS NULL
       ELSE true END
   ELSE false END can_act
 FROM mapped
 ), matters AS MATERIALIZED (
 SELECT *,CASE WHEN holder='manager' AND can_act THEN 'mine' ELSE 'others' END grp,
   jsonb_build_object('ticketId',id,'rule',rule,'holder',holder,'step',step,'viewerCanAct',can_act,
     'since',since,'sinceExact',false,'timezone',timezone,'place',place) dto
 FROM eligible
 -- No durable flag/reopen history proves uninterrupted entry. Event time is useful,
 -- but exact day markers remain conservatively suppressed; never invent a clock.
 ), ranked AS (
 SELECT *,row_number() OVER(PARTITION BY grp ORDER BY since ASC NULLS LAST,id) rn FROM matters
 WHERE holder<>'none' AND (p_group IS NULL OR grp=p_group)
   AND (p_after IS NULL OR (cursor_since IS NULL AND since IS NULL AND id>cursor_id)
     OR (cursor_since IS NOT NULL AND (since>cursor_since OR since IS NULL OR (since=cursor_since AND id>cursor_id))))
 )
 SELECT jsonb_build_object('state','ready','counts',coalesce((SELECT jsonb_agg(c ORDER BY holder,step,"canAct") FROM
     (SELECT holder,step,can_act AS "canAct",count(*)::integer count FROM matters WHERE holder<>'none' GROUP BY holder,step,can_act) c),'[]'::jsonb),
   'yourTurn',(SELECT count(*) FROM matters WHERE holder='manager' AND can_act),
   'mine',coalesce((SELECT jsonb_agg(dto ORDER BY rn) FROM ranked WHERE grp='mine' AND rn<=page_limit),'[]'::jsonb),
   'others',coalesce((SELECT jsonb_agg(dto ORDER BY rn) FROM ranked WHERE grp='others' AND rn<=page_limit),'[]'::jsonb),
   'next',jsonb_build_object(
     'mine',CASE WHEN EXISTS(SELECT 1 FROM ranked WHERE grp='mine' AND rn>page_limit) THEN
       (SELECT jsonb_build_object('since',since,'ticketId',id) FROM ranked WHERE grp='mine' AND rn=page_limit) END,
     'others',CASE WHEN EXISTS(SELECT 1 FROM ranked WHERE grp='others' AND rn>page_limit) THEN
       (SELECT jsonb_build_object('since',since,'ticketId',id) FROM ranked WHERE grp='others' AND rn=page_limit) END),
   'detail',(SELECT dto FROM matters WHERE id=p_ticket)) INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.b3_staff_repair_turns(uuid,uuid,text,uuid,uuid,uuid,text,jsonb,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.b3_staff_repair_turns(uuid,uuid,text,uuid,uuid,uuid,text,jsonb,integer) TO service_role;
COMMIT;

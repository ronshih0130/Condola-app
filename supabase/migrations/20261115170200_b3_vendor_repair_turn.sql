-- B-070 3b / PLT-52/53, MGT-125/126. No stored turns, raw grants or business writes.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- VOLATILE: ticket/job admission locks and volatile approval helpers.
CREATE FUNCTION app.b3_vendor_repair_turn(p_token_hash text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE opened record; job public.repair_vendor_jobs; ticket public.maintenance_tickets;
 selected_org uuid; selected_ticket uuid; approvals boolean; dispatch boolean; enhanced boolean; result jsonb;
BEGIN
 SELECT * INTO opened FROM app.open_vendor_job(p_token_hash);
 IF NOT FOUND THEN RETURN NULL; END IF;
 selected_org:=opened.org_id; selected_ticket:=opened.ticket_id;
 SELECT coalesce((SELECT f.value->'enabled'='true'::jsonb
   AND jsonb_typeof(f.value->'allowed_org_ids')='array'
   AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)
   AND o.feature_flags->>'vendor_link'='true'
   FROM public.organizations o CROSS JOIN public.platform_settings f
   WHERE o.id=selected_org AND f.key='vendor_link'),false) INTO enhanced;
 SELECT t.* INTO ticket FROM public.maintenance_tickets t
   WHERE t.org_id=selected_org AND t.id=selected_ticket FOR UPDATE;
 PERFORM j.id FROM public.repair_vendor_jobs j WHERE j.org_id=selected_org AND j.ticket_id=selected_ticket ORDER BY j.id FOR UPDATE;
 SELECT j.* INTO job FROM public.repair_vendor_jobs j
   WHERE j.id=opened.job_id AND j.org_id=selected_org AND j.ticket_id=selected_ticket AND j.token_hash=p_token_hash;
 IF job.id IS NULL OR NOT job.active OR job.revoked_at IS NOT NULL OR job.expires_at<=clock_timestamp()
   OR NOT coalesce(app.vendor_dispatch_enabled(selected_org),false)
   OR (enhanced AND (job.scope<>'case_collaboration' OR job.sharing_approved_at IS NULL
     OR job.vendor_contact_id IS NULL OR job.vendor_contact_id IS DISTINCT FROM ticket.assigned_vendor_contact_id))
 THEN RETURN NULL; END IF;
 -- Terminal views never consult approval/event state.
 IF ticket.status::text IN ('closed','cancelled') THEN
   RETURN jsonb_build_object('state','ready','holder','none','step','done','viewerCanAct',false,
     'dispatchAllowed',false,'currentEvent','none'); END IF;
 approvals:=app.b013_approvals_enabled(selected_org); dispatch:=true;

 WITH facts AS MATERIALIZED (
 SELECT t.id,t.status::text status,t.created_at,t.resolved_at,pr.timezone,
   pr.name || coalesce(' '||u.label,'') || coalesce(' '||r.label,'') place,
   pr.archived_at IS NULL AND (u.id IS NULL OR u.archived_at IS NULL)
     AND (r.id IS NULL OR r.archived_at IS NULL) ancestry_open,
   j.id job_id,j.created_at job_created,j.reported_at,j.confirmed_at,j.reported_cost_minor,
   j.sharing_approved_at,
   coalesce(j.active AND j.revoked_at IS NULL AND j.expires_at>clock_timestamp()
     AND t.status::text IN ('open','triaged','assigned','in_progress','on_hold','resolved')
     AND (NOT enhanced OR (j.scope='case_collaboration' AND j.sharing_approved_at IS NOT NULL
       AND j.vendor_contact_id=t.assigned_vendor_contact_id)),false) capability,
   v.id version_id,coalesce(v.requires_owner_decision,false) requires_owner,
   v.submitted_at,d.decision,d.decided_at,e.authorized_at,
   EXISTS(SELECT 1 FROM app.b026_vendor_estimates b WHERE b.org_id=t.org_id AND b.ticket_id=t.id) retained,
   CASE WHEN approvals AND dispatch AND v.id IS NOT NULL
     THEN coalesce(app.b013_dispatch_allowed(t.org_id,v.id),false) ELSE false END allowed,
   CASE WHEN approvals AND dispatch AND j.id IS NOT NULL AND v.id IS NOT NULL
     THEN coalesce(app.b104_vendor_latest_event(t.org_id,t.id,j.id,v.id),'none') ELSE 'none' END event,
   NULL::timestamptz event_at,
   greatest(t.created_at,sc.changed_at,hj.revoked_at) fallback_at,
   EXISTS(SELECT 1 FROM public.expenses x WHERE x.org_id=t.org_id AND x.ticket_id=t.id AND x.status<>'void') expense_conflict
 FROM public.maintenance_tickets t
 JOIN public.properties pr ON pr.org_id=t.org_id AND pr.id=t.property_id
 LEFT JOIN public.units u ON u.org_id=t.org_id AND u.id=t.unit_id
 LEFT JOIN public.rooms r ON r.org_id=t.org_id AND r.id=t.room_id
 LEFT JOIN public.repair_vendor_jobs j ON j.org_id=t.org_id AND j.ticket_id=t.id AND j.active AND j.revoked_at IS NULL
 LEFT JOIN LATERAL (SELECT app.b104_current_repair_version(t.org_id,t.id) id WHERE approvals) head ON true
 LEFT JOIN app.b013_estimate_versions v ON approvals AND v.org_id=t.org_id AND v.ticket_id=t.id AND v.id=head.id
 LEFT JOIN app.b013_estimate_decisions d ON approvals AND d.org_id=t.org_id AND d.ticket_id=t.id AND d.version_id=v.id
 LEFT JOIN app.b013_repair_emergencies e ON approvals AND e.org_id=t.org_id AND e.ticket_id=t.id AND e.version_id=v.id
 LEFT JOIN LATERAL (SELECT max(c.created_at) changed_at FROM public.ticket_comments c
   WHERE c.org_id=t.org_id AND c.ticket_id=t.id AND c.status_to IS NOT NULL) sc ON true
 LEFT JOIN LATERAL (SELECT max(h.revoked_at) revoked_at FROM public.repair_vendor_jobs h
   WHERE h.org_id=t.org_id AND h.ticket_id=t.id) hj ON true
 WHERE t.org_id=selected_org AND (selected_ticket IS NULL OR t.id=selected_ticket)
 ), predicates AS MATERIALIZED (
 SELECT *,job_id IS NOT NULL AND reported_at IS NOT NULL AND confirmed_at IS NULL pending_cost,
   job_id IS NOT NULL AND confirmed_at IS NULL unfinished,
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

 SELECT CASE WHEN rule IN ('R2','R6','R7a','R7b','R4','R1') THEN
   jsonb_build_object('state','ready','holder',holder,'step',step,
     'viewerCanAct',rule IN ('R7a','R7b'),'dispatchAllowed',authorized AND closure_guard,'currentEvent',event)
 ELSE jsonb_build_object('state','restricted','holder',NULL,'step',NULL,'viewerCanAct',false,
   'dispatchAllowed',false,'currentEvent','none') END INTO result FROM mapped;
 -- Final wall-clock recheck: transaction now() alone is insufficient after lock waits.
 IF job.expires_at<=clock_timestamp() OR NOT EXISTS(SELECT 1 FROM app.open_vendor_job(p_token_hash) j WHERE j.job_id=job.id)
   OR NOT EXISTS(SELECT 1 FROM public.repair_vendor_jobs j JOIN public.maintenance_tickets t ON t.org_id=j.org_id AND t.id=j.ticket_id
     WHERE j.org_id=selected_org AND j.id=job.id AND j.token_hash=p_token_hash AND j.active AND j.revoked_at IS NULL
       AND j.expires_at>clock_timestamp() AND (NOT enhanced OR (j.scope='case_collaboration' AND j.sharing_approved_at IS NOT NULL
         AND j.vendor_contact_id=t.assigned_vendor_contact_id))) THEN RETURN NULL; END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.b3_vendor_repair_turn(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION app.b3_vendor_repair_turn(text) TO service_role;
COMMIT;

-- B-026 slice 4 / BLK-MAC-13 (build-only; VENDOR_LINK_ENABLED and org vendor_link stay OFF).
-- Sibling of app.b028_center_vendor used only when the in-process vendor-link
-- kill switch is ON. One gateway call replaces the B-028 call (same round trips):
--  * org vendor_link not enhanced, or the ticket still reportable: delegate to
--    app.b028_center_vendor unchanged (read_only = false);
--  * enhanced org + closed/cancelled ticket: marks are rejected and reads are
--    write-free (no expired-cursor cleanup, no cursor creation, no read rows).
-- Lock order is inherited from app.b028_center_vendor_context:
-- platform_settings SHARE NOWAIT -> organization -> ticket -> job (all NOWAIT).
CREATE FUNCTION app.b026_center_vendor(p_hash text,p_mark uuid DEFAULT NULL,p_cursor uuid DEFAULT NULL)
RETURNS TABLE(recipient_id uuid,kind text,occurred_at timestamptz,read_at timestamptz,continuation uuid,read_only boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE ctx record; r record; v_enhanced boolean; v_status text; v_count integer:=0; v_after_time timestamptz; v_after_id uuid;
BEGIN
 SELECT * INTO ctx FROM app.b028_center_vendor_context(p_hash);
 IF ctx.job_id IS NULL THEN RETURN; END IF;
 SELECT coalesce(o.feature_flags->>'vendor_link','false')='true' INTO v_enhanced
   FROM public.organizations o WHERE o.id=ctx.org_id;
 SELECT t.status::text INTO v_status FROM public.maintenance_tickets t WHERE t.id=ctx.ticket_id AND t.org_id=ctx.org_id;
 IF v_enhanced IS NOT TRUE OR v_status IN ('open','triaged','assigned','in_progress','on_hold','resolved') THEN
  RETURN QUERY SELECT b.recipient_id,b.kind,b.occurred_at,b.read_at,b.continuation,false
    FROM app.b028_center_vendor(p_hash,p_mark,p_cursor) b;
  RETURN;
 END IF;
 -- Closed enhanced job: read-only.
 IF p_mark IS NOT NULL THEN RAISE EXCEPTION 'Notification unavailable' USING ERRCODE='42501'; END IF;
 IF p_cursor IS NOT NULL THEN
  SELECT cur.after_time,cur.after_id INTO v_after_time,v_after_id FROM app.b028_center_cursors cur
   WHERE cur.id=p_cursor AND cur.org_id=ctx.org_id AND cur.job_id=ctx.job_id AND cur.expires_at>clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'Notification unavailable' USING ERRCODE='42501'; END IF;
 END IF;
 FOR r IN SELECT ent.id AS rid,e.kind AS ekind,e.occurred_at AS happened,rd.read_at AS seen
   FROM app.b028_center_recipients ent
   JOIN app.b028_center_events e ON e.id=ent.event_id AND e.org_id=ent.org_id
   LEFT JOIN app.b028_center_reads rd ON rd.org_id=ent.org_id AND rd.recipient_id=ent.id
  WHERE ent.org_id=ctx.org_id AND ent.persona='vendor_job' AND ent.job_id=ctx.job_id AND ent.ticket_id=ctx.ticket_id
    AND e.job_id=ctx.job_id AND e.ticket_id=ctx.ticket_id AND e.kind='vendor_job_assigned'
    AND (v_after_time IS NULL OR (e.occurred_at,ent.id)>(v_after_time,v_after_id))
  ORDER BY e.occurred_at,ent.id LIMIT 100
 LOOP
  recipient_id:=r.rid;kind:=r.ekind;occurred_at:=r.happened;read_at:=r.seen;continuation:=NULL;read_only:=true;RETURN NEXT;
  v_count:=v_count+1;
 END LOOP;
 -- A closed job never mints a continuation cursor (write-free); at most one page is shown.
 IF NOT EXISTS(SELECT 1 FROM public.repair_vendor_jobs j WHERE j.id=ctx.job_id AND j.org_id=ctx.org_id AND j.active AND j.revoked_at IS NULL AND j.expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'Notification unavailable' USING ERRCODE='42501'; END IF;
 IF v_count=0 THEN
  recipient_id:=NULL;kind:=NULL;occurred_at:=NULL;read_at:=NULL;continuation:=NULL;read_only:=true;RETURN NEXT;
 END IF;
END $$;
REVOKE ALL ON FUNCTION app.b026_center_vendor(text,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b026_center_vendor(text,uuid,uuid) TO service_role;

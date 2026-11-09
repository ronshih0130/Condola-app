-- B010 co-tenant payer gap: close the missing payer check on the b010_event_id
-- branch of app.b028_center_recipient_valid before any b010 payment_* producer
-- or notification_events_v2 goes ON. Forward-only CREATE OR REPLACE from the
-- live post-S3 body (20261031100217 body + 20261107150000 bounded locks). Only
-- the b010_event_id branch changes: for kind payment_% + persona 'tenant' it now
-- requires that the payer (public.payments.payer_contact_id, joined via
-- b010_source_events.payment_id) equals NEW.contact_id and that payer contact's
-- user_id equals NEW.principal_user_id, mirroring the neutral_source contract.
-- Non-tenant personas on the b010 path (staff) are unchanged; neutral_source,
-- rent_*, vendor_job and the lock helpers are untouched.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

CREATE OR REPLACE FUNCTION app.b028_center_recipient_valid()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app'
AS $function$
DECLARE e app.b028_center_events; v_lease uuid; v_property uuid; v_ticket uuid;
BEGIN
 SELECT * INTO e FROM app.b028_center_events WHERE id=NEW.event_id AND org_id=NEW.org_id FOR SHARE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Invalid recipient' USING ERRCODE='23514'; END IF;
 IF (e.b010_event_id IS NOT NULL OR e.neutral_source_id IS NOT NULL) AND NEW.principal_user_id IS NOT NULL THEN
  PERFORM 1 FROM auth.users u WHERE u.id=NEW.principal_user_id FOR KEY SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invalid recipient' USING ERRCODE='23514'; END IF;
 END IF;
 IF e.b010_event_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.b017_old_source_transactions t
   WHERE t.org_id=e.org_id AND t.source_id=e.b010_event_id AND t.tx_id=txid_current()) THEN
  RAISE EXCEPTION 'Historical recipient unavailable' USING ERRCODE='23514';
 END IF;
 IF e.neutral_source_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app.b017_occurrences n
   WHERE n.org_id=e.org_id AND n.id=e.neutral_source_id AND n.created_tx_id=txid_current()) THEN
  RAISE EXCEPTION 'Historical recipient unavailable' USING ERRCODE='23514';
 END IF;
 IF e.b010_event_id IS NOT NULL THEN
  SELECT b.lease_id INTO v_lease FROM app.b010_source_events b WHERE b.id=e.b010_event_id AND b.org_id=e.org_id;
  IF e.kind LIKE 'payment_%' AND NEW.persona='tenant' AND NOT EXISTS (SELECT 1 FROM app.b010_source_events b
    JOIN public.payments p ON p.id=b.payment_id AND p.org_id=b.org_id
    JOIN public.contacts pc ON pc.id=p.payer_contact_id AND pc.org_id=p.org_id
    WHERE b.id=e.b010_event_id AND b.org_id=e.org_id AND p.payer_contact_id=NEW.contact_id AND pc.user_id=NEW.principal_user_id) THEN
   RAISE EXCEPTION 'Invalid recipient' USING ERRCODE='23514';
  END IF;
 ELSIF e.neutral_source_id IS NOT NULL THEN
  SELECT n.lease_id INTO v_lease FROM app.b017_occurrences n WHERE n.id=e.neutral_source_id AND n.org_id=e.org_id FOR SHARE NOWAIT;
  IF e.kind LIKE 'payment_%' AND NEW.persona<>'tenant' THEN
   RAISE EXCEPTION 'Invalid recipient' USING ERRCODE='23514';
  END IF;
  IF e.kind LIKE 'payment_%' AND NEW.persona='tenant' AND NOT EXISTS (SELECT 1 FROM app.b017_occurrences n WHERE n.id=e.neutral_source_id AND n.org_id=e.org_id AND n.payer_contact_id=NEW.contact_id AND n.payer_principal_user_id=NEW.principal_user_id) THEN
   RAISE EXCEPTION 'Invalid recipient' USING ERRCODE='23514';
  END IF;
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
  IF v_ticket IS NOT NULL THEN PERFORM app.lock_tables_nowait_retry(ARRAY['public.contacts']::regclass[], 'SHARE'); END IF;
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
END $function$;

REVOKE ALL ON FUNCTION app.b028_center_recipient_valid() FROM PUBLIC, anon, authenticated, service_role;

COMMIT;

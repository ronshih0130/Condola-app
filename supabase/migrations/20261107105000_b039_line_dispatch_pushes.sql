-- B-039: vendor dispatch LINE push events. Additive; captured transport only; default OFF.
-- Down: DROP FUNCTION app.b039_dispatch_close_stale(uuid,uuid), app.b039_dispatch_no_channel(uuid,uuid),
--  app.b039_dispatch_replay(app.b039_dispatch_events,text), app.b039_dispatch_backoff(uuid,uuid),
--  app.b039_dispatch_finish(uuid,uuid,text,text), app.b039_dispatch_event_record(uuid,uuid,uuid,text),
--  app.b039_dispatch_push_enabled(uuid); DROP TABLE app.b039_dispatch_events;
--  ALTER TABLE public.notifications DROP CONSTRAINT notifications_b039_vendor_dispatch_ck;
--  DELETE FROM public.platform_settings WHERE key='line_dispatch_push';
BEGIN;
SET LOCAL lock_timeout='2s';
INSERT INTO public.platform_settings(key,value) VALUES
 ('line_dispatch_push','{"enabled":false,"allowed_org_ids":[]}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Vendor dispatch events never carry tenant-lease context. Tenant-lease constraints are unchanged.
ALTER TABLE public.notifications ADD CONSTRAINT notifications_b039_vendor_dispatch_ck CHECK (
 event_type NOT IN ('dispatch_assigned','dispatch_rescheduled','dispatch_cancelled')
 OR (lease_id IS NULL AND recipient_contact_id IS NOT NULL
     AND related_table='repair_vendor_jobs' AND related_id IS NOT NULL)) NOT VALID;
ALTER TABLE public.notifications VALIDATE CONSTRAINT notifications_b039_vendor_dispatch_ck;

CREATE TABLE app.b039_dispatch_events (
 notification_id uuid PRIMARY KEY,
 org_id uuid NOT NULL REFERENCES public.organizations(id),
 ticket_id uuid NOT NULL,
 job_id uuid NOT NULL,
 vendor_contact_id uuid NOT NULL,
 kind text NOT NULL CHECK (kind IN ('assigned','rescheduled','cancelled')),
 -- The earlier announcement this event follows: a reschedule or cancellation is only sent once that
 -- announcement was delivered (sent, or its Email fallback); it waits while pending.
 depends_on uuid REFERENCES app.b039_dispatch_events(notification_id),
 attempts int NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 1000),
 next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 claim_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','fallback','superseded','uncertain')),
 reason text CHECK (reason IS NULL OR reason ~ '^[a-z_]{1,64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 completed_at timestamptz,
 CHECK ((status='pending') = (completed_at IS NULL)),
 CHECK ((kind='assigned') = (depends_on IS NULL)),
 FOREIGN KEY (org_id,notification_id) REFERENCES public.notifications(org_id,id),
 FOREIGN KEY (org_id,job_id) REFERENCES public.repair_vendor_jobs(org_id,id),
 FOREIGN KEY (org_id,vendor_contact_id) REFERENCES public.contacts(org_id,id)
);
CREATE UNIQUE INDEX b039_dispatch_events_offer_uniq ON app.b039_dispatch_events(job_id) WHERE kind IN ('assigned','rescheduled');
CREATE UNIQUE INDEX b039_dispatch_events_cancel_uniq ON app.b039_dispatch_events(job_id) WHERE kind='cancelled';
CREATE INDEX b039_dispatch_events_pending_idx ON app.b039_dispatch_events(org_id,next_attempt_at,created_at) WHERE status='pending';
ALTER TABLE app.b039_dispatch_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b039_dispatch_events FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON app.b039_dispatch_events TO service_role;

-- Strict stack: LINE platform + push + B-028 delivery (b033_push_enabled) + vendor portal + line_dispatch_push.
CREATE FUNCTION app.b039_dispatch_push_enabled(p_org uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET lock_timeout='2s' AS $$
BEGIN
 IF nullif(current_setting('app.active_org_id',true),'') IS NOT NULL
    AND current_setting('app.active_org_id',true) IS DISTINCT FROM p_org::text THEN RETURN false; END IF;
 IF app.b033_push_enabled(p_org) IS NOT TRUE OR app.b033_portal_enabled(p_org,'vendor') IS NOT TRUE THEN RETURN false; END IF;
 RETURN (EXISTS(SELECT 1 FROM public.organizations o JOIN public.platform_settings f ON f.key='line_dispatch_push'
  WHERE o.id=p_org AND (o.feature_flags->'line_dispatch_push'='true'::jsonb) IS TRUE
   AND (f.value->'enabled'='true'::jsonb) IS TRUE
   AND (jsonb_typeof(f.value->'allowed_org_ids')='array') IS TRUE
   AND (f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) IS TRUE)) IS TRUE;
END $$;

-- Called inside the committed business transaction (sharing approval / revoke). Never sends anything.
-- Returns the new notification id, or NULL when OFF, out of scope, stale or already recorded.
CREATE FUNCTION app.b039_dispatch_event_record(p_org uuid,p_ticket uuid,p_job uuid,p_change text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET lock_timeout='2s' AS $$
DECLARE j record; prev record; v_kind text; v_depends uuid; v_notification uuid;
BEGIN
 IF p_org IS NULL OR p_ticket IS NULL OR p_job IS NULL OR p_change NOT IN ('shared','revoked') THEN RETURN NULL; END IF;
 IF app.b039_dispatch_push_enabled(p_org) IS NOT TRUE THEN RETURN NULL; END IF;
 SELECT rj.id,rj.vendor_contact_id,rj.active,rj.revoked_at,rj.expires_at,rj.scope,rj.sharing_approved_at,rj.created_at,
        t.assigned_vendor_contact_id,coalesce(c.locale,'zh-TW') AS locale
   INTO j FROM public.repair_vendor_jobs rj
   JOIN public.maintenance_tickets t ON t.id=rj.ticket_id AND t.org_id=rj.org_id
   JOIN public.contacts c ON c.id=rj.vendor_contact_id AND c.org_id=rj.org_id AND c.is_vendor AND c.archived_at IS NULL
  WHERE rj.id=p_job AND rj.org_id=p_org AND rj.ticket_id=p_ticket;
 IF NOT FOUND OR j.vendor_contact_id IS NULL OR j.vendor_contact_id IS DISTINCT FROM j.assigned_vendor_contact_id THEN RETURN NULL; END IF;
 IF p_change='shared' THEN
  IF NOT j.active OR j.revoked_at IS NOT NULL OR j.expires_at<=clock_timestamp() OR j.scope<>'case_collaboration'
     OR j.sharing_approved_at IS NULL THEN RETURN NULL; END IF;
  IF EXISTS(SELECT 1 FROM app.b039_dispatch_events e WHERE e.job_id=p_job AND e.kind IN ('assigned','rescheduled')) THEN RETURN NULL; END IF;
  SELECT rj.id,rj.vendor_contact_id INTO prev FROM public.repair_vendor_jobs rj
   WHERE rj.org_id=p_org AND rj.ticket_id=p_ticket AND rj.id<>p_job AND rj.created_at<=j.created_at
   ORDER BY rj.created_at DESC,rj.id DESC LIMIT 1;
  -- A reschedule follows the same vendor's previous announcement unless that one was never deliverable.
  IF prev.id IS NOT NULL AND prev.vendor_contact_id=j.vendor_contact_id THEN
   SELECT e.notification_id INTO v_depends FROM app.b039_dispatch_events e
    WHERE e.job_id=prev.id AND e.kind IN ('assigned','rescheduled') AND e.status IN ('pending','sent','fallback','uncertain');
  END IF;
  v_kind:=CASE WHEN v_depends IS NOT NULL THEN 'rescheduled' ELSE 'assigned' END;
 ELSE
  -- Only a vendor who was told about this job, and who is still the assignee, hears that it was cancelled.
  IF j.revoked_at IS NULL OR j.active THEN RETURN NULL; END IF;
  SELECT e.notification_id INTO v_depends FROM app.b039_dispatch_events e
   WHERE e.job_id=p_job AND e.kind IN ('assigned','rescheduled') AND e.status IN ('pending','sent','fallback','uncertain');
  IF v_depends IS NULL THEN RETURN NULL; END IF;
  v_kind:='cancelled';
 END IF;
 INSERT INTO public.notifications(org_id,event_type,template_key,recipient_contact_id,locale,related_table,related_id,dedupe_key)
 VALUES(p_org,'dispatch_'||v_kind,'line_dispatch_'||v_kind,j.vendor_contact_id,
   CASE WHEN j.locale='en' THEN 'en' ELSE 'zh-TW' END,'repair_vendor_jobs',p_job,'b039:'||v_kind||':'||p_job::text)
 ON CONFLICT (org_id,dedupe_key) DO NOTHING RETURNING id INTO v_notification;
 IF v_notification IS NULL THEN RETURN NULL; END IF;
 INSERT INTO app.b039_dispatch_events(notification_id,org_id,ticket_id,job_id,vendor_contact_id,kind,depends_on)
 VALUES(v_notification,p_org,p_ticket,p_job,j.vendor_contact_id,v_kind,v_depends) ON CONFLICT DO NOTHING;
 IF NOT FOUND THEN RAISE EXCEPTION 'Duplicate dispatch event' USING ERRCODE='23505'; END IF;
 RETURN v_notification;
END $$;

-- Terminal outcome of one pending event; the claim must match (no retargeting).
CREATE FUNCTION app.b039_dispatch_finish(p_notification uuid,p_claim uuid,p_status text,p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET lock_timeout='2s' AS $$
DECLARE e app.b039_dispatch_events%ROWTYPE;
BEGIN
 IF p_status NOT IN ('sent','fallback','superseded') OR (p_reason IS NOT NULL AND p_reason !~ '^[a-z_]{1,64}$') THEN
  RAISE EXCEPTION 'Invalid dispatch outcome' USING ERRCODE='22023';
 END IF;
 UPDATE app.b039_dispatch_events SET status=p_status,reason=p_reason,completed_at=clock_timestamp()
  WHERE notification_id=p_notification AND claim_id=p_claim AND status='pending'
    AND (nullif(current_setting('app.active_org_id',true),'') IS NULL OR org_id::text=current_setting('app.active_org_id',true))
  RETURNING * INTO e;
 IF NOT FOUND THEN RETURN false; END IF;
 UPDATE public.notifications SET status=(CASE WHEN p_status='superseded' THEN 'cancelled' ELSE 'succeeded' END)::public.job_status
  WHERE id=e.notification_id AND org_id=e.org_id;
 RETURN true;
END $$;

-- A row whose processing failed is retried later with bounded exponential backoff; it never blocks the queue.
CREATE FUNCTION app.b039_dispatch_backoff(p_notification uuid,p_claim uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET lock_timeout='2s' AS $$
BEGIN
 UPDATE app.b039_dispatch_events SET attempts=least(attempts+1,1000),
   next_attempt_at=clock_timestamp()+make_interval(secs=>least(300,power(2,least(attempts+1,9)))::double precision)
  WHERE notification_id=p_notification AND claim_id=p_claim AND status='pending'
    AND (nullif(current_setting('app.active_org_id',true),'') IS NULL OR org_id::text=current_setting('app.active_org_id',true));
 RETURN FOUND;
END $$;

-- Shared replay classifier for a pending event's claim (internal; called only by the two gateways below, which
-- already hold the event row lock). It never queues Email itself.
--   B-033 terminal fallback row        => 'fallback' (its reason)            event closed
--   settled (LINE accepted)            => 'sent'                              event closed
--   expired, B-033 expiry Email queued for an unattempted claim => 'fallback' (Email delivered)  event closed
--   expired otherwise (B-033 expiry always records has_unknown) => 'uncertain' (no new Email)    event closed
--   reserved/dispatching/unknown open  => p_open='close': closed as expired WITHOUT Email, 'uncertain'
--                                         p_open='wait' : 'wait' (B-033 expiry owns the single Email; no writes)
--   dispatching within 15 s ownership  => 'busy' (no writes)
--   never started (no row, released without fallback, reserved with no attempt) => NULL (reservation released)
CREATE FUNCTION app.b039_dispatch_replay(p_event app.b039_dispatch_events,p_open text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET lock_timeout='2s' AS $$
DECLARE r app.b033_push_reservations%ROWTYPE; f app.b033_push_fallbacks%ROWTYPE; v_reason text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(p_event.claim_id::text,33));
 SELECT * INTO f FROM app.b033_push_fallbacks WHERE claim_id=p_event.claim_id;
 IF FOUND THEN
  v_reason:=CASE WHEN f.reason ~ '^[a-z_]{1,64}$' THEN f.reason ELSE 'line_fallback' END;
  UPDATE app.b039_dispatch_events SET status='fallback',reason=v_reason,completed_at=clock_timestamp() WHERE notification_id=p_event.notification_id;
  UPDATE public.notifications SET status='succeeded' WHERE id=p_event.notification_id AND org_id=p_event.org_id;
  RETURN 'fallback';
 END IF;
 SELECT * INTO r FROM app.b033_push_reservations WHERE claim_id=p_event.claim_id FOR UPDATE;
 IF NOT FOUND OR r.status='released' THEN RETURN NULL; END IF;
 IF r.status='settled' THEN
  UPDATE app.b039_dispatch_events SET status='sent',reason='replayed_settled',completed_at=clock_timestamp() WHERE notification_id=p_event.notification_id;
  UPDATE public.notifications SET status='succeeded' WHERE id=p_event.notification_id AND org_id=p_event.org_id;
  RETURN 'sent';
 END IF;
 IF r.status='expired' AND r.attempt_count=0 AND r.fallback_claim_id IS NOT NULL THEN
  UPDATE app.b039_dispatch_events SET status='fallback',reason='line_unknown_possible_duplicate',completed_at=clock_timestamp() WHERE notification_id=p_event.notification_id;
  UPDATE public.notifications SET status='succeeded' WHERE id=p_event.notification_id AND org_id=p_event.org_id;
  RETURN 'fallback';
 END IF;
 IF r.status='expired' THEN
  UPDATE app.b039_dispatch_events SET status='uncertain',reason='expired_after_unknown',completed_at=clock_timestamp() WHERE notification_id=p_event.notification_id;
  UPDATE public.notifications SET status='cancelled' WHERE id=p_event.notification_id AND org_id=p_event.org_id;
  RETURN 'uncertain';
 END IF;
 IF r.status='dispatching' AND r.started_at>clock_timestamp()-interval '15 seconds' THEN RETURN 'busy'; END IF;
 IF r.status='reserved' AND r.attempt_count=0 AND NOT r.has_unknown THEN
  UPDATE app.b033_org_push_budgets SET reserved=reserved-1
   WHERE line_channel_id=r.line_channel_id AND org_id=r.org_id AND period_month=r.period_month;
  UPDATE public.line_push_usage SET reserved_count=reserved_count-1,updated_at=now()
   WHERE line_channel_id=r.line_channel_id AND period_month=r.period_month;
  UPDATE app.b033_push_reservations SET status='released',completed_at=now(),owner_token=NULL WHERE claim_id=p_event.claim_id;
  RETURN NULL;
 END IF;
 IF p_open='wait' THEN RETURN 'wait'; END IF;
 UPDATE app.b033_push_reservations SET status='expired',has_unknown=true,owner_token=NULL,completed_at=now() WHERE claim_id=p_event.claim_id;
 UPDATE public.deliveries SET status='failed',error='line_unknown_suppressed'
  WHERE b033_claim_id=p_event.claim_id AND channel='line' AND status='queued';
 UPDATE app.b039_dispatch_events SET status='uncertain',reason='stale_after_unknown',completed_at=clock_timestamp() WHERE notification_id=p_event.notification_id;
 UPDATE public.notifications SET status='cancelled' WHERE id=p_event.notification_id AND org_id=p_event.org_id;
 RETURN 'uncertain';
END $$;

-- Enabled but LINE is unavailable for this claim: no selected OA, or the claim's B-033 reservation/fallback rows
-- belong to a different OA than the one now selected (B-033 would reject the claim scope). The caller re-authorized
-- the event in this transaction. Replay first: an attempt that
-- settled, fell back, or may have reached LINE is never followed by another Email. Only a never-started claim
-- queues exactly one deduplicated Email with reason line_unavailable (no LINE row: no channel exists).
CREATE FUNCTION app.b039_dispatch_no_channel(p_notification uuid,p_claim uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET lock_timeout='2s' AS $$
DECLARE e app.b039_dispatch_events%ROWTYPE; v_email uuid; v_state text;
BEGIN
 SELECT * INTO e FROM app.b039_dispatch_events WHERE notification_id=p_notification AND claim_id=p_claim AND status='pending'
  AND (nullif(current_setting('app.active_org_id',true),'') IS NULL OR org_id::text=current_setting('app.active_org_id',true)) FOR UPDATE;
 IF NOT FOUND OR app.b039_dispatch_push_enabled(e.org_id) IS NOT TRUE THEN RETURN NULL; END IF;
 IF app.b033_selected_channel(e.org_id) IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM app.b033_push_reservations r WHERE r.claim_id=p_claim AND r.line_channel_id IS DISTINCT FROM app.b033_selected_channel(e.org_id)
   UNION ALL SELECT 1 FROM app.b033_push_fallbacks f WHERE f.claim_id=p_claim AND f.line_channel_id IS DISTINCT FROM app.b033_selected_channel(e.org_id))
 THEN RETURN NULL; END IF;
 v_state:=app.b039_dispatch_replay(e,'wait');
 IF v_state IS NOT NULL THEN RETURN v_state; END IF;
 v_email:=app.b028_delivery_enqueue(e.org_id,'line_notification',e.notification_id,'contact:'||e.vendor_contact_id::text,'email');
 INSERT INTO public.deliveries(org_id,notification_id,recipient_contact_id,channel,provider,status,error,counts_toward_quota,b033_claim_id)
 VALUES(e.org_id,e.notification_id,e.vendor_contact_id,'email','b028_email','queued','line_unavailable',false,v_email)
 ON CONFLICT(b033_claim_id,channel) WHERE b033_claim_id IS NOT NULL DO NOTHING;
 UPDATE app.b039_dispatch_events SET status='fallback',reason='line_unavailable',completed_at=clock_timestamp() WHERE notification_id=e.notification_id;
 UPDATE public.notifications SET status='succeeded' WHERE id=e.notification_id AND org_id=e.org_id;
 RETURN 'fallback';
END $$;

-- Authority went stale before this event was delivered. Replay first (settled => sent, fallback row => fallback,
-- expired after an attempt => uncertain, open uncertain reservation => closed as expired WITHOUT Email and
-- 'uncertain', quota kept counted). 'uncertain' counts as announced: a following cancel/reschedule still goes out.
-- Only a claim that never started is superseded.
CREATE FUNCTION app.b039_dispatch_close_stale(p_notification uuid,p_claim uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET lock_timeout='2s' AS $$
DECLARE e app.b039_dispatch_events%ROWTYPE; v_state text;
BEGIN
 SELECT * INTO e FROM app.b039_dispatch_events WHERE notification_id=p_notification AND claim_id=p_claim AND status='pending'
  AND (nullif(current_setting('app.active_org_id',true),'') IS NULL OR org_id::text=current_setting('app.active_org_id',true)) FOR UPDATE;
 IF NOT FOUND OR app.b039_dispatch_push_enabled(e.org_id) IS NOT TRUE THEN RETURN NULL; END IF;
 v_state:=app.b039_dispatch_replay(e,'close');
 IF v_state IS NOT NULL THEN RETURN v_state; END IF;
 UPDATE app.b039_dispatch_events SET status='superseded',reason='stale_authority',completed_at=clock_timestamp()
  WHERE notification_id=e.notification_id;
 UPDATE public.notifications SET status='cancelled' WHERE id=e.notification_id AND org_id=e.org_id;
 RETURN 'superseded';
END $$;
-- The classifier has no EXECUTE grant: it is reachable only through the gateways above.
REVOKE ALL ON FUNCTION app.b039_dispatch_replay(app.b039_dispatch_events,text) FROM PUBLIC,anon,authenticated,service_role;

REVOKE ALL ON FUNCTION app.b039_dispatch_push_enabled(uuid),app.b039_dispatch_event_record(uuid,uuid,uuid,text),
 app.b039_dispatch_finish(uuid,uuid,text,text),app.b039_dispatch_backoff(uuid,uuid),app.b039_dispatch_no_channel(uuid,uuid),
 app.b039_dispatch_close_stale(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b039_dispatch_push_enabled(uuid),app.b039_dispatch_event_record(uuid,uuid,uuid,text),
 app.b039_dispatch_finish(uuid,uuid,text,text),app.b039_dispatch_backoff(uuid,uuid),app.b039_dispatch_no_channel(uuid,uuid),
 app.b039_dispatch_close_stale(uuid,uuid) TO service_role;
COMMIT;

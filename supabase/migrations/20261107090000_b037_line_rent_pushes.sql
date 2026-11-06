-- B-037: LINE rent and payment-result pushes. Local captured transport only; default OFF.
-- Additive: private claim + evaluated-event tables, one disabled flag seed and service-only gateways.
-- No change to B-010 producers, B-028 Email claims or legacy email_log reminders. One B-033 function
-- (b033_push_expire) is replaced with an identical body plus the B-037 single-Email/suppression rules.
BEGIN;
SET LOCAL lock_timeout='2s';
INSERT INTO public.platform_settings(key,value)
VALUES ('line_rent_push','{"enabled":false,"allowed_org_ids":[]}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- One claim per (event, message version, recipient, reminder offset). claim_id is the stable
-- B-033 claim and therefore the X-Line-Retry-Key for every retry of this occurrence.
CREATE TABLE app.b037_rent_push_claims (
 claim_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL REFERENCES public.organizations(id),
 event_id uuid NOT NULL,
 kind text NOT NULL CHECK (kind IN ('rent_due','rent_overdue','payment_confirmed','payment_rejected')),
 version smallint NOT NULL CHECK (version=1),
 recipient_contact_id uuid NOT NULL,
 reminder_offset int NOT NULL CHECK (reminder_offset BETWEEN -366 AND 366),
 lease_id uuid NOT NULL,
 notification_id uuid NOT NULL,
 state text NOT NULL DEFAULT 'claimed' CHECK (state IN ('claimed','suppressed','sent','fallback')),
 reason text CHECK (reason IS NULL OR reason ~ '^[a-z_]{1,64}$'),
 -- Which single Email serves a fallback: the existing B-010 recipient claim, or a B-028 LINE fallback.
 email_owner text CHECK (email_owner IS NULL OR email_owner IN ('b010_claim','line_fallback')),
 email_claim_id uuid,
 -- Last dispatch attempt; open claims rotate least-recently-attempted first (no starvation).
 attempted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (org_id,event_id,version,recipient_contact_id,reminder_offset),
 UNIQUE (org_id,notification_id),
 FOREIGN KEY (org_id,event_id) REFERENCES app.b010_source_events(org_id,id),
 FOREIGN KEY (org_id,recipient_contact_id) REFERENCES public.contacts(org_id,id),
 FOREIGN KEY (org_id,lease_id) REFERENCES public.leases(org_id,id),
 FOREIGN KEY (org_id,notification_id) REFERENCES public.notifications(org_id,id),
 CHECK ((state IN ('suppressed','fallback')) = (reason IS NOT NULL)),
 CHECK ((email_owner IS NULL) = (email_claim_id IS NULL))
);
CREATE INDEX b037_claims_pending ON app.b037_rent_push_claims(org_id,created_at) WHERE state='claimed';
ALTER TABLE app.b037_rent_push_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b037_rent_push_claims FROM PUBLIC,anon,authenticated,service_role;

-- Evaluated-event marker: an event that produced no claim (ineligible / no recipient) is
-- recorded once so discovery pages past it instead of re-locking it every run.
CREATE TABLE app.b037_event_marks (
 org_id uuid NOT NULL REFERENCES public.organizations(id),
 event_id uuid NOT NULL,
 reason text NOT NULL CHECK (reason ~ '^[a-z_]{1,64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (org_id,event_id),
 FOREIGN KEY (org_id,event_id) REFERENCES app.b010_source_events(org_id,id)
);
ALTER TABLE app.b037_event_marks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b037_event_marks FROM PUBLIC,anon,authenticated,service_role;

-- Every layer is strict: env is checked in TypeScript; here line_platform, line_push, B-028
-- notification_delivery_v2 (via b033_push_enabled) and line_rent_push platform + org.
CREATE FUNCTION app.b037_enabled(p_org uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET lock_timeout='2s' AS $$
BEGIN
 IF p_org IS NULL OR app.b033_push_enabled(p_org) IS NOT TRUE THEN RETURN false; END IF;
 RETURN (EXISTS(SELECT 1 FROM public.organizations o JOIN public.platform_settings f ON f.key='line_rent_push'
  WHERE o.id=p_org AND o.environment='live'
   AND (o.feature_flags->'line_rent_push'='true'::jsonb) IS TRUE
   AND (f.value->'enabled'='true'::jsonb) IS TRUE
   AND (jsonb_typeof(f.value->'allowed_org_ids')='array') IS TRUE
   AND (f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) IS TRUE)) IS TRUE;
END $$;

-- Reminder eligibility. Called under the caller's lease/invoice/payment locks.
CREATE FUNCTION app.b037_event_reason(p_org uuid,p_event uuid,p_instant timestamptz) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET lock_timeout='2s' AS $$
DECLARE e app.b010_source_events%ROWTYPE; v_tz text; v_env text; v_due date; v_offset int;
BEGIN
 SELECT * INTO e FROM app.b010_source_events s WHERE s.id=p_event AND s.org_id=p_org;
 IF NOT FOUND OR e.kind NOT IN ('rent_due','rent_overdue','payment_confirmed','payment_rejected') THEN RETURN 'unsupported'; END IF;
 SELECT o.timezone,o.environment::text INTO v_tz,v_env FROM public.organizations o WHERE o.id=p_org;
 IF v_env IS DISTINCT FROM 'live' OR NOT EXISTS(SELECT 1 FROM public.organizations o
   JOIN public.platform_settings f ON f.key=CASE WHEN e.kind LIKE 'rent_%' THEN 'rent_reminders_v2' ELSE 'payment_results_v2' END
   WHERE o.id=p_org AND (o.feature_flags->f.key='true'::jsonb) IS TRUE AND (f.value->'enabled'='true'::jsonb) IS TRUE
    AND (jsonb_typeof(f.value->'allowed_org_ids')='array') IS TRUE
    AND (f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) IS TRUE) THEN
  RETURN 'source_disabled';
 END IF;
 IF e.kind IN ('payment_confirmed','payment_rejected') THEN
  -- Results follow the committed payment status; this never changes a payment decision.
  IF NOT EXISTS(SELECT 1 FROM public.payments p WHERE p.id=e.payment_id AND p.org_id=p_org AND p.lease_id=e.lease_id
    AND p.status::text=CASE e.kind WHEN 'payment_confirmed' THEN 'confirmed' ELSE 'rejected' END) THEN
   RETURN 'payment_changed';
  END IF;
  RETURN 'eligible';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.leases l WHERE l.id=e.lease_id AND l.org_id=p_org AND l.status='active' AND l.terminated_on IS NULL) THEN
  RETURN 'terminated';
 END IF;
 SELECT i.due_date INTO v_due FROM public.invoices i WHERE i.id=e.invoice_id AND i.org_id=p_org AND i.lease_id=e.lease_id
  AND i.status IN ('open','partially_paid') AND i.balance_minor>0
  AND EXISTS(SELECT 1 FROM public.invoice_lines il WHERE il.org_id=i.org_id AND il.invoice_id=i.id AND il.charge_type='rent' AND il.amount_minor>0);
 IF v_due IS NULL THEN RETURN 'paid'; END IF;
 IF v_tz IS NULL OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name=v_tz) THEN RETURN 'timezone'; END IF;
 IF p_instant IS NULL OR (p_instant AT TIME ZONE v_tz)::date IS DISTINCT FROM e.local_date THEN RETURN 'stale_day'; END IF;
 v_offset:=e.local_date-v_due;
 IF e.occurrence_key IS DISTINCT FROM v_due::text||':'||v_offset::text
   OR (e.kind='rent_due' AND v_offset>0) OR (e.kind='rent_overdue' AND v_offset NOT IN (1,7)) THEN
  RETURN 'stale_day';
 END IF;
 -- Legacy reminders own an occurrence they already claimed in email_log (BLK-MAC-11 fence).
 IF EXISTS(SELECT 1 FROM public.email_log x WHERE x.org_id=p_org AND x.target_id=e.invoice_id AND x.threshold=v_offset
   AND x.kind IN ('rent_overdue_admin','rent_overdue_tenant')) THEN
  RETURN 'legacy_owner';
 END IF;
 RETURN 'eligible';
END $$;

-- Recipient still has the lease and the B-010 tenant rule for this kind.
CREATE FUNCTION app.b037_recipient_reason(p_org uuid,p_event uuid,p_contact uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET lock_timeout='2s' AS $$
DECLARE e app.b010_source_events%ROWTYPE; v_offset int; v_payer uuid;
BEGIN
 SELECT * INTO e FROM app.b010_source_events s WHERE s.id=p_event AND s.org_id=p_org;
 IF NOT FOUND THEN RETURN 'recipient_lease'; END IF;
 IF e.invoice_id IS NOT NULL THEN
  SELECT e.local_date-i.due_date INTO v_offset FROM public.invoices i WHERE i.id=e.invoice_id AND i.org_id=p_org;
 END IF;
 IF e.payment_id IS NOT NULL THEN
  SELECT p.payer_contact_id INTO v_payer FROM public.payments p WHERE p.id=e.payment_id AND p.org_id=p_org;
 END IF;
 IF EXISTS(SELECT 1 FROM public.lease_parties lp JOIN public.contacts ct ON ct.id=lp.contact_id AND ct.org_id=lp.org_id
   JOIN public.organizations o ON o.id=ct.org_id
   WHERE lp.org_id=p_org AND lp.lease_id=e.lease_id AND lp.role IN ('primary','co_tenant') AND ct.id=p_contact
    AND ct.archived_at IS NULL AND ct.is_tenant
    AND (e.kind<>'rent_due' OR ct.user_id IS NULL OR NOT EXISTS(SELECT 1 FROM app.b010_tenant_due_preferences pref
      WHERE pref.org_id=ct.org_id AND pref.user_id=ct.user_id AND pref.due_enabled=false))
    AND (e.kind<>'rent_overdue' OR (v_offset=1 AND coalesce(o.settings->>'email_tenant_rent_overdue','true')<>'false'))
    AND (e.kind NOT IN ('payment_confirmed','payment_rejected') OR v_payer IS NULL OR v_payer=ct.id)) THEN
  RETURN 'eligible';
 END IF;
 RETURN 'recipient_lease';
END $$;

-- Read-only discovery of committed source events for fully enabled organizations.
CREATE FUNCTION app.b037_pending(p_instant timestamptz,p_limit int DEFAULT 200) RETURNS TABLE(org_id uuid,event_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT e.org_id,e.id FROM app.b010_source_events e JOIN public.organizations o ON o.id=e.org_id
 WHERE p_instant IS NOT NULL AND p_limit BETWEEN 1 AND 200 AND o.environment='live'
  AND e.kind IN ('rent_due','rent_overdue','payment_confirmed','payment_rejected')
  AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['line_platform','line_push','notification_delivery_v2','line_rent_push']) k(key)
   WHERE NOT EXISTS(SELECT 1 FROM public.platform_settings f WHERE f.key=k.key
    AND (o.feature_flags->k.key='true'::jsonb) IS TRUE AND (f.value->'enabled'='true'::jsonb) IS TRUE
    AND (jsonb_typeof(f.value->'allowed_org_ids')='array') IS TRUE
    AND (f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) IS TRUE))
  AND CASE WHEN e.kind IN ('rent_due','rent_overdue') THEN
    EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name=o.timezone)
    AND e.local_date=(p_instant AT TIME ZONE (SELECT z.name FROM pg_catalog.pg_timezone_names z WHERE z.name=o.timezone))::date
   -- Bounded look-back: claims/marks are the cursor, so a missed run is caught up for 7 days.
   ELSE e.created_at>p_instant-interval '7 days' AND e.created_at<=p_instant+interval '1 day' END
  AND NOT EXISTS(SELECT 1 FROM app.b037_rent_push_claims c WHERE c.org_id=e.org_id AND c.event_id=e.id)
  AND NOT EXISTS(SELECT 1 FROM app.b037_event_marks m WHERE m.org_id=e.org_id AND m.event_id=e.id)
 ORDER BY e.created_at,e.org_id,e.id LIMIT p_limit
$$;

-- Read-only list of open claims (first dispatch or same-key retry) for fully enabled organizations.
CREATE FUNCTION app.b037_open(p_instant timestamptz,p_limit int DEFAULT 200) RETURNS TABLE(org_id uuid,claim_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT c.org_id,c.claim_id FROM app.b037_rent_push_claims c JOIN public.organizations o ON o.id=c.org_id
 WHERE p_instant IS NOT NULL AND p_limit BETWEEN 1 AND 200 AND c.state='claimed' AND o.environment='live'
  AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['line_platform','line_push','notification_delivery_v2','line_rent_push']) k(key)
   WHERE NOT EXISTS(SELECT 1 FROM public.platform_settings f WHERE f.key=k.key
    AND (o.feature_flags->k.key='true'::jsonb) IS TRUE AND (f.value->'enabled'='true'::jsonb) IS TRUE
    AND (jsonb_typeof(f.value->'allowed_org_ids')='array') IS TRUE
    AND (f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) IS TRUE))
 ORDER BY c.attempted_at NULLS FIRST,c.created_at,c.org_id,c.claim_id LIMIT p_limit
$$;

-- Business transaction after the source event committed: notification + claim rows together.
CREATE FUNCTION app.b037_claim(p_org uuid,p_event uuid,p_instant timestamptz)
RETURNS TABLE(claim_id uuid,notification_id uuid,recipient_contact_id uuid,state text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET lock_timeout='2s' AS $$
DECLARE e app.b010_source_events%ROWTYPE; v_offset int:=0; v_reason text;
BEGIN
 IF p_org IS NULL OR p_event IS NULL OR p_instant IS NULL THEN RAISE EXCEPTION 'Invalid claim' USING ERRCODE='22023'; END IF;
 IF app.b037_enabled(p_org) IS NOT TRUE THEN RETURN; END IF;
 SELECT * INTO e FROM app.b010_source_events s WHERE s.id=p_event AND s.org_id=p_org
  AND s.kind IN ('rent_due','rent_overdue','payment_confirmed','payment_rejected');
 IF NOT FOUND THEN RETURN; END IF;
 -- Committed events only: the producing transaction itself cannot claim.
 IF EXISTS(SELECT 1 FROM app.b010_source_events s WHERE s.id=p_event
   AND s.xmin=pg_catalog.xid(pg_catalog.pg_current_xact_id_if_assigned())) THEN
  RAISE EXCEPTION 'Source event not committed' USING ERRCODE='55000';
 END IF;
 -- Same order as B-010: lease, then invoice FOR UPDATE (serializes with legacy email_log claims).
 PERFORM 1 FROM public.leases l WHERE l.id=e.lease_id AND l.org_id=p_org FOR SHARE;
 IF e.invoice_id IS NOT NULL THEN PERFORM 1 FROM public.invoices i WHERE i.id=e.invoice_id AND i.org_id=p_org FOR UPDATE; END IF;
 IF e.payment_id IS NOT NULL THEN PERFORM 1 FROM public.payments p WHERE p.id=e.payment_id AND p.org_id=p_org FOR SHARE; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('b037:'||p_event::text,37));
 v_reason:=app.b037_event_reason(p_org,p_event,p_instant);
 IF v_reason='eligible' THEN
  IF e.invoice_id IS NOT NULL THEN
   SELECT e.local_date-i.due_date INTO v_offset FROM public.invoices i WHERE i.id=e.invoice_id AND i.org_id=p_org;
  END IF;
  INSERT INTO public.notifications(org_id,event_type,template_key,recipient_user_id,recipient_contact_id,lease_id,locale,
    payload,related_table,related_id,scheduled_for,dedupe_key)
  SELECT p_org,e.kind,'line.'||e.kind||'.v1',r.user_id,r.id,e.lease_id,CASE WHEN r.locale='en' THEN 'en' ELSE 'zh-TW' END,
    jsonb_build_object('source','b037','version',1,'offset',v_offset),
    CASE WHEN e.invoice_id IS NULL THEN 'payments' ELSE 'invoices' END,coalesce(e.invoice_id,e.payment_id),clock_timestamp(),
    'b037:'||p_event::text||':v1:'||r.id::text||':'||v_offset::text
  FROM (SELECT DISTINCT ct.id,ct.user_id,ct.locale FROM public.lease_parties lp
    JOIN public.contacts ct ON ct.id=lp.contact_id AND ct.org_id=lp.org_id
    WHERE lp.org_id=p_org AND lp.lease_id=e.lease_id AND lp.role IN ('primary','co_tenant')) r
  WHERE app.b037_recipient_reason(p_org,p_event,r.id)='eligible'
  ON CONFLICT (org_id,dedupe_key) DO NOTHING;
  INSERT INTO app.b037_rent_push_claims(org_id,event_id,kind,version,recipient_contact_id,reminder_offset,lease_id,notification_id)
  SELECT p_org,p_event,e.kind,1,n.recipient_contact_id,v_offset,e.lease_id,n.id FROM public.notifications n
  WHERE n.org_id=p_org AND n.dedupe_key='b037:'||p_event::text||':v1:'||n.recipient_contact_id::text||':'||v_offset::text
  ON CONFLICT DO NOTHING;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM app.b037_rent_push_claims c WHERE c.org_id=p_org AND c.event_id=p_event) THEN
  INSERT INTO app.b037_event_marks(org_id,event_id,reason)
  VALUES(p_org,p_event,CASE WHEN v_reason='eligible' THEN 'no_recipient' ELSE v_reason END) ON CONFLICT DO NOTHING;
 END IF;
 RETURN QUERY SELECT c.claim_id,c.notification_id,c.recipient_contact_id,c.state FROM app.b037_rent_push_claims c
  WHERE c.org_id=p_org AND c.event_id=p_event ORDER BY c.recipient_contact_id;
END $$;

-- Resolves a claimed row from B-033 durable records (settled reservation, terminal fallback or
-- expiry). Shared by prepare and mark so a crash between them never loses the real outcome.
-- Caller holds the claim row lock. Returns NULL when nothing terminal exists yet.
CREATE FUNCTION app.b037_resolve(p_claim uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET lock_timeout='2s' AS $$
DECLARE c app.b037_rent_push_claims%ROWTYPE; v_reason text;
BEGIN
 SELECT * INTO c FROM app.b037_rent_push_claims x WHERE x.claim_id=p_claim;
 IF NOT FOUND OR c.state<>'claimed' THEN RETURN NULL; END IF;
 IF EXISTS(SELECT 1 FROM app.b033_push_reservations r WHERE r.claim_id=p_claim AND r.org_id=c.org_id
   AND r.notification_id=c.notification_id AND r.status='settled') THEN
  UPDATE app.b037_rent_push_claims x SET state='sent',updated_at=clock_timestamp() WHERE x.claim_id=p_claim;
  RETURN 'sent';
 END IF;
 SELECT f.reason INTO v_reason FROM app.b033_push_fallbacks f WHERE f.claim_id=p_claim AND f.org_id=c.org_id AND f.notification_id=c.notification_id;
 IF v_reason IS NULL THEN
  SELECT 'line_unknown_possible_duplicate' INTO v_reason FROM app.b033_push_reservations r
   WHERE r.claim_id=p_claim AND r.org_id=c.org_id AND r.notification_id=c.notification_id AND r.status='expired' AND r.fallback_claim_id IS NOT NULL;
 END IF;
 IF v_reason IS NULL THEN RETURN NULL; END IF;
 UPDATE app.b037_rent_push_claims x SET state='fallback',reason=v_reason,updated_at=clock_timestamp(),
  email_claim_id=coalesce((SELECT f.email_claim_id FROM app.b033_push_fallbacks f WHERE f.claim_id=p_claim),
    (SELECT r.fallback_claim_id FROM app.b033_push_reservations r WHERE r.claim_id=p_claim)),
  email_owner=CASE WHEN app.b037_email_owner(p_claim) IS NOT NULL THEN 'b010_claim' ELSE 'line_fallback' END
  WHERE x.claim_id=p_claim;
 RETURN 'fallback';
END $$;

-- Immediately before dispatch: recheck reminder + recipient eligibility under the same locks.
-- A claim that already holds a B-033 reservation keeps retrying with its original key.
CREATE FUNCTION app.b037_prepare(p_org uuid,p_claim uuid,p_instant timestamptz)
RETURNS TABLE(state text,reason text,notification_id uuid,channel_id uuid,link_id uuid,recipient_contact_id uuid,
 kind text,locale text,company text,amount_minor bigint,currency text,due_date text,liff_id text,line_reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET lock_timeout='2s' AS $$
DECLARE c app.b037_rent_push_claims%ROWTYPE; e app.b010_source_events%ROWTYPE; v_reason text; v_channel uuid;
 v_reserved boolean; v_link uuid; v_friend boolean; v_opt boolean; v_line text; v_done text; v_owner uuid; v_email uuid;
BEGIN
 IF app.b037_enabled(p_org) IS NOT TRUE THEN
  RETURN QUERY SELECT 'disabled'::text,NULL::text,NULL::uuid,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::text,
   NULL::bigint,NULL::text,NULL::text,NULL::text,NULL::text;
  RETURN;
 END IF;
 SELECT * INTO c FROM app.b037_rent_push_claims x WHERE x.claim_id=p_claim AND x.org_id=p_org;
 IF NOT FOUND THEN RAISE EXCEPTION 'Claim unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO e FROM app.b010_source_events s WHERE s.id=c.event_id AND s.org_id=p_org;
 PERFORM 1 FROM public.leases l WHERE l.id=e.lease_id AND l.org_id=p_org FOR SHARE;
 IF e.invoice_id IS NOT NULL THEN PERFORM 1 FROM public.invoices i WHERE i.id=e.invoice_id AND i.org_id=p_org FOR UPDATE; END IF;
 IF e.payment_id IS NOT NULL THEN PERFORM 1 FROM public.payments p WHERE p.id=e.payment_id AND p.org_id=p_org FOR SHARE; END IF;
 SELECT * INTO c FROM app.b037_rent_push_claims x WHERE x.claim_id=p_claim AND x.org_id=p_org FOR UPDATE;
 IF c.state<>'claimed' THEN
  RETURN QUERY SELECT c.state,c.reason,c.notification_id,NULL::uuid,NULL::uuid,c.recipient_contact_id,c.kind,NULL::text,NULL::text,
   NULL::bigint,NULL::text,NULL::text,NULL::text,NULL::text;
  RETURN;
 END IF;
 -- Lock order claim -> reservation: b033_push_expire (reservation FOR UPDATE SKIP LOCKED) then
 -- cannot read this claim as 'claimed' and queue a possible-duplicate Email while it is being suppressed.
 PERFORM 1 FROM app.b033_push_reservations r WHERE r.claim_id=p_claim FOR UPDATE;
 -- A crash after a B-033 settle/fallback commit but before mark: report the real outcome first.
 v_done:=app.b037_resolve(p_claim);
 IF v_done IS NOT NULL THEN
  SELECT * INTO c FROM app.b037_rent_push_claims x WHERE x.claim_id=p_claim;
  RETURN QUERY SELECT c.state,c.reason,c.notification_id,NULL::uuid,NULL::uuid,c.recipient_contact_id,c.kind,NULL::text,NULL::text,
   NULL::bigint,NULL::text,NULL::text,NULL::text,NULL::text;
  RETURN;
 END IF;
 v_reserved:=EXISTS(SELECT 1 FROM app.b033_push_reservations r WHERE r.claim_id=p_claim);
 v_reason:=app.b037_event_reason(p_org,c.event_id,p_instant);
 IF v_reason='eligible' THEN v_reason:=app.b037_recipient_reason(p_org,c.event_id,c.recipient_contact_id); END IF;
 -- A retry is a dispatch: an inapplicable occurrence is suppressed even when it holds a
 -- reservation. The uncertain reservation is kept (never settled or released) and no
 -- possible-duplicate Email is sent; an actively dispatching owner is left to expiry.
 IF v_reason<>'eligible' THEN
  UPDATE app.b037_rent_push_claims x SET state='suppressed',reason=v_reason,updated_at=clock_timestamp() WHERE x.claim_id=p_claim;
  UPDATE public.notifications n SET status='cancelled' WHERE n.org_id=p_org AND n.id=c.notification_id AND n.status='queued';
  IF v_reserved THEN
   UPDATE app.b033_push_reservations r SET status='expired',has_unknown=true,owner_token=NULL,completed_at=now()
    WHERE r.claim_id=p_claim AND r.status='unknown';
   UPDATE public.deliveries d SET status='failed',error='line_unknown_suppressed'
    WHERE d.b033_claim_id=p_claim AND d.channel='line' AND d.status='queued';
  END IF;
  RETURN QUERY SELECT 'suppressed'::text,v_reason,c.notification_id,NULL::uuid,NULL::uuid,c.recipient_contact_id,c.kind,NULL::text,NULL::text,
   NULL::bigint,NULL::text,NULL::text,NULL::text,NULL::text;
  RETURN;
 END IF;
 v_channel:=app.b033_selected_channel(p_org);
 IF v_channel IS NULL AND v_reserved THEN
  -- Keep the original reservation's channel; B-033 then refuses it and falls back through the gateway.
  SELECT r.line_channel_id INTO v_channel FROM app.b033_push_reservations r WHERE r.claim_id=p_claim;
 END IF;
 IF v_channel IS NULL THEN
  -- No usable OA: terminal line_unavailable. A B-010-owned recipient keeps its existing Email claim;
  -- otherwise exactly one deduplicated B-028 Email fallback is queued (no channel row exists to pin).
  v_owner:=app.b037_email_owner(p_claim);
  v_email:=coalesce(v_owner,app.b028_delivery_enqueue(p_org,'line_notification',c.notification_id,'contact:'||c.recipient_contact_id::text,'email'));
  INSERT INTO public.deliveries(org_id,notification_id,recipient_contact_id,channel,provider,status,error,counts_toward_quota,b033_claim_id)
  VALUES(p_org,c.notification_id,c.recipient_contact_id,'line','line_captured','skipped','line_unavailable',false,p_claim)
  ON CONFLICT(b033_claim_id,channel) WHERE b033_claim_id IS NOT NULL DO NOTHING;
  IF v_owner IS NULL THEN
   INSERT INTO public.deliveries(org_id,notification_id,recipient_contact_id,channel,provider,status,error,counts_toward_quota,b033_claim_id)
   VALUES(p_org,c.notification_id,c.recipient_contact_id,'email','b028_email','queued','line_unavailable',false,v_email)
   ON CONFLICT(b033_claim_id,channel) WHERE b033_claim_id IS NOT NULL DO NOTHING;
  END IF;
  UPDATE app.b037_rent_push_claims x SET state='fallback',reason='line_unavailable',email_claim_id=v_email,
   email_owner=CASE WHEN v_owner IS NULL THEN 'line_fallback' ELSE 'b010_claim' END,updated_at=clock_timestamp()
   WHERE x.claim_id=p_claim;
  RETURN QUERY SELECT 'fallback'::text,'line_unavailable'::text,c.notification_id,NULL::uuid,NULL::uuid,c.recipient_contact_id,c.kind,NULL::text,NULL::text,
   NULL::bigint,NULL::text,NULL::text,NULL::text,NULL::text;
  RETURN;
 END IF;
 UPDATE app.b037_rent_push_claims x SET attempted_at=clock_timestamp() WHERE x.claim_id=p_claim;
 SELECT l.id,(l.is_friend AND i.friend_state),l.notification_opt_in INTO v_link,v_friend,v_opt
  FROM public.line_account_links l JOIN app.b033_line_identities i ON i.id=l.login_identity_id AND i.line_channel_id=l.line_channel_id
  WHERE l.org_id=p_org AND l.contact_id=c.recipient_contact_id AND l.line_channel_id=v_channel
   AND l.status='linked' AND l.unlinked_at IS NULL AND l.identity_verified_at IS NOT NULL
   AND i.status='linked' AND i.unlinked_at IS NULL
  ORDER BY l.linked_at DESC NULLS LAST,l.id LIMIT 1;
 v_line:=CASE WHEN v_reserved THEN NULL WHEN v_link IS NULL THEN 'line_unlinked'
  WHEN v_friend IS NOT TRUE THEN 'line_unfollowed' WHEN v_opt IS NOT TRUE THEN 'line_opt_out' END;
 RETURN QUERY SELECT 'eligible'::text,NULL::text,c.notification_id,v_channel,v_link,c.recipient_contact_id,c.kind,n.locale,o.name::text,
  CASE WHEN e.invoice_id IS NULL THEN p.amount_minor ELSE iv.balance_minor END::bigint,
  coalesce(iv.currency,p.currency)::text,iv.due_date::text,ch.liff_id_tenant,v_line
  FROM public.notifications n JOIN public.organizations o ON o.id=n.org_id
  LEFT JOIN public.invoices iv ON iv.id=e.invoice_id AND iv.org_id=n.org_id
  LEFT JOIN public.payments p ON p.id=e.payment_id AND p.org_id=n.org_id
  LEFT JOIN public.line_channels ch ON ch.id=v_channel
  WHERE n.org_id=p_org AND n.id=c.notification_id;
END $$;

-- The existing B-010 tenant Email claim for (event, recipient), if any. It is the occurrence's
-- single Email; LINE fallback then records the skipped LINE delivery against it, sending nothing new.
CREATE FUNCTION app.b037_email_owner(p_claim uuid) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT rc.id FROM app.b037_rent_push_claims c JOIN app.b028_recipient_claims rc
  ON rc.org_id=c.org_id AND rc.event_id=c.event_id AND rc.contact_id=c.recipient_contact_id AND rc.channel='email'
 WHERE c.claim_id=p_claim ORDER BY rc.id LIMIT 1
$$;

-- B-037 fallback gateway (same signature/serialization as b033_push_fallback). Without a B-010
-- Email claim it delegates unchanged; with one it records the terminal LINE skip linked to it.
CREATE FUNCTION app.b037_push_fallback(p_channel uuid,p_claim uuid,p_org uuid,p_notification uuid,
 p_reason text,p_owner uuid DEFAULT NULL) RETURNS TABLE(state text,email_claim uuid,reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET lock_timeout='2s' AS $$
DECLARE r app.b033_push_reservations%ROWTYPE; f app.b033_push_fallbacks%ROWTYPE; v_existing uuid;
 v_contact uuid; v_status public.delivery_status:='skipped'; v_state text;
BEGIN
 BEGIN
  SELECT c.state INTO v_state FROM app.b037_rent_push_claims c
   WHERE c.claim_id=p_claim AND c.org_id=p_org AND c.notification_id=p_notification FOR SHARE NOWAIT;
 EXCEPTION WHEN lock_not_available THEN
  -- A concurrent recheck holds the claim; never wait (no lock cycle) and write nothing.
  RETURN QUERY SELECT 'busy'::text,NULL::uuid,NULL::text; RETURN;
 END;
 IF v_state IS NULL THEN RAISE EXCEPTION 'Claim unavailable' USING ERRCODE='42501'; END IF;
 -- A suppressed occurrence never gets an Email, even when an in-flight worker later fails.
 IF v_state='suppressed' THEN RETURN QUERY SELECT 'suppressed'::text,NULL::uuid,NULL::text; RETURN; END IF;
 v_existing:=app.b037_email_owner(p_claim);
 IF v_existing IS NULL THEN
  RETURN QUERY SELECT * FROM app.b033_push_fallback(p_channel,p_claim,p_org,p_notification,p_reason,p_owner); RETURN;
 END IF;
 IF app.b028_delivery_enabled(p_org) IS NOT TRUE THEN RETURN QUERY SELECT 'fallback_unavailable'::text,NULL::uuid,NULL::text; RETURN; END IF;
 IF app.b033_push_enabled(p_org) IS NOT TRUE THEN RETURN QUERY SELECT 'disabled'::text,NULL::uuid,NULL::text; RETURN; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_claim::text,33));
 SELECT * INTO f FROM app.b033_push_fallbacks x WHERE x.claim_id=p_claim;
 IF FOUND THEN
  IF ROW(f.org_id,f.notification_id,f.line_channel_id) IS DISTINCT FROM ROW(p_org,p_notification,p_channel) THEN
   RAISE EXCEPTION 'Claim scope mismatch' USING ERRCODE='22023'; END IF;
  RETURN QUERY SELECT 'skipped'::text,f.email_claim_id,f.reason; RETURN;
 END IF;
 SELECT * INTO r FROM app.b033_push_reservations x WHERE x.claim_id=p_claim FOR UPDATE NOWAIT;
 IF FOUND THEN
  IF ROW(r.org_id,r.notification_id,r.line_channel_id) IS DISTINCT FROM ROW(p_org,p_notification,p_channel) THEN
   RAISE EXCEPTION 'Claim scope mismatch' USING ERRCODE='22023'; END IF;
  IF r.status='settled' THEN RETURN QUERY SELECT 'accepted'::text,NULL::uuid,NULL::text; RETURN; END IF;
  IF r.status='expired' THEN RETURN QUERY SELECT 'skipped'::text,r.fallback_claim_id,'line_unknown_possible_duplicate'::text; RETURN; END IF;
  IF r.status='dispatching' AND p_owner IS NOT NULL THEN
   IF app.b033_push_release(p_claim,p_owner) IS NOT TRUE THEN RETURN QUERY SELECT 'unknown'::text,NULL::uuid,NULL::text; RETURN; END IF;
  ELSIF r.status<>'released' THEN RETURN QUERY SELECT 'busy'::text,NULL::uuid,NULL::text; RETURN;
  END IF;
  v_status:='failed';
 END IF;
 SELECT n.recipient_contact_id INTO STRICT v_contact FROM public.notifications n WHERE n.org_id=p_org AND n.id=p_notification;
 INSERT INTO app.b033_push_fallbacks(claim_id,org_id,notification_id,line_channel_id,reason,email_claim_id)
 VALUES(p_claim,p_org,p_notification,p_channel,p_reason,v_existing);
 INSERT INTO public.deliveries(org_id,notification_id,recipient_contact_id,line_channel_id,channel,provider,status,error,counts_toward_quota,b033_claim_id)
 VALUES(p_org,p_notification,v_contact,p_channel,'line','line_captured',v_status,p_reason,false,p_claim)
 ON CONFLICT(b033_claim_id,channel) WHERE b033_claim_id IS NOT NULL DO UPDATE SET status=excluded.status,error=excluded.error;
 UPDATE app.b033_push_reservations x SET fallback_claim_id=v_existing WHERE x.claim_id=p_claim;
 RETURN QUERY SELECT 'skipped'::text,v_existing,p_reason;
END $$;

-- Replaces the B-033 body verbatim except for B-037 claims: a suppressed occurrence expires with
-- its uncertain quota retained and no Email; a B-010-owned recipient gets no second Email.
CREATE OR REPLACE FUNCTION app.b033_push_expire(p_org uuid) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET lock_timeout='2s' AS $$
DECLARE r app.b033_push_reservations%ROWTYPE; v_contact uuid; v_email uuid; v_count int:=0; v_state text; v_existing uuid;
BEGIN
 IF app.b033_push_enabled(p_org) IS NOT TRUE THEN RETURN 0; END IF;
 FOR r IN SELECT * FROM app.b033_push_reservations WHERE org_id=p_org
  AND status IN ('reserved','dispatching','unknown') AND (notification_deadline<=now() OR retry_until<=now())
  ORDER BY notification_deadline LIMIT 25 FOR UPDATE SKIP LOCKED LOOP
  SELECT c.state INTO v_state FROM app.b037_rent_push_claims c WHERE c.claim_id=r.claim_id AND c.org_id=r.org_id;
  SELECT recipient_contact_id INTO v_contact FROM public.notifications WHERE id=r.notification_id AND org_id=r.org_id;
  IF v_state='suppressed' THEN
   INSERT INTO public.deliveries(org_id,notification_id,recipient_contact_id,line_channel_id,channel,provider,status,error,counts_toward_quota,b033_claim_id)
   VALUES(r.org_id,r.notification_id,v_contact,r.line_channel_id,'line','line_captured','failed','line_unknown_suppressed',false,r.claim_id)
   ON CONFLICT(b033_claim_id,channel) WHERE b033_claim_id IS NOT NULL DO UPDATE SET status='failed',error=excluded.error;
   UPDATE app.b033_push_reservations SET status='expired',has_unknown=true,owner_token=NULL,completed_at=now() WHERE claim_id=r.claim_id;
   v_count:=v_count+1; CONTINUE;
  END IF;
  v_existing:=CASE WHEN v_state IS NOT NULL THEN app.b037_email_owner(r.claim_id) END;
  IF v_existing IS NULL THEN
   v_email:=app.b028_delivery_enqueue(r.org_id,'line_notification',r.notification_id,'contact:'||v_contact::text,'email');
  ELSE v_email:=v_existing; END IF;
  INSERT INTO public.deliveries(org_id,notification_id,recipient_contact_id,line_channel_id,channel,provider,status,error,counts_toward_quota,b033_claim_id)
  VALUES(r.org_id,r.notification_id,v_contact,r.line_channel_id,'line','line_captured','failed','line_unknown_possible_duplicate',false,r.claim_id)
  ON CONFLICT(b033_claim_id,channel) WHERE b033_claim_id IS NOT NULL DO UPDATE SET status='failed',error=excluded.error;
  IF v_existing IS NULL THEN
   INSERT INTO public.deliveries(org_id,notification_id,recipient_contact_id,channel,provider,status,error,counts_toward_quota,b033_claim_id)
   VALUES(r.org_id,r.notification_id,v_contact,'email','b028_email','queued','line_unknown_possible_duplicate',false,v_email)
   ON CONFLICT(b033_claim_id,channel) WHERE b033_claim_id IS NOT NULL DO NOTHING;
  END IF;
  UPDATE app.b033_push_reservations SET status='expired',has_unknown=true,owner_token=NULL,
   completed_at=now(),fallback_claim_id=v_email WHERE claim_id=r.claim_id;
  v_count:=v_count+1;
 END LOOP;
 RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION app.b033_push_expire(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app.b033_push_expire(uuid) TO service_role;

-- Terminal claim state is derived from B-033 durable records; callers cannot choose it.
CREATE FUNCTION app.b037_mark(p_org uuid,p_claim uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET lock_timeout='2s' AS $$
DECLARE c app.b037_rent_push_claims%ROWTYPE;
BEGIN
 IF app.b037_enabled(p_org) IS NOT TRUE THEN RETURN 'disabled'; END IF;
 SELECT * INTO c FROM app.b037_rent_push_claims x WHERE x.claim_id=p_claim AND x.org_id=p_org FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Claim unavailable' USING ERRCODE='42501'; END IF;
 IF c.state<>'claimed' THEN RETURN c.state; END IF;
 RETURN coalesce(app.b037_resolve(p_claim),'claimed');
END $$;

DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='app' AND p.proname LIKE 'b037_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f);
  IF f::text NOT LIKE '%b037_event_reason%' AND f::text NOT LIKE '%b037_recipient_reason%' AND f::text NOT LIKE '%b037_email_owner%'
   AND f::text NOT LIKE '%b037_resolve%' THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f);
  END IF;
 END LOOP;
END $$;
COMMIT;

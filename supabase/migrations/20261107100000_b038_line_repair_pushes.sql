-- B-038 repair-state LINE pushes. Reads committed repair/approval rows only; no trigger or
-- change to existing repair, ticket or B-013 flows. Local captured transport only.
BEGIN;
SET LOCAL lock_timeout='2s';
INSERT INTO public.platform_settings(key,value) VALUES
 ('line_repair_push','{"enabled":false,"allowed_org_ids":[]}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Activation boundary: the first enabled scan pins started_at; no historical backlog.
CREATE TABLE app.b038_repair_cursors (
 org_id uuid PRIMARY KEY REFERENCES public.organizations(id),
 started_at timestamptz NOT NULL,
 scanned_at timestamptz NOT NULL DEFAULT now()
);
-- One row per (committed source event, recipient). Only internal ids; no message text,
-- LINE identifiers, tokens or protected repair content.
CREATE TABLE app.b038_repair_pushes (
 notification_id uuid PRIMARY KEY,
 org_id uuid NOT NULL,
 claim_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
 source_kind text NOT NULL CHECK (source_kind IN ('ticket_status','approval_requested','approval_reminder_24h','emergency_owner_notice')),
 source_id uuid NOT NULL,
 ticket_id uuid NOT NULL,
 version_id uuid,
 persona text NOT NULL CHECK (persona IN ('tenant','owner')),
 recipient_contact_id uuid NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','claimed','done')),
 claim_token_hash text CHECK (claim_token_hash ~ '^[0-9a-f]{64}$'),
 claim_expires_at timestamptz,
 attempts int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
 -- Backoff for queued rows whose past-SLA close is deferred (busy B-033 owner) or failed.
 retry_after timestamptz,
 outcome text CHECK (outcome IN ('accepted','fallback','withheld','superseded')),
 reason text CHECK (reason IS NULL OR reason ~ '^[a-z_]{1,64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 UNIQUE (org_id, source_kind, source_id, recipient_contact_id),
 FOREIGN KEY (org_id, notification_id) REFERENCES public.notifications(org_id, id) ON DELETE CASCADE,
 CHECK ((state='claimed') = (claim_token_hash IS NOT NULL AND claim_expires_at IS NOT NULL)),
 CHECK ((state='done') = (outcome IS NOT NULL)),
 CHECK ((persona='owner') = (version_id IS NOT NULL)),
 CHECK ((source_kind='ticket_status') = (persona='tenant'))
);
CREATE INDEX b038_repair_pushes_pending ON app.b038_repair_pushes(org_id, created_at, notification_id)
 WHERE state IN ('queued','claimed');
ALTER TABLE app.b038_repair_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b038_repair_pushes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b038_repair_cursors, app.b038_repair_pushes FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION app.b038_repair_enabled(p_org uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET lock_timeout='2s' AS $$
BEGIN
 -- b033_push_enabled already requires line_platform, line_push, notification_delivery_v2
 -- and a matching pinned org context.
 IF app.b033_push_enabled(p_org) IS NOT TRUE THEN RETURN false; END IF;
 RETURN (EXISTS(SELECT 1 FROM public.organizations o JOIN public.platform_settings f ON f.key='line_repair_push'
  WHERE o.id=p_org AND (o.feature_flags->'line_repair_push'='true'::jsonb) IS TRUE
   AND (f.value->'enabled'='true'::jsonb) IS TRUE
   AND (jsonb_typeof(f.value->'allowed_org_ids')='array') IS TRUE
   AND (f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) IS TRUE)) IS TRUE;
END $$;

-- Tenant authority: the reporting tenant contact, still a party of the ticket's lease.
CREATE FUNCTION app.b038_tenant_authorized(p_org uuid, p_ticket uuid, p_contact uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.maintenance_tickets t
  JOIN public.contacts c ON c.org_id=t.org_id AND c.id=p_contact
  WHERE t.org_id=p_org AND t.id=p_ticket AND c.is_tenant AND c.archived_at IS NULL
   AND (t.reported_by_contact_id=c.id
    OR (t.reported_by_contact_id IS NULL AND t.reported_by_user IS NOT NULL AND c.user_id=t.reported_by_user))
   AND (t.lease_id IS NULL OR EXISTS(SELECT 1 FROM public.lease_parties lp
    JOIN public.leases l ON l.org_id=lp.org_id AND l.id=lp.lease_id
    WHERE lp.org_id=t.org_id AND lp.lease_id=t.lease_id AND lp.contact_id=c.id
     AND l.status IN ('pending_signature','active','ended'))))
$$;
-- Owner authority: the designated ownership is still effective today in the org time zone
-- (exclusive end date) and the contact is still the designated principal.
CREATE FUNCTION app.b038_owner_authorized(p_org uuid, p_version uuid, p_contact uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.b013_estimate_versions v
  JOIN public.property_owners po ON po.org_id=v.org_id AND po.id=v.designated_ownership_id AND po.property_id=v.property_id
  JOIN public.contacts c ON c.org_id=po.org_id AND c.id=po.owner_contact_id
  JOIN public.properties pr ON pr.org_id=po.org_id AND pr.id=po.property_id
  JOIN public.organizations o ON o.id=po.org_id
  WHERE v.org_id=p_org AND v.id=p_version AND c.id=p_contact AND v.designated_contact_id=c.id
   AND c.user_id=v.designated_principal_id AND c.is_owner AND c.archived_at IS NULL AND pr.archived_at IS NULL
   AND po.effective_from <= (clock_timestamp() AT TIME ZONE o.timezone)::date
   AND (po.effective_to IS NULL OR po.effective_to > (clock_timestamp() AT TIME ZONE o.timezone)::date))
$$;
-- A request/reminder is only actionable for the current, undecided version.
CREATE FUNCTION app.b038_approval_current(p_org uuid, p_version uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.b013_estimate_versions v
  JOIN app.b013_estimate_heads h ON h.org_id=v.org_id AND h.ticket_id=v.ticket_id AND h.current_version_id=v.id
  WHERE v.org_id=p_org AND v.id=p_version AND v.requires_owner_decision
   AND NOT EXISTS(SELECT 1 FROM app.b013_estimate_decisions d WHERE d.org_id=v.org_id AND d.version_id=v.id)
   AND NOT EXISTS(SELECT 1 FROM app.b013_repair_emergencies e WHERE e.org_id=v.org_id AND e.version_id=v.id))
$$;

CREATE FUNCTION app.b038_repair_enqueue(p_org uuid) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET lock_timeout='2s' AS $$
DECLARE v_since timestamptz; v_count int:=0; r record; v_notification uuid;
BEGIN
 IF app.b038_repair_enabled(p_org) IS NOT TRUE THEN RETURN 0; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('b038/enqueue/'||p_org::text,38));
 INSERT INTO app.b038_repair_cursors(org_id,started_at) VALUES(p_org,clock_timestamp()-interval '15 minutes')
  ON CONFLICT (org_id) DO NOTHING;
 -- A scan gap longer than 15 minutes (flag OFF or worker down) restarts the window, so
 -- re-enabling never pushes a stale backlog. Continuous operation looks back at most 24 hours.
 UPDATE app.b038_repair_cursors SET scanned_at=clock_timestamp(),
  started_at=CASE WHEN scanned_at<clock_timestamp()-interval '15 minutes'
   THEN clock_timestamp()-interval '15 minutes' ELSE started_at END
  WHERE org_id=p_org
  RETURNING greatest(started_at,clock_timestamp()-interval '24 hours') INTO v_since;
 FOR r IN
  SELECT 'ticket_status'::text AS kind, tc.id AS source_id, t.id AS ticket_id, NULL::uuid AS version_id,
   'tenant'::text AS persona, c.id AS contact_id, c.locale, t.lease_id, tc.created_at AS occurred
  FROM public.ticket_comments tc
  JOIN public.maintenance_tickets t ON t.org_id=tc.org_id AND t.id=tc.ticket_id
  JOIN public.contacts c ON c.org_id=t.org_id AND (c.id=t.reported_by_contact_id
   OR (t.reported_by_contact_id IS NULL AND t.reported_by_user IS NOT NULL AND c.user_id=t.reported_by_user AND c.is_tenant))
  WHERE tc.org_id=p_org AND tc.status_to IS NOT NULL AND NOT tc.is_internal AND tc.created_at>=v_since
   AND app.b038_tenant_authorized(p_org,t.id,c.id)
  UNION ALL
  SELECT 'approval_requested', v.id, v.ticket_id, v.id, 'owner', c.id, c.locale, NULL::uuid, v.submitted_at
  FROM app.b013_estimate_versions v
  JOIN public.maintenance_tickets t ON t.org_id=v.org_id AND t.id=v.ticket_id
  JOIN public.contacts c ON c.org_id=v.org_id AND c.id=v.designated_contact_id
  WHERE v.org_id=p_org AND v.requires_owner_decision AND v.submitted_at>=v_since
   AND app.b038_approval_current(p_org,v.id) AND app.b038_owner_authorized(p_org,v.id,c.id)
  UNION ALL
  SELECT e.kind, e.id, e.ticket_id, e.version_id, 'owner', c.id, c.locale, NULL::uuid, e.occurred_at
  FROM app.b013_repair_event_outbox e
  JOIN app.b013_estimate_versions v ON v.org_id=e.org_id AND v.id=e.version_id
  JOIN public.maintenance_tickets t ON t.org_id=e.org_id AND t.id=e.ticket_id
  JOIN public.contacts c ON c.org_id=v.org_id AND c.id=v.designated_contact_id
  WHERE e.org_id=p_org AND e.occurred_at>=v_since
   AND (e.kind='emergency_owner_notice' OR app.b038_approval_current(p_org,e.version_id))
   AND app.b038_owner_authorized(p_org,e.version_id,c.id)
  ORDER BY occurred, source_id, contact_id
 LOOP
  v_notification:=NULL;
  INSERT INTO public.notifications(org_id,event_type,template_key,recipient_contact_id,lease_id,locale,payload,
   related_table,related_id,dedupe_key)
  VALUES(p_org,'b038_repair','line_repair.'||r.kind,r.contact_id,r.lease_id,
   CASE WHEN r.locale='en' THEN 'en' ELSE 'zh-TW' END,jsonb_build_object('kind',r.kind),
   'maintenance_tickets',r.ticket_id,'b038:'||r.kind||':'||r.source_id::text||':'||r.contact_id::text)
  ON CONFLICT (org_id,dedupe_key) DO NOTHING RETURNING id INTO v_notification;
  IF v_notification IS NOT NULL THEN
   INSERT INTO app.b038_repair_pushes(notification_id,org_id,source_kind,source_id,ticket_id,version_id,persona,recipient_contact_id)
   VALUES(v_notification,p_org,r.kind,r.source_id,r.ticket_id,r.version_id,r.persona,r.contact_id);
   v_count:=v_count+1;
  END IF;
 END LOOP;
 RETURN v_count;
END $$;

-- Shared terminal Email fallback for one B-038 row. Uses the claim's pinned B-033 channel
-- (reservation/fallback) or the selected channel. Without any channel no B-033 claim can
-- exist, so it records the LINE skipped and Email deliveries directly. Internal; no grants.
CREATE FUNCTION app.b038_fallback(p_org uuid, p_notification uuid, p_reason text)
RETURNS TABLE(state text, email_claim uuid, reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET lock_timeout='2s' AS $$
DECLARE r app.b038_repair_pushes%ROWTYPE; v_channel uuid; v_email uuid;
BEGIN
 SELECT * INTO STRICT r FROM app.b038_repair_pushes p WHERE p.org_id=p_org AND p.notification_id=p_notification;
 v_channel:=coalesce(
  (SELECT x.line_channel_id FROM app.b033_push_reservations x WHERE x.claim_id=r.claim_id),
  (SELECT x.line_channel_id FROM app.b033_push_fallbacks x WHERE x.claim_id=r.claim_id),
  app.b033_selected_channel(p_org));
 IF v_channel IS NOT NULL THEN
  RETURN QUERY SELECT x.state,x.email_claim,x.reason
   FROM app.b033_push_fallback(v_channel,r.claim_id,p_org,r.notification_id,p_reason) x;
  RETURN;
 END IF;
 IF app.b028_delivery_enabled(p_org) IS NOT TRUE OR app.b033_push_enabled(p_org) IS NOT TRUE THEN
  RETURN QUERY SELECT 'disabled'::text,NULL::uuid,NULL::text; RETURN;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(r.claim_id::text,33));
 v_email:=app.b028_delivery_enqueue(p_org,'line_notification',r.notification_id,'contact:'||r.recipient_contact_id::text,'email');
 INSERT INTO public.deliveries(org_id,notification_id,recipient_contact_id,channel,provider,status,error,counts_toward_quota,b033_claim_id)
 VALUES(p_org,r.notification_id,r.recipient_contact_id,'line','line_captured','skipped',p_reason,false,r.claim_id)
 ON CONFLICT(b033_claim_id,channel) WHERE b033_claim_id IS NOT NULL DO NOTHING;
 INSERT INTO public.deliveries(org_id,notification_id,recipient_contact_id,channel,provider,status,error,counts_toward_quota,b033_claim_id)
 VALUES(p_org,r.notification_id,r.recipient_contact_id,'email','b028_email','queued',p_reason,false,v_email)
 ON CONFLICT(b033_claim_id,channel) WHERE b033_claim_id IS NOT NULL DO NOTHING;
 RETURN QUERY SELECT 'skipped'::text,v_email,p_reason;
END $$;

-- Claims up to p_limit rows, skipping ids the caller already handled this run. Rows past the
-- five-minute notification SLA (or 8 attempts) never block the queue: they close with the
-- deduplicated Email fallback, or stay queued only while B-033 still owns an in-flight claim.
CREATE FUNCTION app.b038_repair_claim(p_org uuid, p_limit int, p_ttl_seconds int, p_exclude uuid[] DEFAULT '{}')
RETURNS TABLE(notification_id uuid, claim_id uuid, token text, persona text, recipient_contact_id uuid,
 source_kind text, channel_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET lock_timeout='2s' AS $$
DECLARE r app.b038_repair_pushes%ROWTYPE; v_token text; v_n int:=0; v_state text; v_email uuid; v_reason text;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 1 AND 600 THEN
  RAISE EXCEPTION 'Invalid repair push claim' USING ERRCODE='22023';
 END IF;
 IF app.b038_repair_enabled(p_org) IS NOT TRUE THEN RETURN; END IF;
 PERFORM app.b033_push_expire(p_org);
 FOR r IN SELECT p.* FROM app.b038_repair_pushes p WHERE p.org_id=p_org
   AND (p.state='queued' OR (p.state='claimed' AND p.claim_expires_at<=clock_timestamp()))
   AND NOT (p.notification_id = ANY(coalesce(p_exclude,'{}'::uuid[])))
   AND (p.retry_after IS NULL OR p.retry_after<=clock_timestamp())
   ORDER BY p.created_at, p.notification_id LIMIT 100 FOR UPDATE OF p SKIP LOCKED LOOP
  IF r.attempts>=8 OR clock_timestamp()>=r.created_at+interval '5 minutes' THEN
   -- Past the SLA: recheck before any Email. Superseded approvals close silently, revoked
   -- authority uses its own reason, and only still-authorized current rows expire to Email.
   -- A failing row is isolated (its partial writes roll back) and backed off; others continue.
   BEGIN
    IF r.source_kind IN ('approval_requested','approval_reminder_24h')
     AND app.b038_approval_current(p_org,r.version_id) IS NOT TRUE THEN
     v_state:='superseded'; v_reason:='repair_superseded';
    ELSE
     v_reason:=CASE WHEN (CASE r.persona WHEN 'tenant' THEN app.b038_tenant_authorized(p_org,r.ticket_id,r.recipient_contact_id)
       ELSE app.b038_owner_authorized(p_org,r.version_id,r.recipient_contact_id) END) IS TRUE
      THEN 'repair_push_expired' ELSE 'repair_authority_revoked' END;
     SELECT x.state,x.email_claim,x.reason INTO v_state,v_email,v_reason
      FROM app.b038_fallback(p_org,r.notification_id,v_reason) x;
    END IF;
    UPDATE app.b038_repair_pushes p SET
     state=CASE WHEN v_state IN ('skipped','accepted','superseded') THEN 'done' ELSE 'queued' END,
     outcome=CASE v_state WHEN 'skipped' THEN (CASE WHEN v_reason='repair_authority_revoked' THEN 'withheld' ELSE 'fallback' END)
      WHEN 'accepted' THEN 'accepted' WHEN 'superseded' THEN 'superseded' END,
     reason=CASE WHEN v_state IN ('skipped','superseded') THEN v_reason END,
     completed_at=CASE WHEN v_state IN ('skipped','accepted','superseded') THEN now() END,
     retry_after=CASE WHEN v_state IN ('skipped','accepted','superseded') THEN NULL ELSE clock_timestamp()+interval '30 seconds' END,
     claim_token_hash=NULL,claim_expires_at=NULL
     WHERE p.notification_id=r.notification_id;
   EXCEPTION WHEN OTHERS THEN
    UPDATE app.b038_repair_pushes p SET state='queued',claim_token_hash=NULL,claim_expires_at=NULL,
     retry_after=clock_timestamp()+interval '60 seconds',reason='repair_fallback_error'
     WHERE p.notification_id=r.notification_id;
   END;
   CONTINUE;
  END IF;
  v_token:=encode(public.gen_random_bytes(32),'hex');
  UPDATE app.b038_repair_pushes p SET state='claimed',attempts=p.attempts+1,retry_after=NULL,reason=NULL,
   claim_token_hash=encode(public.digest(v_token,'sha256'),'hex'),
   claim_expires_at=clock_timestamp()+make_interval(secs=>p_ttl_seconds)
   WHERE p.notification_id=r.notification_id;
  RETURN QUERY SELECT r.notification_id, r.claim_id, v_token, r.persona, r.recipient_contact_id, r.source_kind,
   app.b033_selected_channel(p_org);
  v_n:=v_n+1;
  EXIT WHEN v_n>=p_limit;
 END LOOP;
END $$;

-- Locks and returns the caller's live claim, or raises. Internal helper; no grants.
CREATE FUNCTION app.b038_claimed(p_org uuid, p_notification uuid, p_token text) RETURNS app.b038_repair_pushes
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE r app.b038_repair_pushes%ROWTYPE;
BEGIN
 SELECT * INTO r FROM app.b038_repair_pushes p WHERE p.org_id=p_org AND p.notification_id=p_notification FOR UPDATE;
 IF NOT FOUND OR r.state<>'claimed' OR p_token IS NULL OR r.claim_expires_at<=clock_timestamp()
  OR r.claim_token_hash IS DISTINCT FROM encode(public.digest(p_token,'sha256'),'hex') THEN
  RAISE EXCEPTION 'Repair push claim unavailable' USING ERRCODE='42501';
 END IF;
 RETURN r;
END $$;

-- Rechecks flags and current authority. Summary fields are returned only when authorized.
CREATE FUNCTION app.b038_repair_context(p_org uuid, p_notification uuid, p_token text)
RETURNS TABLE(authority text, channel_id uuid, liff_id text, locale text, kind text,
 ticket_number int, status_to text, version_no bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET lock_timeout='2s' AS $$
DECLARE r app.b038_repair_pushes%ROWTYPE; v_channel uuid; v_ok boolean;
BEGIN
 r:=app.b038_claimed(p_org,p_notification,p_token);
 IF app.b038_repair_enabled(p_org) IS NOT TRUE THEN
  RETURN QUERY SELECT 'disabled'::text,NULL::uuid,NULL::text,NULL::text,r.source_kind,NULL::int,NULL::text,NULL::bigint; RETURN;
 END IF;
 v_channel:=app.b033_selected_channel(p_org);
 v_ok:=CASE r.persona WHEN 'tenant' THEN app.b038_tenant_authorized(p_org,r.ticket_id,r.recipient_contact_id)
  ELSE app.b038_owner_authorized(p_org,r.version_id,r.recipient_contact_id) END;
 IF v_ok IS NOT TRUE THEN
  RETURN QUERY SELECT 'revoked'::text,v_channel,NULL::text,NULL::text,r.source_kind,NULL::int,NULL::text,NULL::bigint; RETURN;
 END IF;
 IF r.source_kind IN ('approval_requested','approval_reminder_24h') AND app.b038_approval_current(p_org,r.version_id) IS NOT TRUE THEN
  RETURN QUERY SELECT 'superseded'::text,v_channel,NULL::text,NULL::text,r.source_kind,NULL::int,NULL::text,NULL::bigint; RETURN;
 END IF;
 RETURN QUERY SELECT 'ok'::text, v_channel,
  (SELECT CASE r.persona WHEN 'tenant' THEN ch.liff_id_tenant ELSE ch.liff_id_owner END FROM public.line_channels ch WHERE ch.id=v_channel),
  n.locale, r.source_kind, t.ticket_number,
  (SELECT tc.status_to::text FROM public.ticket_comments tc WHERE r.source_kind='ticket_status' AND tc.org_id=p_org AND tc.id=r.source_id),
  (SELECT v.version_no FROM app.b013_estimate_versions v WHERE v.org_id=p_org AND v.id=r.version_id)
 FROM public.notifications n JOIN public.maintenance_tickets t ON t.org_id=n.org_id AND t.id=r.ticket_id
 WHERE n.org_id=p_org AND n.id=r.notification_id;
END $$;

-- Withholds the protected payload. Revoked authority records the shared B-033/B-028
-- deduplicated Email fallback with the reason; a superseded approval closes silently.
CREATE FUNCTION app.b038_repair_withhold(p_org uuid, p_notification uuid, p_token text, p_reason text)
RETURNS TABLE(state text, email_claim uuid, reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET lock_timeout='2s' AS $$
DECLARE r app.b038_repair_pushes%ROWTYPE; v_state text; v_email uuid; v_reason text;
BEGIN
 IF p_reason IS NULL OR p_reason NOT IN ('repair_authority_revoked','repair_superseded','line_unavailable') THEN
  RAISE EXCEPTION 'Invalid withhold reason' USING ERRCODE='22023';
 END IF;
 r:=app.b038_claimed(p_org,p_notification,p_token);
 IF app.b038_repair_enabled(p_org) IS NOT TRUE THEN
  RETURN QUERY SELECT 'disabled'::text,NULL::uuid,NULL::text; RETURN;
 END IF;
 IF p_reason='repair_superseded' THEN
  UPDATE app.b038_repair_pushes p SET state='done',outcome='superseded',reason=p_reason,completed_at=now(),
   claim_token_hash=NULL,claim_expires_at=NULL WHERE p.notification_id=r.notification_id;
  RETURN QUERY SELECT 'superseded'::text,NULL::uuid,p_reason; RETURN;
 END IF;
 SELECT x.state,x.email_claim,x.reason INTO v_state,v_email,v_reason FROM app.b038_fallback(p_org,r.notification_id,p_reason) x;
 IF v_state='skipped' THEN
  UPDATE app.b038_repair_pushes p SET state='done',outcome='withheld',reason=coalesce(v_reason,p_reason),completed_at=now(),
   claim_token_hash=NULL,claim_expires_at=NULL WHERE p.notification_id=r.notification_id;
 ELSIF v_state='accepted' THEN
  UPDATE app.b038_repair_pushes p SET state='done',outcome='accepted',completed_at=now(),
   claim_token_hash=NULL,claim_expires_at=NULL WHERE p.notification_id=r.notification_id;
 ELSE
  UPDATE app.b038_repair_pushes p SET state='queued',claim_token_hash=NULL,claim_expires_at=NULL
   WHERE p.notification_id=r.notification_id;
 END IF;
 RETURN QUERY SELECT v_state,v_email,v_reason;
END $$;

-- Called by the shared B-033 dispatcher inside its decision transaction, after the claim
-- advisory lock and before any reservation or provider call. Locks the authority rows
-- (NOWAIT FOR SHARE) so a concurrent revocation either is visible here or waits for this
-- decision. allow | deny (authority revoked => Email fallback) | skip (requeue, no writes).
CREATE FUNCTION app.b038_repair_authorize(p_org uuid, p_notification uuid, p_token text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET lock_timeout='2s' AS $$
DECLARE r app.b038_repair_pushes%ROWTYPE;
BEGIN
 SELECT * INTO r FROM app.b038_repair_pushes p WHERE p.org_id=p_org AND p.notification_id=p_notification FOR UPDATE;
 IF NOT FOUND OR r.state<>'claimed' OR p_token IS NULL OR r.claim_expires_at<=clock_timestamp()
  OR r.claim_token_hash IS DISTINCT FROM encode(public.digest(p_token,'sha256'),'hex') THEN RETURN 'skip'; END IF;
 IF app.b038_repair_enabled(p_org) IS NOT TRUE THEN RETURN 'skip'; END IF;
 BEGIN
  PERFORM 1 FROM public.contacts c WHERE c.org_id=p_org AND c.id=r.recipient_contact_id FOR SHARE NOWAIT;
  IF r.persona='tenant' THEN
   PERFORM 1 FROM public.maintenance_tickets t WHERE t.org_id=p_org AND t.id=r.ticket_id FOR SHARE NOWAIT;
   PERFORM 1 FROM public.lease_parties lp
    JOIN public.maintenance_tickets t ON t.org_id=lp.org_id AND t.lease_id=lp.lease_id
    JOIN public.leases l ON l.org_id=lp.org_id AND l.id=lp.lease_id
    WHERE t.org_id=p_org AND t.id=r.ticket_id AND lp.contact_id=r.recipient_contact_id FOR SHARE OF lp, l NOWAIT;
   RETURN CASE WHEN app.b038_tenant_authorized(p_org,r.ticket_id,r.recipient_contact_id) THEN 'allow' ELSE 'deny' END;
  END IF;
  PERFORM 1 FROM app.b013_estimate_versions v
   JOIN public.property_owners po ON po.org_id=v.org_id AND po.id=v.designated_ownership_id
   JOIN public.properties pr ON pr.org_id=po.org_id AND pr.id=po.property_id
   WHERE v.org_id=p_org AND v.id=r.version_id FOR SHARE OF po, pr NOWAIT;
 EXCEPTION WHEN lock_not_available THEN RETURN 'skip';
 END;
 IF app.b038_owner_authorized(p_org,r.version_id,r.recipient_contact_id) IS NOT TRUE THEN RETURN 'deny'; END IF;
 IF r.source_kind IN ('approval_requested','approval_reminder_24h') AND app.b038_approval_current(p_org,r.version_id) IS NOT TRUE THEN
  RETURN 'skip';
 END IF;
 RETURN 'allow';
END $$;

-- Records the dispatcher result for the caller's own claim. 'requeue' keeps the same claim id.
CREATE FUNCTION app.b038_repair_complete(p_org uuid, p_notification uuid, p_token text, p_outcome text, p_reason text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET lock_timeout='2s' AS $$
DECLARE r app.b038_repair_pushes%ROWTYPE;
BEGIN
 IF p_outcome IS NULL OR p_outcome NOT IN ('accepted','fallback','requeue')
  OR (p_reason IS NOT NULL AND p_reason !~ '^[a-z_]{1,64}$') THEN
  RAISE EXCEPTION 'Invalid repair push result' USING ERRCODE='22023';
 END IF;
 r:=app.b038_claimed(p_org,p_notification,p_token);
 IF p_outcome='requeue' THEN
  UPDATE app.b038_repair_pushes p SET state='queued',claim_token_hash=NULL,claim_expires_at=NULL
   WHERE p.notification_id=r.notification_id;
 ELSE
  UPDATE app.b038_repair_pushes p SET state='done',outcome=p_outcome,reason=p_reason,completed_at=now(),
   claim_token_hash=NULL,claim_expires_at=NULL WHERE p.notification_id=r.notification_id;
 END IF;
END $$;

DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='app' AND p.proname LIKE 'b038_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION app.b038_repair_enabled(uuid), app.b038_repair_enqueue(uuid),
 app.b038_repair_claim(uuid,int,int,uuid[]), app.b038_repair_context(uuid,uuid,text),
 app.b038_repair_authorize(uuid,uuid,text),
 app.b038_repair_withhold(uuid,uuid,text,text), app.b038_repair_complete(uuid,uuid,text,text,text)
 TO service_role;
COMMIT;

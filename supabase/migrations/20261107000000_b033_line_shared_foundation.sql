-- B-033 Slice 1. Local captured transport only; no legacy identity backfill.
BEGIN;
SET LOCAL lock_timeout='2s';
INSERT INTO public.platform_settings(key,value) VALUES
 ('line_platform','{"enabled":false,"allowed_org_ids":[]}'::jsonb),
 ('line_push','{"enabled":false,"allowed_org_ids":[]}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Shared schema reserve from hub section 3.1; no LIFF routes or configuration UI yet.
ALTER TABLE public.line_channels
 ADD COLUMN liff_id_tenant text,
 ADD COLUMN liff_id_owner text,
 ADD COLUMN liff_id_vendor text,
 ADD COLUMN tenant_config_verified_at timestamptz,
 ADD CONSTRAINT line_channels_liff_nonempty CHECK (
  (liff_id_tenant IS NULL OR length(btrim(liff_id_tenant))>0) AND
  (liff_id_owner IS NULL OR length(btrim(liff_id_owner))>0) AND
  (liff_id_vendor IS NULL OR length(btrim(liff_id_vendor))>0)),
 ADD CONSTRAINT line_channels_id_provider_uniq UNIQUE(id,line_provider_id);
CREATE UNIQUE INDEX line_channels_liff_tenant_uniq ON public.line_channels(liff_id_tenant) WHERE liff_id_tenant IS NOT NULL;
CREATE UNIQUE INDEX line_channels_liff_owner_uniq ON public.line_channels(liff_id_owner) WHERE liff_id_owner IS NOT NULL;
CREATE UNIQUE INDEX line_channels_liff_vendor_uniq ON public.line_channels(liff_id_vendor) WHERE liff_id_vendor IS NOT NULL;

-- Only the definer gateway (or migration owner) may stamp verification. Invoker
-- identity is deliberate: a client-set GUC or inherited table grant is not authority.
CREATE FUNCTION app.b033_channel_verified_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF (TG_OP='INSERT' AND NEW.tenant_config_verified_at IS NOT NULL) OR
    (TG_OP='UPDATE' AND NEW.tenant_config_verified_at IS DISTINCT FROM OLD.tenant_config_verified_at) THEN
  IF current_user IN ('anon','authenticated','service_role') THEN
   RAISE EXCEPTION 'Configuration verification requires gateway' USING ERRCODE='42501';
  END IF;
 END IF;
 IF TG_OP='INSERT' OR (to_jsonb(NEW)-ARRAY['tenant_config_verified_at','display_name','created_at','updated_at','connected_by'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['tenant_config_verified_at','display_name','created_at','updated_at','connected_by']) THEN
  NEW.tenant_config_verified_at:=NULL;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER b033_channel_verified_guard BEFORE INSERT OR UPDATE ON public.line_channels
 FOR EACH ROW EXECUTE FUNCTION app.b033_channel_verified_guard();
CREATE FUNCTION app.b033_channel_verify(p_channel uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
 UPDATE public.line_channels SET tenant_config_verified_at=now() WHERE id=p_channel
  AND (nullif(current_setting('app.active_org_id',true),'') IS NULL OR org_id::text=current_setting('app.active_org_id',true));
 IF NOT FOUND THEN RAISE EXCEPTION 'Channel unavailable' USING ERRCODE='42501'; END IF;
END $$;

CREATE TABLE app.b033_line_identities (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 line_channel_id uuid NOT NULL REFERENCES public.line_channels(id),
 provider_user_hash text NOT NULL CHECK (provider_user_hash ~ '^[0-9a-f]{64}$'),
 user_id uuid NOT NULL REFERENCES auth.users(id),
 persona text NOT NULL CHECK (persona IN ('tenant','owner','vendor')),
 status text NOT NULL DEFAULT 'linked' CHECK (status IN ('linked','unlinked','revoked')),
 linked_at timestamptz NOT NULL DEFAULT now(), unlinked_at timestamptz,
 friend_state boolean NOT NULL DEFAULT false, friend_state_at timestamptz, last_event_at timestamptz,
 UNIQUE(line_channel_id,provider_user_hash)
);
CREATE TABLE app.b033_line_flows (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), flow_hash text UNIQUE NOT NULL CHECK (flow_hash ~ '^[0-9a-f]{64}$'),
 kind text NOT NULL CHECK (kind IN ('login','bind','invite','unlink')),
 line_channel_id uuid NOT NULL REFERENCES public.line_channels(id),
 persona text NOT NULL CHECK (persona IN ('tenant','owner','vendor')),
 state_hash text NOT NULL CHECK (state_hash ~ '^[0-9a-f]{64}$'),
 nonce_hash text NOT NULL CHECK (nonce_hash ~ '^[0-9a-f]{64}$'),
 expires_at timestamptz NOT NULL, consumed_at timestamptz
);
CREATE TABLE app.b033_webhook_events (
 line_channel_id uuid NOT NULL REFERENCES public.line_channels(id),
 webhook_event_id text NOT NULL CHECK (length(webhook_event_id) BETWEEN 1 AND 200),
 event_type text NOT NULL, event_ts timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(line_channel_id,webhook_event_id)
);
CREATE TABLE public.line_push_usage (
 line_channel_id uuid NOT NULL REFERENCES public.line_channels(id),
 period_month date NOT NULL CHECK (extract(day FROM period_month)=1),
 pushed_count int NOT NULL DEFAULT 0 CHECK (pushed_count>=0),
 reserved_count int NOT NULL DEFAULT 0 CHECK (reserved_count>=0),
 alert_sent_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(line_channel_id,period_month)
);
CREATE TABLE app.b033_org_push_budgets (
 line_channel_id uuid NOT NULL REFERENCES public.line_channels(id),
 org_id uuid NOT NULL REFERENCES public.organizations(id),
 period_month date NOT NULL CHECK (extract(day FROM period_month)=1),
 budget int NOT NULL CHECK (budget BETWEEN 0 AND 180),
 used int NOT NULL DEFAULT 0 CHECK (used>=0), reserved int NOT NULL DEFAULT 0 CHECK (reserved>=0),
 PRIMARY KEY(line_channel_id,org_id,period_month)
);
CREATE TABLE app.b033_push_reservations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), claim_id uuid NOT NULL UNIQUE,
 line_channel_id uuid NOT NULL, org_id uuid NOT NULL, notification_id uuid NOT NULL,
 period_month date NOT NULL,
 status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','dispatching','settled','released','unknown','expired')),
 owner_token uuid, started_at timestamptz, attempt_count int NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
 created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 retry_until timestamptz NOT NULL DEFAULT now()+interval '24 hours',
 notification_deadline timestamptz NOT NULL,
 has_unknown boolean NOT NULL DEFAULT false, fallback_claim_id uuid,
 FOREIGN KEY(org_id,notification_id) REFERENCES public.notifications(org_id,id),
 FOREIGN KEY(line_channel_id,period_month) REFERENCES public.line_push_usage(line_channel_id,period_month),
 FOREIGN KEY(line_channel_id,org_id,period_month) REFERENCES app.b033_org_push_budgets(line_channel_id,org_id,period_month)
);
-- A terminal decision does not require a healthy counter or an org budget row.
CREATE TABLE app.b033_push_fallbacks (
 claim_id uuid PRIMARY KEY, org_id uuid NOT NULL, notification_id uuid NOT NULL,
 line_channel_id uuid NOT NULL REFERENCES public.line_channels(id),
 reason text NOT NULL, email_claim_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(org_id,notification_id) REFERENCES public.notifications(org_id,id)
);
ALTER TABLE app.b033_push_fallbacks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b033_push_fallbacks FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON app.b033_push_fallbacks TO service_role;
CREATE INDEX b033_push_deadline_idx ON app.b033_push_reservations(notification_deadline)
 WHERE status IN ('reserved','dispatching','unknown');
-- Durable local ops-Email outbox; one hard-threshold intent and audit per channel/month.
CREATE TABLE app.b033_quota_alerts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), line_channel_id uuid NOT NULL,
 period_month date NOT NULL, channel text NOT NULL DEFAULT 'email' CHECK (channel='email'),
 status text NOT NULL DEFAULT 'queued' CHECK (status='queued'),
 pushed_count int NOT NULL, reserved_count int NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(line_channel_id,period_month),
 FOREIGN KEY(line_channel_id,period_month) REFERENCES public.line_push_usage(line_channel_id,period_month)
);

-- Nullable increments only. Existing links remain unverified and never become push targets.
ALTER TABLE public.line_account_links
 ADD COLUMN login_identity_id uuid REFERENCES app.b033_line_identities(id) ON DELETE RESTRICT,
 ADD COLUMN identity_verified_at timestamptz,
 ADD COLUMN friend_event_at timestamptz,
 ADD COLUMN friend_event_id text,
 ADD COLUMN notification_opt_in boolean NOT NULL DEFAULT false,
 ADD CONSTRAINT line_links_identity_pair_ck CHECK ((login_identity_id IS NULL)=(identity_verified_at IS NULL)),
 ADD CONSTRAINT line_links_opt_in_ck CHECK (NOT notification_opt_in OR
   (status='linked' AND login_identity_id IS NOT NULL AND identity_verified_at IS NOT NULL AND consented_at IS NOT NULL AND consent_text_key IS NOT NULL));
CREATE INDEX line_links_identity_idx ON public.line_account_links(login_identity_id) WHERE login_identity_id IS NOT NULL;
-- No changes to old link write policies in this slice. Column-level revokes cannot override
-- existing table grants: new identity writes remain service-only and push rechecks the mapping.
-- Prevent clients forging the new verified-link fields while preserving legacy CRUD.
CREATE FUNCTION app.b033_link_verified_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF current_setting('role',true) IN ('anon','authenticated') AND
   (NEW.login_identity_id IS NOT NULL OR NEW.identity_verified_at IS NOT NULL OR NEW.notification_opt_in
    OR NEW.friend_event_at IS NOT NULL OR NEW.friend_event_id IS NOT NULL) THEN
   RAISE EXCEPTION 'Verified link requires service' USING ERRCODE='42501';
 END IF;
 IF NEW.login_identity_id IS NOT NULL AND NOT EXISTS (
   SELECT 1 FROM app.b033_line_identities i JOIN public.contacts c ON c.id=NEW.contact_id AND c.org_id=NEW.org_id
   WHERE i.id=NEW.login_identity_id AND i.line_channel_id=NEW.line_channel_id AND i.user_id=c.user_id
     AND i.status='linked' AND i.unlinked_at IS NULL) THEN
   RAISE EXCEPTION 'Identity mismatch' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER b033_link_verified_guard BEFORE INSERT OR UPDATE ON public.line_account_links
 FOR EACH ROW EXECUTE FUNCTION app.b033_link_verified_guard();
ALTER TABLE public.deliveries ADD COLUMN b033_claim_id uuid;
CREATE UNIQUE INDEX deliveries_b033_claim_channel_uniq ON public.deliveries(b033_claim_id,channel) WHERE b033_claim_id IS NOT NULL;

ALTER TABLE app.b033_line_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b033_line_flows ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b033_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b033_org_push_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b033_push_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.b033_quota_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.line_push_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.b033_line_identities,app.b033_line_flows,app.b033_webhook_events,
 app.b033_push_reservations,app.b033_quota_alerts,public.line_push_usage FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE ON app.b033_line_identities,app.b033_line_flows,app.b033_webhook_events,
 app.b033_push_reservations,app.b033_quota_alerts,public.line_push_usage TO service_role;

REVOKE ALL ON app.b033_org_push_budgets FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON app.b033_org_push_budgets TO service_role;

-- Do not copy complete LINE rows into audit_log, including on legacy CRUD.
-- The same whitelist covers line_channels, whose old generic trigger disclosed provider refs.
CREATE FUNCTION app.b033_line_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE o jsonb; n jsonb; cols text[];
 fields text[]:=ARRAY['id','org_id','contact_id','status','is_friend','notification_opt_in',
   'identity_verified_at','linked_at','unlinked_at','friend_event_at','is_active','mode','tenant_config_verified_at'];
BEGIN
 IF TG_OP IN ('UPDATE','DELETE') THEN
  SELECT jsonb_object_agg(key,value) INTO o FROM jsonb_each(to_jsonb(OLD)) WHERE key=ANY(fields);
 END IF;
 IF TG_OP IN ('INSERT','UPDATE') THEN
  SELECT jsonb_object_agg(key,value) INTO n FROM jsonb_each(to_jsonb(NEW)) WHERE key=ANY(fields);
 END IF;
 IF TG_OP='UPDATE' THEN
  SELECT array_agg(key) INTO cols FROM jsonb_each(n) WHERE o->key IS DISTINCT FROM value;
  IF cols IS NULL THEN RETURN NEW; END IF;
 END IF;
 INSERT INTO public.audit_log(org_id,actor_user_id,actor_role,table_name,row_id,action,old_row,new_row,changed_cols)
 VALUES(coalesce((n->>'org_id')::uuid,(o->>'org_id')::uuid),auth.uid(),current_user,TG_TABLE_NAME,
   coalesce(n->>'id',o->>'id'),lower(TG_OP)::public.audit_action,o,n,cols);
 RETURN coalesce(NEW,OLD);
END $$;
DROP TRIGGER trg_line_account_links_audit ON public.line_account_links;
CREATE TRIGGER trg_line_account_links_audit AFTER INSERT OR UPDATE OR DELETE ON public.line_account_links
 FOR EACH ROW EXECUTE FUNCTION app.b033_line_audit();
DROP TRIGGER trg_line_channels_audit ON public.line_channels;
CREATE TRIGGER trg_line_channels_audit AFTER INSERT OR UPDATE OR DELETE ON public.line_channels
 FOR EACH ROW EXECUTE FUNCTION app.b033_line_audit();

CREATE FUNCTION app.b033_org_budget_set(p_channel uuid,p_org uuid,p_period date,p_budget int) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET lock_timeout='2s' AS $$
BEGIN
 IF nullif(current_setting('app.active_org_id',true),'') IS NOT NULL
    AND current_setting('app.active_org_id',true) IS DISTINCT FROM p_org::text THEN
  RAISE EXCEPTION 'Organization mismatch' USING ERRCODE='42501';
 END IF;
 INSERT INTO app.b033_org_push_budgets(line_channel_id,org_id,period_month,budget)
 VALUES(p_channel,p_org,p_period,p_budget)
 ON CONFLICT(line_channel_id,org_id,period_month) DO UPDATE SET budget=excluded.budget;
END $$;
CREATE FUNCTION app.b033_line_enabled(p_org uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET lock_timeout='2s' AS $$
BEGIN
 IF nullif(current_setting('app.active_org_id',true),'') IS NOT NULL
    AND current_setting('app.active_org_id',true) IS DISTINCT FROM p_org::text THEN RETURN false; END IF;
 LOCK TABLE public.platform_settings IN SHARE MODE NOWAIT;
 PERFORM 1 FROM public.organizations WHERE id=p_org FOR SHARE NOWAIT;
 RETURN (EXISTS(SELECT 1 FROM public.organizations o JOIN public.platform_settings f ON f.key='line_platform'
  WHERE o.id=p_org AND (o.feature_flags->'line_platform'='true'::jsonb) IS TRUE
   AND (f.value->'enabled'='true'::jsonb) IS TRUE
   AND (jsonb_typeof(f.value->'allowed_org_ids')='array') IS TRUE
   AND (f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) IS TRUE)) IS TRUE;
END $$;
CREATE FUNCTION app.b033_push_enabled(p_org uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET lock_timeout='2s' AS $$
BEGIN
 IF app.b033_line_enabled(p_org) IS NOT TRUE OR app.b028_delivery_enabled(p_org) IS NOT TRUE THEN RETURN false; END IF;
 RETURN (EXISTS(SELECT 1 FROM public.organizations o JOIN public.platform_settings f ON f.key='line_push'
  WHERE o.id=p_org AND (o.feature_flags->'line_push'='true'::jsonb) IS TRUE
   AND (f.value->'enabled'='true'::jsonb) IS TRUE
   AND (jsonb_typeof(f.value->'allowed_org_ids')='array') IS TRUE
   AND (f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) IS TRUE)) IS TRUE;
END $$;
-- Same selected-OA resolution as PROP-06. Used by both the webhook and dispatcher.
CREATE FUNCTION app.b033_selected_channel(p_org uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET lock_timeout='2s' AS $$
DECLARE v_id uuid;
BEGIN
 IF app.b033_line_enabled(p_org) IS NOT TRUE THEN RETURN NULL; END IF;
 SELECT ch.id INTO v_id FROM public.organizations o JOIN public.line_channels ch ON ch.id=o.line_channel_id
  WHERE o.id=p_org AND ch.is_active AND ((ch.mode='org_owned' AND ch.org_id=p_org) OR ch.mode='platform_default');
 IF v_id IS NULL THEN SELECT id INTO v_id FROM public.line_channels WHERE mode='platform_default' AND is_active; END IF;
 RETURN v_id;
END $$;
CREATE FUNCTION app.b033_push_reserve(p_channel uuid,p_claim uuid,p_org uuid,p_notification uuid,p_limit int DEFAULT 180)
RETURNS TABLE(period_month date,status text,pushed_count int,reserved_count int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET lock_timeout='2s' AS $$
DECLARE v_month date:=date_trunc('month',now() AT TIME ZONE 'Asia/Taipei')::date;
 v_res app.b033_push_reservations%ROWTYPE; v_budget app.b033_org_push_budgets%ROWTYPE;
 v_push int; v_reserved int; v_deadline timestamptz;
BEGIN
 IF p_claim IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 180 THEN
  RAISE EXCEPTION 'Invalid reservation' USING ERRCODE='22023';
 END IF;
 IF app.b033_push_enabled(p_org) IS NOT TRUE OR app.b033_selected_channel(p_org) IS DISTINCT FROM p_channel THEN RETURN; END IF;
 SELECT greatest(n.created_at,n.scheduled_for)+interval '5 minutes' INTO v_deadline
 FROM public.notifications n WHERE n.id=p_notification AND n.org_id=p_org;
 IF NOT FOUND THEN RAISE EXCEPTION 'Notification unavailable' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_claim::text,33));
 IF EXISTS(SELECT 1 FROM app.b033_push_fallbacks WHERE claim_id=p_claim) THEN
  RETURN QUERY SELECT v_month,'fallback'::text,0,0; RETURN;
 END IF;
 SELECT * INTO v_res FROM app.b033_push_reservations r WHERE r.claim_id=p_claim FOR UPDATE;
 IF FOUND THEN
  IF v_res.line_channel_id<>p_channel OR v_res.org_id<>p_org OR v_res.notification_id<>p_notification THEN
   RAISE EXCEPTION 'Claim scope mismatch' USING ERRCODE='22023';
  END IF;
  RETURN QUERY SELECT u.period_month,v_res.status,u.pushed_count,u.reserved_count FROM public.line_push_usage u
   WHERE u.line_channel_id=p_channel AND u.period_month=v_res.period_month;
  RETURN;
 END IF;
 IF v_deadline<=now() THEN RETURN QUERY SELECT v_month,'expired'::text,0,0; RETURN; END IF;
 -- Lock org budget before channel counter everywhere. Both reservations commit or roll back together.
 SELECT * INTO v_budget FROM app.b033_org_push_budgets b
  WHERE b.line_channel_id=p_channel AND b.org_id=p_org AND b.period_month=v_month FOR UPDATE;
 IF NOT FOUND OR v_budget.used+v_budget.reserved>=v_budget.budget THEN
  RETURN QUERY SELECT v_month,'line_budget'::text,0,0; RETURN;
 END IF;
 INSERT INTO public.line_push_usage(line_channel_id,period_month) VALUES(p_channel,v_month) ON CONFLICT DO NOTHING;
 UPDATE public.line_push_usage u SET reserved_count=u.reserved_count+1,updated_at=now()
  WHERE u.line_channel_id=p_channel AND u.period_month=v_month AND u.pushed_count+u.reserved_count<p_limit
  RETURNING u.pushed_count,u.reserved_count INTO v_push,v_reserved;
 IF NOT FOUND THEN RETURN; END IF;
 UPDATE app.b033_org_push_budgets SET reserved=reserved+1
  WHERE line_channel_id=p_channel AND org_id=p_org AND app.b033_org_push_budgets.period_month=v_month;
 INSERT INTO app.b033_push_reservations(claim_id,line_channel_id,org_id,notification_id,period_month,notification_deadline)
  VALUES(p_claim,p_channel,p_org,p_notification,v_month,v_deadline);
 RETURN QUERY SELECT v_month,'reserved'::text,v_push,v_reserved;
END $$;

-- Exclusive ownership persists beyond the short transaction. A crashed owner becomes unknown,
-- never a free reservation. Three attempts / 24h retry key validity / five minute notification SLA.
CREATE FUNCTION app.b033_push_start(p_claim uuid,p_owner uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET lock_timeout='2s' AS $$
DECLARE r app.b033_push_reservations%ROWTYPE;
BEGIN
 SELECT * INTO r FROM app.b033_push_reservations WHERE claim_id=p_claim FOR UPDATE NOWAIT;
 IF NOT FOUND OR p_owner IS NULL THEN RETURN 'unavailable'; END IF;
 IF r.status IN ('settled','released','expired') THEN RETURN r.status; END IF;
 IF now()>=r.notification_deadline OR now()>=r.retry_until THEN RETURN 'expired'; END IF;
 IF r.status='dispatching' THEN
  IF now()<r.started_at+interval '15 seconds' THEN RETURN 'busy'; END IF;
  UPDATE app.b033_push_reservations SET status='unknown',has_unknown=true,owner_token=NULL WHERE claim_id=p_claim;
 END IF;
 IF r.attempt_count>=3 THEN RETURN 'unknown'; END IF;
 UPDATE app.b033_push_reservations SET status='dispatching',owner_token=p_owner,started_at=now(),
  attempt_count=attempt_count+1,completed_at=NULL WHERE claim_id=p_claim;
 RETURN 'dispatching';
EXCEPTION WHEN lock_not_available THEN RETURN 'busy';
END $$;
CREATE FUNCTION app.b033_push_settle(p_claim uuid,p_owner uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET lock_timeout='2s' AS $$
DECLARE r app.b033_push_reservations%ROWTYPE;
BEGIN
 SELECT * INTO r FROM app.b033_push_reservations WHERE claim_id=p_claim FOR UPDATE;
 IF NOT FOUND OR r.status<>'dispatching' OR r.owner_token IS DISTINCT FROM p_owner THEN RETURN false; END IF;
 UPDATE app.b033_org_push_budgets SET reserved=reserved-1,used=used+1
  WHERE line_channel_id=r.line_channel_id AND org_id=r.org_id AND period_month=r.period_month;
 UPDATE public.line_push_usage SET reserved_count=reserved_count-1,pushed_count=pushed_count+1,updated_at=now()
  WHERE line_channel_id=r.line_channel_id AND period_month=r.period_month;
 UPDATE app.b033_push_reservations SET status='settled',completed_at=now(),owner_token=NULL WHERE claim_id=p_claim;
 RETURN true;
END $$;
CREATE FUNCTION app.b033_push_release(p_claim uuid,p_owner uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET lock_timeout='2s' AS $$
DECLARE r app.b033_push_reservations%ROWTYPE;
BEGIN
 SELECT * INTO r FROM app.b033_push_reservations WHERE claim_id=p_claim FOR UPDATE;
 IF NOT FOUND OR r.status<>'dispatching' OR r.owner_token IS DISTINCT FROM p_owner OR r.has_unknown THEN RETURN false; END IF;
 UPDATE app.b033_org_push_budgets SET reserved=reserved-1
  WHERE line_channel_id=r.line_channel_id AND org_id=r.org_id AND period_month=r.period_month;
 UPDATE public.line_push_usage SET reserved_count=reserved_count-1,updated_at=now()
  WHERE line_channel_id=r.line_channel_id AND period_month=r.period_month;
 UPDATE app.b033_push_reservations SET status='released',completed_at=now(),owner_token=NULL WHERE claim_id=p_claim;
 RETURN true;
END $$;
CREATE FUNCTION app.b033_push_unknown(p_claim uuid,p_owner uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET lock_timeout='2s' AS $$
BEGIN
 UPDATE app.b033_push_reservations SET status='unknown',has_unknown=true,completed_at=now(),owner_token=NULL
 WHERE claim_id=p_claim AND status='dispatching' AND owner_token=p_owner;
 RETURN FOUND;
END $$;

-- Claim serialization, release, terminal fallback, Email claim and delivery records
-- are a single transaction. Failure rolls all of them back; the original deadline survives.
CREATE FUNCTION app.b033_push_fallback(p_channel uuid,p_claim uuid,p_org uuid,p_notification uuid,
 p_reason text,p_owner uuid DEFAULT NULL) RETURNS TABLE(state text,email_claim uuid,reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET lock_timeout='2s' AS $$
DECLARE r app.b033_push_reservations%ROWTYPE; f app.b033_push_fallbacks%ROWTYPE;
 v_contact uuid; v_email uuid; v_status public.delivery_status:='skipped';
BEGIN
 IF app.b028_delivery_enabled(p_org) IS NOT TRUE THEN RETURN QUERY SELECT 'fallback_unavailable',NULL::uuid,NULL::text; RETURN; END IF;
 IF app.b033_push_enabled(p_org) IS NOT TRUE THEN RETURN QUERY SELECT 'disabled',NULL::uuid,NULL::text; RETURN; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_claim::text,33));
 SELECT * INTO f FROM app.b033_push_fallbacks WHERE claim_id=p_claim;
 IF FOUND THEN
  IF ROW(f.org_id,f.notification_id,f.line_channel_id) IS DISTINCT FROM ROW(p_org,p_notification,p_channel) THEN
   RAISE EXCEPTION 'Claim scope mismatch' USING ERRCODE='22023'; END IF;
  RETURN QUERY SELECT 'skipped',f.email_claim_id,f.reason; RETURN;
 END IF;
 SELECT * INTO r FROM app.b033_push_reservations WHERE claim_id=p_claim FOR UPDATE NOWAIT;
 IF FOUND THEN
  IF ROW(r.org_id,r.notification_id,r.line_channel_id) IS DISTINCT FROM ROW(p_org,p_notification,p_channel) THEN
   RAISE EXCEPTION 'Claim scope mismatch' USING ERRCODE='22023'; END IF;
  IF r.status='settled' THEN RETURN QUERY SELECT 'accepted',NULL::uuid,NULL::text; RETURN; END IF;
  IF r.status='expired' THEN RETURN QUERY SELECT 'skipped',r.fallback_claim_id,'line_unknown_possible_duplicate'; RETURN; END IF;
  IF r.status='dispatching' AND p_owner IS NOT NULL THEN
   IF app.b033_push_release(p_claim,p_owner) IS NOT TRUE THEN RETURN QUERY SELECT 'unknown',NULL::uuid,NULL::text; RETURN; END IF;
  ELSIF r.status<>'released' THEN RETURN QUERY SELECT 'busy',NULL::uuid,NULL::text; RETURN;
  END IF;
  v_status:='failed';
 END IF;
 SELECT recipient_contact_id INTO STRICT v_contact FROM public.notifications WHERE org_id=p_org AND id=p_notification;
 v_email:=app.b028_delivery_enqueue(p_org,'line_notification',p_notification,'contact:'||v_contact::text,'email');
 INSERT INTO app.b033_push_fallbacks(claim_id,org_id,notification_id,line_channel_id,reason,email_claim_id)
 VALUES(p_claim,p_org,p_notification,p_channel,p_reason,v_email);
 INSERT INTO public.deliveries(org_id,notification_id,recipient_contact_id,line_channel_id,channel,provider,status,error,counts_toward_quota,b033_claim_id)
 VALUES(p_org,p_notification,v_contact,p_channel,'line','line_captured',v_status,p_reason,false,p_claim)
 ON CONFLICT(b033_claim_id,channel) WHERE b033_claim_id IS NOT NULL DO UPDATE SET status=excluded.status,error=excluded.error;
 INSERT INTO public.deliveries(org_id,notification_id,recipient_contact_id,channel,provider,status,error,counts_toward_quota,b033_claim_id)
 VALUES(p_org,p_notification,v_contact,'email','b028_email','queued',p_reason,false,v_email)
 ON CONFLICT(b033_claim_id,channel) WHERE b033_claim_id IS NOT NULL DO NOTHING;
 UPDATE app.b033_push_reservations SET fallback_claim_id=v_email WHERE claim_id=p_claim;
 RETURN QUERY SELECT 'skipped',v_email,p_reason;
END $$;

-- Local worker entry point: deadlines survive request/process loss. No LINE capability here.
-- Expiring uncertain attempts keeps BOTH reservations; Email is marked possible duplicate-channel.
CREATE FUNCTION app.b033_push_expire(p_org uuid) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET lock_timeout='2s' AS $$
DECLARE r app.b033_push_reservations%ROWTYPE; v_contact uuid; v_email uuid; v_count int:=0;
BEGIN
 IF app.b033_push_enabled(p_org) IS NOT TRUE THEN RETURN 0; END IF;
 FOR r IN SELECT * FROM app.b033_push_reservations WHERE org_id=p_org
  AND status IN ('reserved','dispatching','unknown') AND (notification_deadline<=now() OR retry_until<=now())
  ORDER BY notification_deadline LIMIT 25 FOR UPDATE SKIP LOCKED LOOP
  SELECT recipient_contact_id INTO v_contact FROM public.notifications WHERE id=r.notification_id AND org_id=r.org_id;
  v_email:=app.b028_delivery_enqueue(r.org_id,'line_notification',r.notification_id,'contact:'||v_contact::text,'email');
  INSERT INTO public.deliveries(org_id,notification_id,recipient_contact_id,line_channel_id,channel,provider,status,error,counts_toward_quota,b033_claim_id)
  VALUES(r.org_id,r.notification_id,v_contact,r.line_channel_id,'line','line_captured','failed','line_unknown_possible_duplicate',false,r.claim_id)
  ON CONFLICT(b033_claim_id,channel) WHERE b033_claim_id IS NOT NULL DO UPDATE SET status='failed',error=excluded.error;
  INSERT INTO public.deliveries(org_id,notification_id,recipient_contact_id,channel,provider,status,error,counts_toward_quota,b033_claim_id)
  VALUES(r.org_id,r.notification_id,v_contact,'email','b028_email','queued','line_unknown_possible_duplicate',false,v_email)
  ON CONFLICT(b033_claim_id,channel) WHERE b033_claim_id IS NOT NULL DO NOTHING;
  UPDATE app.b033_push_reservations SET status='expired',has_unknown=true,owner_token=NULL,
   completed_at=now(),fallback_claim_id=v_email WHERE claim_id=r.claim_id;
  v_count:=v_count+1;
 END LOOP;
 RETURN v_count;
END $$;
CREATE FUNCTION app.b033_quota_alert_once(p_channel uuid,p_period date) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET lock_timeout='2s' AS $$
DECLARE u public.line_push_usage%ROWTYPE;
BEGIN
 UPDATE public.line_push_usage SET alert_sent_at=now(),updated_at=now()
  WHERE line_channel_id=p_channel AND period_month=p_period AND alert_sent_at IS NULL RETURNING * INTO u;
 IF NOT FOUND THEN RETURN false; END IF;
 INSERT INTO app.b033_quota_alerts(line_channel_id,period_month,pushed_count,reserved_count)
  VALUES(p_channel,p_period,u.pushed_count,u.reserved_count);
 INSERT INTO public.audit_log(table_name,row_id,action,reason,event_type,new_row)
  VALUES('line_push_usage',p_channel::text||':'||p_period::text,'update','line_quota','line_quota',
    jsonb_build_object('line_channel_id',p_channel,'period_month',p_period,'pushed_count',u.pushed_count,'reserved_count',u.reserved_count));
 RETURN true;
END $$;
CREATE FUNCTION app.b033_webhook_record(p_channel uuid,p_event_id text,p_event_type text,p_event_ts timestamptz,
 p_identity_hash text,p_friend_state boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app SET lock_timeout='2s' AS $$
DECLARE v_identity uuid;
BEGIN
 INSERT INTO app.b033_webhook_events(line_channel_id,webhook_event_id,event_type,event_ts)
  VALUES(p_channel,p_event_id,p_event_type,p_event_ts) ON CONFLICT DO NOTHING;
 IF NOT FOUND THEN RETURN false; END IF;
 -- Webhooks never create identities, link accounts or restore revoked/unlinked identities.
 IF p_event_type IN ('follow','unfollow') AND p_friend_state IS NOT NULL THEN
  IF p_friend_state IS DISTINCT FROM (p_event_type='follow') THEN RAISE EXCEPTION 'Invalid friendship state'; END IF;
  UPDATE app.b033_line_identities SET friend_state=p_friend_state,friend_state_at=p_event_ts,
    last_event_at=greatest(last_event_at,p_event_ts)
   WHERE line_channel_id=p_channel AND provider_user_hash=p_identity_hash AND status='linked' AND unlinked_at IS NULL
    AND (friend_state_at IS NULL OR friend_state_at<p_event_ts OR (friend_state_at=p_event_ts AND NOT p_friend_state))
   RETURNING id INTO v_identity;
  IF v_identity IS NOT NULL THEN
   UPDATE public.line_account_links SET is_friend=p_friend_state,friend_event_at=p_event_ts,friend_event_id=p_event_id
    WHERE login_identity_id=v_identity AND line_channel_id=p_channel AND status='linked' AND unlinked_at IS NULL
     AND (friend_event_at IS NULL OR friend_event_at<p_event_ts OR (friend_event_at=p_event_ts AND NOT p_friend_state));
  END IF;
 END IF;
 RETURN true;
END $$;

DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='app' AND p.proname LIKE 'b033_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f);
  IF f::text NOT LIKE '%b033_link_verified_guard%' AND f::text NOT LIKE '%b033_line_audit%' AND f::text NOT LIKE '%b033_channel_verified_guard%' THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f);
  END IF;
 END LOOP;
END $$;
COMMIT;
